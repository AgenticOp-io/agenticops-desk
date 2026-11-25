import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { newKeyPair, pairCode } from "../agent/wire.mjs";
import { ADMIN_USER, addUser, approve, certNames, createDesktopSetup, emptyState, getDesktopApiKeyEnc, makeDeskCert, pair, pubkeyPin, redeem, registerDesktop, report, serveAgent, submit, take, userFor } from "./fleetCore.ts";

const A = newKeyPair().pub;
const B = newKeyPair().pub;

test("an agent pairs only after the admin types the code made from its key", () => {
  const s = emptyState();
  s.deskPub = "desk-key";
  assert.equal(pair(s, { pub: "not a key", name: "", os: "" }).status, "invalid");
  assert.equal(pair(s, { pub: A, name: "box", os: "linux" }).status, "pending");
  assert.ok(approve(s, "WRONG-CODE"));
  assert.equal(approve(s, pairCode(A).toLowerCase().replace("-", "")), null);
  assert.equal(pair(s, { pub: B, name: "", os: "" }).status, "pending"); // another key gets its own entry, not A's approval
  assert.deepEqual(pair(s, { pub: A, name: "", os: "" }), { status: "approved", agentId: s.agents[0].id, desk: "desk-key" });
});

test("the agent limit blocks pairing past it", () => {
  const s = emptyState();
  s.maxAgents = 1;
  pair(s, { pub: A, name: "a", os: "" });
  pair(s, { pub: B, name: "b", os: "" });
  assert.equal(approve(s, pairCode(A)), null);
  assert.match(approve(s, pairCode(B)) ?? "", /allows 1/);
});

test("the desk certificate parses, names its addresses, and only it passes the agent's pin", async () => {
  const made = makeDeskCert(["localhost", "127.0.0.1", "10.1.2.3"]);
  const x = new X509Certificate(made.cert);
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkIP("10.1.2.3") && x.checkHost("localhost") && x.ca);
  assert.equal(pubkeyPin(made.cert).length, 44);
  // A re-issue for a new address keeps the key, so the pin agents carry still matches.
  const again = makeDeskCert([...certNames(made.cert), "10.9.9.9"], new Date(), made.pkcs8);
  assert.equal(pubkeyPin(again.cert), pubkeyPin(made.cert));
  assert.ok(new X509Certificate(again.cert).checkIP("10.9.9.9") && new X509Certificate(again.cert).checkIP("10.1.2.3"));
  const server = https.createServer({ cert: made.cert, key: made.pkcs8 }, (_q, r) => r.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const get = (cert: string, scheme = https) => new Promise<string>((ok, bad) => {
    const fp = new X509Certificate(cert).fingerprint256;
    scheme.get(`${scheme === https ? "https" : "http"}://127.0.0.1:${port}/`, { ca: cert, checkServerIdentity: (_h: string, c: { fingerprint256: string }) => (c.fingerprint256 === fp ? undefined : new Error("pin")) } as https.RequestOptions, (r) => {
      let t = "";
      r.on("data", (d) => (t += d)).on("end", () => ok(t));
    }).on("error", bad);
  });
  try {
    assert.equal(await get(made.cert), "ok");
    await assert.rejects(get(makeDeskCert(["127.0.0.1"]).cert)); // another desk's certificate
    await assert.rejects(get(made.cert, http as unknown as typeof https)); // plain HTTP gets no answer
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the served agent script is one file that parses", () => {
  const src = serveAgent(readFileSync("agent/agentd.mjs", "utf8"), readFileSync("agent/wire.mjs", "utf8"), "CERT");
  assert.doesNotMatch(src, /wire\.mjs"/);
  assert.match(src, /const DESK_CERT = "CERT";/);
  const f = path.join(os.tmpdir(), `agentd-${process.pid}.mjs`);
  writeFileSync(f, src);
  execFileSync(process.execPath, ["--check", f]);
});

test("user codes are one-time, limits and allowed agents hold, and the report adds up", () => {
  const s = emptyState();
  pair(s, { pub: A, name: "a", os: "" });
  pair(s, { pub: B, name: "b", os: "" });
  approve(s, pairCode(A));
  approve(s, pairCode(B));
  const [a, b] = s.agents;
  const u = addUser(s, "Ann", 1, [b.id]);
  const r = redeem(s, u.code);
  assert.ok(r);
  assert.equal(redeem(s, r.token), null);
  assert.equal(userFor(s, `Bearer ${r.token}`)?.id, u.id);
  assert.match(String(submit(s, u.id, { prompt: "x", agentId: a.id })), /can't use/);
  assert.match(String(submit(s, u.id, { prompt: "x", repo: "https://x/y; rm -rf /" })), /git address/);
  const job = submit(s, u.id, { prompt: "fix it" });
  assert.equal(typeof job, "object");
  assert.match(String(submit(s, u.id, { prompt: "more" })), /1 cloud agent at a time/);
  assert.equal(take(s, a), undefined); // Ann may not use agent a
  const got = take(s, b)!;
  Object.assign(got, { status: "done", input: 100, output: 50, costUsd: 0.5, endedAt: got.startedAt! + 120_000 });
  assert.equal(typeof submit(s, ADMIN_USER, { prompt: "admin job" }), "object");
  const rows = report(s, 0, Date.now() + 1);
  const ann = rows.find((x) => x.kind === "user" && x.id === u.id)!;
  assert.deepEqual([ann.jobs, ann.input, ann.output, ann.costUsd, ann.minutes], [1, 100, 50, 0.5, 2]);
  assert.equal(rows.find((x) => x.kind === "agent" && x.id === b.id)?.jobs, 1);
});

test("each device that redeems gets its own token, and one can be cut off alone", () => {
  const s = emptyState();
  const u = addUser(s, "Ann", 1, []);
  const a = redeem(s, u.code, "phone")!;
  u.code = "ZZZZ-ZZZZ";
  const b = redeem(s, u.code, "laptop")!;
  assert.ok(userFor(s, `Bearer ${a.token}`) && userFor(s, `Bearer ${b.token}`));
  u.devices = u.devices!.filter((d) => d.name !== "phone");
  assert.equal(userFor(s, `Bearer ${a.token}`), undefined);
  assert.ok(userFor(s, `Bearer ${b.token}`));
});

test("desktop setup: one-time code, registration with API key, and retrieval", () => {
  const s = emptyState();

  // Initial setup generates a code
  const { setupCode, setupCodeHash } = createDesktopSetup();
  assert.match(setupCode, /^[A-Z0-9]+-[A-Z0-9]+/); // Two newCode() calls joined
  assert.equal(typeof setupCodeHash, "string");
  assert.ok(setupCodeHash.length > 0);

  // Create registration entry
  s.desktop = { id: "test-id", setupCode, setupCodeHash, apiKeyEnc: "", createdAt: Date.now() };

  // Registration with wrong hash fails
  assert.equal(registerDesktop(s, "wrong-hash", "sk-..."), false);

  // Registration with right hash succeeds
  const apiKey = "sk-ant-test-key-12345";
  assert.equal(registerDesktop(s, setupCodeHash, apiKey), true);
  assert.ok(s.desktop.registeredAt);

  // Can retrieve the key
  assert.equal(getDesktopApiKeyEnc(s), apiKey);

  // Can't register twice
  assert.equal(registerDesktop(s, setupCodeHash, "sk-new-key"), false);
});
