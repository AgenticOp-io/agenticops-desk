import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { ADMIN_USER, CHANNEL_BRANCH, addAgent, addDevice, addUser, applyReport, jobOrders, joinKey, parseJoinKey, certNames, emptyState, fpOf, makeDeskCert, makeServerCert, newClientCert, online, opened, pubkeyPin, redeem, report, serveAgent, signed, submit, take, trustedCerts, userFor, pruneUnscanned, type FleetState } from "./fleetCore.ts";

// A desk state with its CA and a job channel, as fleet.ts load() and Settings make it.
function deskState() {
  const s = emptyState();
  const ca = makeDeskCert(["127.0.0.1"]);
  s.tls = { cert: ca.cert, keyEnc: "", server: makeServerCert(["127.0.0.1"], ca.pkcs8) };
  s.channel = "git@example.com:me/desk-jobs.git";
  return { s, key: ca.pkcs8 };
}
const KEY = "sk-test-0123456789abcdefghij";
const agent = (s: FleetState, key: string, name: string) => {
  const b = addAgent(s, name, KEY, key);
  assert.equal(typeof b, "object");
  return b as Exclude<typeof b, string>;
};
const PRICE = () => ({ input: 2, read: 0.2, output: 10 });

test("the desk makes each agent's signing key and certificate, and keeps neither the key nor the API key", () => {
  const { s, key } = deskState();
  s.maxAgents = 1;
  assert.match(String(addAgent(s, "x", "short", key)), /API key/);
  const b = agent(s, key, "box");
  assert.match(String(addAgent(s, "two", KEY, key)), /allows 1/);
  const c = new X509Certificate(b.cert);
  assert.ok(c.verify(new X509Certificate(s.tls!.cert).publicKey) && !c.ca);
  assert.equal(b.deskCert, s.tls!.cert);
  assert.equal(b.channel, s.channel);
  assert.ok(!JSON.stringify(s).includes(b.signKey) && !JSON.stringify(s).includes(KEY));
  assert.equal(trustedCerts(s).size, 0); // agents never connect to the desk's server
  const none = emptyState();
  none.tls = s.tls;
  assert.match(String(addAgent(none, "x", KEY, key)), /job channel/);
});

test("channel files: only the right signature opens them, and results count only for the agent's running job", () => {
  const { s, key } = deskState();
  const b = agent(s, key, "box");
  const a = s.agents[0];
  const f = signed({ agentId: a.id, kind: "alive", at: 5, os: "linux x64" }, b.signKey);
  assert.deepEqual(opened(JSON.parse(JSON.stringify(f)), a.cert!), f.data);
  assert.equal(opened(f, s.tls!.cert), null); // the desk's key didn't sign it
  assert.equal(opened({ ...f, data: { ...f.data, at: 6 } }, a.cert!), null); // tampered
  assert.equal(opened(signed(f.data, newClientCert("x", key).keyPem), a.cert!), null); // another key the desk signed
  applyReport(s, a, f.data, PRICE, 1000);
  assert.ok(online(a, 1000) && a.os === "linux x64");
  applyReport(s, a, { ...f.data, at: 4 }, PRICE, 99_999_999); // an older heartbeat replayed: no effect
  assert.equal(a.lastSeen, 1000);

  const job = submit(s, ADMIN_USER, { prompt: "go" });
  assert.ok(typeof job === "object");
  assert.deepEqual(jobOrders(s), []); // queued, not yet given to an agent
  take(s, a);
  const [o] = jobOrders(s);
  assert.equal(o.path, `jobs/${a.id}/${job.id}.json`);
  assert.equal(o.data.cancelled, false);
  applyReport(s, a, { agentId: "other", kind: "result", jobId: job.id, status: "done" }, PRICE);
  assert.equal(job.status, "running");
  applyReport(s, a, { agentId: a.id, kind: "result", jobId: job.id, status: "done", result: "ok", log: ["a"], usage: { input: 1e6, output: 1e6 } }, PRICE);
  assert.deepEqual([job.status, job.result, job.input, job.costUsd], ["done", "ok", 1e6, 12]);
  applyReport(s, a, { agentId: a.id, kind: "result", jobId: job.id, status: "failed" }, PRICE); // finished stays finished
  assert.equal(job.status, "done");
});

test("the agent file is one script that parses, with its bundle built in", () => {
  const { s, key } = deskState();
  const b = agent(s, key, "box");
  const src = serveAgent(readFileSync("agent/agentd.mjs", "utf8"), b);
  assert.ok(src.includes(`const BUNDLE = ${JSON.stringify(b)};`));
  const f = path.join(os.tmpdir(), `agentd-${process.pid}.mjs`);
  writeFileSync(f, src);
  execFileSync(process.execPath, ["--check", f]);
});

// The real agent file, run as a process, against a local bare repository as the job channel. The desk side is done
// as fleet.ts channelTick does it: signed job files under jobs/<agentId>/ on the agent-jobs branch.
test("the agent reads only desk-signed jobs from git and pushes signed results back", async () => {
  const { s, key } = deskState();
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-chan-"));
  const bare = path.join(root, "chan.git");
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g(root, "init", "-q", "--bare", bare);
  s.channel = bare;
  const b = agent(s, key, "box");
  const a = s.agents[0];
  a.lastSeen = Date.now();
  const job = submit(s, ADMIN_USER, { prompt: "say hi" });
  assert.ok(typeof job === "object");
  take(s, a);
  const forged = { agentId: a.id, id: "forged1", prompt: "rm -rf /", repo: null, model: "x", cancelled: false };

  const desk = path.join(root, "desk");
  g(root, "clone", "-q", bare, desk);
  g(desk, "checkout", "-q", "-b", CHANNEL_BRANCH);
  mkdirSync(path.join(desk, "jobs", a.id), { recursive: true });
  for (const o of jobOrders(s)) writeFileSync(path.join(desk, o.path), JSON.stringify(signed(o.data, key)));
  writeFileSync(path.join(desk, "jobs", a.id, "forged1.json"), JSON.stringify(signed(forged, newClientCert("x", key).keyPem)));
  g(desk, "add", "-A");
  g(desk, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "jobs");
  g(desk, "push", "-q", "origin", CHANNEL_BRANCH);

  const f = path.join(root, "agentd.mjs");
  writeFileSync(f, serveAgent(readFileSync("agent/agentd.mjs", "utf8"), b));
  const child = spawn(process.execPath, [f], { env: { ...process.env, AGENTICOPS_AGENT_HOME: path.join(root, "home"), AGENTICOPS_AGENT_POLL_MS: "300", AGENTICOPS_AGENT_API: "http://127.0.0.1:1" } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    // The model address answers nothing, so the job fails; what matters is that its result comes back through git.
    for (let i = 0; i < 100 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        g(desk, "pull", "-q", "origin", CHANNEL_BRANCH);
      } catch {
        continue;
      }
      const folder = path.join(desk, "agents", a.id);
      if (!existsSync(folder)) continue; // the agent hasn't pushed yet
      for (const n of readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)) {
        const d = opened(JSON.parse(readFileSync(path.join(folder, n), "utf8")), a.cert!);
        if (d) applyReport(s, a, d, PRICE);
      }
    }
    assert.equal(job.status, "failed", out);
    assert.ok(a.aliveAt && a.os, "heartbeat");
    assert.match(out, /Job \w+: say hi/);
    assert.doesNotMatch(out, /forged1|rm -rf/);
    assert.ok(!readdirSync(path.join(desk, "agents", a.id)).includes("forged1.json"));
  } finally {
    child.kill();
  }
});

// The same TLS settings as fleet.ts start() and pool.ts request(): nothing connects without a client certificate the
// desk signed for a live device, across a server re-issue for a new address.
test("mutual TLS: only devices' certificates the desk signed connect, across a server re-issue", async () => {
  const { s, key } = deskState();
  const u = addUser(s, "Wes", 1, []);
  const dev = newClientCert("phone", key);
  addDevice(u, "phone", dev.certPem);
  const reissued = makeServerCert(["127.0.0.1", "10.9.9.9"], key);
  // Checked at the handshake and on every request, as fleet.ts does, so a revoke also cuts an open keep-alive connection.
  const trusted = (sock: import("node:tls").TLSSocket) => trustedCerts(s).has(sock.getPeerCertificate()?.fingerprint256 ?? "");
  const srv = https.createServer({ cert: reissued, key, ca: s.tls!.cert, requestCert: true, rejectUnauthorized: true }, (q, r) => (trusted(q.socket as import("node:tls").TLSSocket) ? r.end("ok") : q.socket.destroy()));
  srv.prependListener("secureConnection", (sock) => !trusted(sock) && sock.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const pin = pubkeyPin(s.tls!.cert);
  const get = (o: https.RequestOptions, scheme = https) =>
    new Promise<string>((ok) =>
      scheme
        .get(`${scheme === https ? "https" : "http"}://127.0.0.1:${port}/`, { ca: s.tls!.cert, minVersion: "TLSv1.3", checkServerIdentity: (_h: string, c: { raw: Buffer }) => (pubkeyPin(c.raw) === pin ? undefined : new Error("pin")), ...o } as https.RequestOptions, (r) => {
          let t = "";
          r.on("data", (d) => (t += d)).on("end", () => ok(t));
        })
        .on("error", (e: NodeJS.ErrnoException) => ok(`fail:${e.code ?? e.message}`)),
    );
  const other = newClientCert("agent z", makeDeskCert(["127.0.0.1"]).pkcs8);
  const signedNotListed = newClientCert("agent q", key); // signed by this desk, but no device has it
  try {
    assert.equal(await get({ key: dev.keyPem, cert: dev.certPem }), "ok");
    assert.match(await get({}), /^fail/);
    assert.match(await get({ key: other.keyPem, cert: other.certPem }), /^fail/);
    assert.match(await get({ key: signedNotListed.keyPem, cert: signedNotListed.certPem }), /^fail/);
    assert.match(await get({ key: dev.keyPem, cert: dev.certPem, ca: makeDeskCert(["127.0.0.1"]).cert }), /^fail/); // a desk it doesn't know
    assert.match(await get({}, http as unknown as typeof https), /^fail/); // plain HTTP gets no answer
    u.devices = [];
    assert.match(await get({ key: dev.keyPem, cert: dev.certPem }), /^fail/);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("the desk certificate parses, names its addresses, and keeps its key across a re-issue", () => {
  const made = makeDeskCert(["localhost", "127.0.0.1", "10.1.2.3"]);
  const x = new X509Certificate(made.cert);
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkIP("10.1.2.3") && x.checkHost("localhost") && x.ca);
  assert.equal(pubkeyPin(made.cert).length, 44);
  const again = makeDeskCert([...certNames(made.cert), "10.9.9.9"], new Date(), made.pkcs8);
  assert.equal(pubkeyPin(again.cert), pubkeyPin(made.cert));
  assert.ok(new X509Certificate(again.cert).checkIP("10.9.9.9") && new X509Certificate(again.cert).checkIP("10.1.2.3"));
});

test("user codes are one-time, limits and allowed agents hold, and the report adds up", () => {
  const { s, key } = deskState();
  agent(s, key, "a");
  agent(s, key, "b");
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

test("a join key carries address, pin, code, client certificate and CA; the token works only with its certificate", () => {
  const { s: d, key } = deskState();
  const pin = pubkeyPin(d.tls!.cert);
  const c = newClientCert("user u", key);
  const k = joinKey("https://10.0.0.5:7377", pin, "ABCD-EFGH", c.keyPem, c.certPem, d.tls!.cert);
  assert.deepEqual(parseJoinKey(` ${k} `), { url: "https://10.0.0.5:7377", pin, code: "ABCD-EFGH", keyPem: c.keyPem, certPem: c.certPem, caPem: d.tls!.cert });
  assert.equal(parseJoinKey(k.replace("https:", "http:")), null);
  assert.equal(parseJoinKey(k + "#x"), null);
  assert.equal(parseJoinKey("https://10.0.0.5:7377#" + pin + "#ABCD-EFGH"), null); // an old join key, without a certificate
  // Redeeming needs the user's join certificate on the connection; the token then belongs to that certificate.
  const w = addUser(d, "Wes", 1, []);
  w.enrolCert = c.certPem;
  assert.equal(redeem(d, w.code, "pc", fpOf(newClientCert("x", key).certPem)), null);
  assert.ok(trustedCerts(d).has(fpOf(c.certPem)));
  const t = redeem(d, w.code, "pc", fpOf(c.certPem))!;
  assert.equal(userFor(d, `Bearer ${t.token}`, undefined, fpOf(c.certPem))?.id, w.id);
  assert.equal(userFor(d, `Bearer ${t.token}`, undefined, fpOf(newClientCert("y", key).certPem)), undefined);
  w.devices = [];
  assert.ok(!trustedCerts(d).has(fpOf(c.certPem))); // removing the device drops its certificate too

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

test("stranded jobs are found, and trimming keeps live jobs", async () => {
  const { stranded, trimJobs } = await import("./fleetCore.ts");
  const { s, key } = deskState();
  agent(s, key, "real");
  const u = addUser(s, "w", 1, [s.agents[0].id]);
  const j = submit(s, u.id, { prompt: "go" });
  assert.ok(typeof j !== "string");
  assert.equal(stranded(s, j), false);
  s.agents[0].status = "revoked";
  assert.equal(stranded(s, j), true);

  s.jobs = Array.from({ length: 5 }, (_, i) => ({ ...j, id: String(i), status: i === 0 ? "running" : "done" }) as typeof j);
  trimJobs(s, 3);
  assert.deepEqual(s.jobs.map((x) => x.id), ["0", "3", "4"]);
});
