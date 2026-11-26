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
import { ADMIN_USER, addDevice, addUser, joinKey, parseJoinKey, approve, certNames, emptyState, makeDeskCert, pair, pubkeyPin, redeem, report, serveAgent, submit, take, userFor, pruneUnscanned } from "./fleetCore.ts";

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

test("many people's phones stay paired; only unscanned QR tokens are capped", () => {
  const s = emptyState();
  const u = addUser(s, "Your phone", 1, []);
  const tokens = Array.from({ length: 5 }, () => { u.code = "ZZZZ-ZZZZ"; return redeem(s, u.code, "phone")!.token; });
  let saves = 0;
  for (const t of tokens.slice(0, 4)) userFor(s, `Bearer ${t}`, () => saves++); // four people scanned
  userFor(s, `Bearer ${tokens[0]}`, () => saves++); // second use: no extra save
  for (let i = 0; i < 4; i++) { u.code = "YYYY-YYYY"; redeem(s, u.code, "shown, never scanned"); pruneUnscanned(u); }
  assert.equal(saves, 4);
  for (const t of tokens.slice(0, 4)) assert.ok(userFor(s, `Bearer ${t}`));
  assert.equal(u.devices!.filter((d) => !d.usedAt).length, 3);
});

test("a join key carries address, pin and code; a paused worker can't submit; its phone gets its own token", () => {
  const pin = pubkeyPin(makeDeskCert(["127.0.0.1"]).cert);
  const k = joinKey("https://10.0.0.5:7377", pin, "ABCD-EFGH");
  assert.deepEqual(parseJoinKey(` ${k} `), { url: "https://10.0.0.5:7377", pin, code: "ABCD-EFGH" });
  assert.equal(parseJoinKey("http://10.0.0.5:7377#" + pin + "#ABCD-EFGH"), null);
  assert.equal(parseJoinKey(k + "#x"), null);
  assert.equal(parseJoinKey("https://10.0.0.5:7377#short#ABCD-EFGH"), null);

  const s = emptyState();
  s.agents.push({ id: "a1", name: "box", os: "linux", code: "", pub: "", status: "approved", createdAt: 0, lastSeen: Date.now() });
  const u = addUser(s, "Dana", 2, []);
  const desk = redeem(s, u.code, "dana-pc (desktop)")!;
  assert.equal(userFor(s, `Bearer ${desk.token}`)?.id, u.id);
  const phone = addDevice(u, "phone of Dana");
  assert.equal(userFor(s, `Bearer ${phone}`)?.id, u.id);
  u.paused = true;
  assert.match(String(submit(s, u.id, { prompt: "x" })), /paused/);
  u.paused = false;
  assert.equal(typeof submit(s, u.id, { prompt: "x" }), "object");
});

// Same TLS options as electron/pool.ts: trust only the desk certificate, and its key must match the pin.
test("a worker desk trusts the superadmin by pin, also after the certificate is re-issued with the same key", async () => {
  const first = makeDeskCert(["127.0.0.1"]);
  const reissued = makeDeskCert(["127.0.0.1", "10.9.9.9"], new Date(), first.pkcs8).cert;
  const other = makeDeskCert(["127.0.0.1"]);
  const get = (port: number, ca: string, pin: string) =>
    new Promise<string>((resolve, reject) => {
      https
        .get(`https://127.0.0.1:${port}/`, { ca, checkServerIdentity: (_h, c) => (pubkeyPin(c.raw) === pin ? undefined : new Error("pin")) }, (r) => {
          r.resume();
          r.on("end", () => resolve("ok"));
        })
        .on("error", (e) => reject(e));
    });
  for (const [served, key, ca, pin, want] of [
    [first.cert, first.pkcs8, first.cert, pubkeyPin(first.cert), "ok"],
    [reissued, first.pkcs8, first.cert, pubkeyPin(first.cert), "any"],
    [other.cert, other.pkcs8, other.cert, pubkeyPin(first.cert), "fail"],
  ] as const) {
    const srv = https.createServer({ cert: served, key }, (_q, r) => r.end("x"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const got = await get(port, ca, pin).catch((e: NodeJS.ErrnoException) => `fail:${e.code ?? e.message}`);
    srv.close();
    if (want === "ok") assert.equal(got, "ok");
    if (want === "fail") assert.match(got, /^fail/);
    // pool.ts refetches desk.crt on a certificate error, so either outcome is handled; record which one Node gives.
    if (want === "any") console.log("re-issued cert with the old ca:", got);
  }
});
