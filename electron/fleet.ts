import { app, dialog, safeStorage } from "electron";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
// Bundled into main.js, so local patches (which carry only the build) serve it too.
import AGENT_SRC from "../agent/agentd.mjs?raw";
import type http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import os from "node:os";
import path from "node:path";
import { priceFor } from "./direct";
import { runGit } from "./features";
import {
  ADMIN_USER, CHANNEL_BRANCH, addAgent, addDevice, addUser, applyReport, gitAddress, jobOrders, joinKey, certNames, emptyState, makeDeskCert, makeServerCert, newClientCert, opened, pubkeyPin, online, redeem, report, reportCsv, serveAgent, signed, stranded, submit, take, trimJobs, trustedCerts, usableAgents, userFor, newCode, pruneUnscanned,
  type FleetJob, type FleetState, type FleetUser,
} from "./fleetCore";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";

// The superadmin desk. Cloud agents (agent/agentd.mjs on Windows, macOS or Linux) never connect to it, and it never
// connects to them: jobs go through git. The desk writes each job, signed with its CA key, to the agent-jobs branch
// of the job channel repository; agents check that branch every 15 s with git fetch and push signed progress and
// results back (channelTick). Each agent calls the Claude API with its own key, so neither side needs an open port.
// Worker desks and phones still reach the desk over HTTPS. The desk is its own certificate authority: its TLS key
// signs the server certificate and a client certificate for every worker desk and phone, and the server completes no
// handshake without one, then drops the connection unless it belongs to a device or unused join key still trusted.

const file = () => path.join(app.getPath("userData"), "fleet.json");
const chanDir = () => path.join(app.getPath("userData"), "fleet-channel");
let state: FleetState | null = null;
let tlsPrivPem = "";
let server: https.Server | null = null;
let serverError = "";
let channelNote = "";
let channelTimer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<FleetState> {
  if (!state) state = ((await readJson(file())) as FleetState | undefined) ?? emptyState();
  if (!state.tls) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't protect the desk's key, so cloud agents can't start.");
    const made = makeDeskCert(["localhost", "127.0.0.1", os.hostname(), ...ipv4s()]);
    state.tls = { cert: made.cert, keyEnc: safeStorage.encryptString(made.pkcs8).toString("base64") };
    await save();
  }
  if (!tlsPrivPem) tlsPrivPem = safeStorage.decryptString(Buffer.from(state.tls.keyEnc, "base64"));
  // tls.cert is the desk CA: it signs every client certificate, the server certificate and every job, and never
  // changes, so what clients and agents trust stays valid. tls.server carries the addresses; a new address re-issues
  // only it, with the same key, so phone pins still match. Old names stay covered.
  const covered = state.tls.server ? certNames(state.tls.server) : [];
  const wanted = ["localhost", "127.0.0.1", os.hostname(), ...ipv4s()];
  if (!state.tls.server || wanted.some((n) => !covered.some((c) => c.toLowerCase() === n.toLowerCase()))) {
    state.tls.server = makeServerCert([...covered, ...wanted], tlsPrivPem);
    await save();
    server?.setSecureContext({ cert: state.tls.server, key: tlsPrivPem, ca: state.tls.cert });
  }
  return state;
}

function save() {
  const s = state!;
  trimJobs(s);
  return serialized(file(), () => writeJsonAtomic(file(), s));
}

// A running job whose agent sent nothing for 20 minutes is failed, so it stops counting against the user's limit.
function sweep(s: FleetState, now = Date.now()) {
  for (const j of s.jobs) {
    if (stranded(s, j)) finish(j, "failed", "No agent you may use is left to run this job.");
    if (j.status !== "running") continue;
    const a = s.agents.find((x) => x.id === j.agentId);
    if (!a || a.status !== "approved" || now - Math.max(a.lastSeen, j.startedAt ?? 0) > 20 * 60_000) finish(j, "failed", "The agent stopped answering.");
  }
}

// A cancelled job stays in the channel, marked cancelled, so its agent stops it mid-command on its next check.
function cancelJob(j: FleetJob) {
  if (j.status !== "queued" && j.status !== "running") return;
  finish(j, "cancelled");
  syncChannel();
}

function finish(j: FleetJob, status: FleetJob["status"], result?: string) {
  j.status = status;
  j.endedAt = Date.now();
  if (result !== undefined) j.result = result.slice(0, 50_000);
}

// ---- the job channel ----
// Both sides own separate folders (jobs/ is the desk's, agents/<id>/ each agent's) and rebuild them from memory on
// every tick, on top of a fresh reset to origin. A rejected push is just retried on the next tick, so no merges.
let ticking = false;
let again = false;
function syncChannel() {
  if (ticking) return void (again = true);
  ticking = true;
  channelTick()
    .then(() => (channelNote = ""), (e) => (channelNote = (e as Error).message))
    .finally(() => {
      ticking = false;
      if (again) (again = false), syncChannel();
    });
}

async function channelTick() {
  const s = await load();
  if (!s.on || !s.channel) return;
  const dir = chanDir();
  const git = async (args: string[], must = true) => {
    const r = await runGit(dir, args, 120_000);
    if (must && !r.ok) throw new Error(`Job channel: git ${args[0]} failed: ${r.output.slice(-300)}`);
    return r;
  };
  if (!existsSync(path.join(dir, ".git"))) {
    await fs.mkdir(dir, { recursive: true });
    await git(["init", "-q"]);
    await git(["remote", "add", "origin", s.channel]);
    await git(["config", "core.symlinks", "false"]);
  } else await git(["remote", "set-url", "origin", s.channel]);
  const fetched = await git(["fetch", "-q", "origin", `+refs/heads/${CHANNEL_BRANCH}:refs/remotes/origin/${CHANNEL_BRANCH}`], false);
  const hasRemote = fetched.ok && (await git(["rev-parse", "-q", "--verify", `origin/${CHANNEL_BRANCH}`], false)).ok;
  if (!fetched.ok && !/couldn't find remote ref/i.test(fetched.output)) throw new Error(`Can't reach the job channel: ${fetched.output.slice(-300)}`);
  if (hasRemote) await git(["checkout", "-qf", "-B", CHANNEL_BRANCH, `origin/${CHANNEL_BRANCH}`]);
  else await git(["symbolic-ref", "HEAD", `refs/heads/${CHANNEL_BRANCH}`]);
  await git(["clean", "-fdxq"]);

  for (const a of s.agents) {
    if (a.status !== "approved" || !a.cert) continue;
    const folder = path.join(dir, "agents", a.id);
    for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      let raw: unknown = null;
      try {
        raw = JSON.parse(await fs.readFile(path.join(folder, name), "utf8"));
      } catch {
        continue;
      }
      const d = opened(raw, a.cert);
      if (d) applyReport(s, a, d, priceFor);
    }
  }
  sweep(s);
  for (const a of s.agents) if (online(a) && !s.jobs.some((j) => j.agentId === a.id && j.status === "running")) take(s, a);
  await save();

  await fs.rm(path.join(dir, "jobs"), { recursive: true, force: true });
  // The branch must exist before any job does, so agents can post the heartbeat that makes them eligible for one.
  await fs.writeFile(path.join(dir, "README.md"), "Job channel of an AgenticOps Desk. Written by the desk and its cloud agents; don't edit.\n", "utf8");
  for (const o of jobOrders(s)) {
    const f = path.join(dir, o.path);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(signed(o.data, tlsPrivPem)), "utf8");
  }
  await git(["add", "-A"]);
  if ((await git(["diff", "--cached", "--quiet"], false)).ok) return;
  await git(["-c", "user.name=AgenticOps Desk", "-c", "user.email=desk@localhost", "commit", "-qm", "Desk jobs"]);
  const pushed = await git(["push", "-q", "origin", `HEAD:refs/heads/${CHANNEL_BRANCH}`], false);
  // Rejected = an agent pushed first; the next tick resets onto theirs and writes the same files again.
  if (!pushed.ok && !/rejected|fetch first|non-fast-forward/i.test(pushed.output)) throw new Error(`Can't push to the job channel: ${pushed.output.slice(-300)}`);
}

function startChannel() {
  if (channelTimer) clearInterval(channelTimer);
  channelTimer = setInterval(syncChannel, 15_000);
  syncChannel();
}

// ---- HTTPS server for worker desks and phones ----
const MAX_BODY = 8 * 1024 * 1024;
function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => {
      try {
        const v = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, data: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : String(data));
}

const publicJob = (j: FleetJob, s: FleetState) => ({
  id: j.id, prompt: j.prompt, repo: j.repo, model: j.model, status: j.status, createdAt: j.createdAt, endedAt: j.endedAt,
  agent: s.agents.find((a) => a.id === j.agentId)?.name, log: j.log.slice(-30), result: j.result, costUsd: j.costUsd,
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const s = await load();
  // Checked on every request too, so revoking a device also cuts a connection that is already open.
  const sock = req.socket as TLSSocket;
  const fp = sock.getPeerCertificate()?.fingerprint256 ?? "";
  if (!sock.authorized || !trustedCerts(s).has(fp)) return void sock.destroy();
  const url = new URL(req.url ?? "/", "https://x");
  const route = `${req.method} ${url.pathname}`;
  const b = req.method === "POST" ? await body(req) : {};

  if (route === "POST /user/redeem") {
    const r = redeem(s, b.code, b.device, fp);
    await save();
    return r ? send(res, 200, r) : send(res, 403, { error: "That code is wrong, already used, or revoked." });
  }
  if (url.pathname.startsWith("/user/")) {
    const user = userFor(s, req.headers.authorization, () => void save(), fp);
    if (!user) return send(res, 401, { error: "Access was revoked. Ask your admin for a new code." });
    sweep(s);
    if (route === "GET /user/me") {
      return send(res, 200, {
        name: user.name, maxAgents: user.maxAgents,
        agents: usableAgents(s, user.id).map((a) => ({ id: a.id, name: a.name, os: a.os, online: online(a) })),
        jobs: s.jobs.filter((j) => j.userId === user.id).slice(-30).reverse().map((j) => publicJob(j, s)),
      });
    }
    if (route === "POST /user/jobs") {
      const r = submit(s, user.id, { prompt: b.prompt, repo: b.repo, agentId: b.agentId, model: b.model });
      if (typeof r === "string") return send(res, 400, { error: r });
      await save();
      syncChannel();
      return send(res, 200, publicJob(r, s));
    }
    // A desktop worker pairing its phone: the phone gets its own token under that worker, so the
    // superadmin sees and can revoke it, and the phone talks to this desk directly.
    if (route === "POST /user/device") {
      if (user.paused) return send(res, 403, { error: "The superadmin has paused your access to the cloud agents." });
      const made = newClientCert(`phone of ${user.id}`, tlsPrivPem);
      const token = addDevice(user, `phone of ${user.name}`, made.certPem);
      pruneUnscanned(user);
      await save();
      return send(res, 200, { token, keyPem: made.keyPem, certPem: made.certPem });
    }
    const cancel = /^\/user\/jobs\/(\w+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && cancel) {
      const j = s.jobs.find((x) => x.id === cancel[1] && x.userId === user.id);
      if (j) cancelJob(j);
      await save();
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: "Unknown call." });
}

function start(port: number) {
  stop();
  serverError = "";
  // requestCert + rejectUnauthorized + ca: a client with no certificate, or one this desk didn't sign, fails the handshake.
  server = https.createServer({ cert: state!.tls!.server, key: tlsPrivPem, ca: state!.tls!.cert, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" }, (req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 400, { error: (e as Error).message });
    });
  });
  // Signed by this desk but revoked since: dropped before it can send a request. Prepended, so it runs before the
  // HTTP server's own listener; otherwise a request in the same packet as the handshake gets parsed first.
  server.prependListener("secureConnection", (sock: TLSSocket) => {
    if (!state || !trustedCerts(state).has(sock.getPeerCertificate()?.fingerprint256 ?? "")) sock.destroy();
  });
  server.on("error", (e) => {
    serverError = `Could not listen on port ${port}: ${(e as Error).message}`;
    server = null;
  });
  server.listen(port, "0.0.0.0");
  startChannel();
}

function stop() {
  server?.close();
  server?.closeAllConnections();
  server = null;
  if (channelTimer) clearInterval(channelTimer);
  channelTimer = null;
}

export async function startFleetOnLaunch() {
  const s = await load();
  if (s.on) start(s.port);
}

function ipv4s() {
  const real: string[] = [], virtual: string[] = [];
  // The first address goes into the phone's QR, so the LAN one must come before WSL/Hyper-V/Docker/VM adapters.
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const n of list ?? [])
      if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254.")) (/vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|vboxnet|docker|br-|virbr/.test(name) ? virtual : real).push(n.address);
  return [...real, ...virtual];
}

function addresses(port: number) {
  const ips = ipv4s();
  return (ips.length ? ips : ["localhost"]).map((ip) => `https://${ip}:${port}`);
}

// What the Settings page shows. Token hashes and agent keys never leave the main process.
export async function fleetState() {
  const s = await load();
  sweep(s);
  return {
    adminId: s.adminId, createdAt: s.createdAt, on: s.on, port: s.port, maxAgents: s.maxAgents, listening: !!server?.listening, error: serverError,
    channel: s.channel ?? "", channelError: channelNote,
    urls: addresses(s.port), tlsFingerprint: new X509Certificate(s.tls!.cert).fingerprint256,
    // oldFile: added before agents used the job channel. Its file can't read jobs; remove it and add it again.
    agents: s.agents.filter((a) => a.status !== "revoked").map((a) => ({ id: a.id, name: a.name, os: a.os, status: a.status, online: online(a), lastSeen: a.lastSeen, createdAt: a.createdAt, oldFile: !a.cert || !!a.pub })),
    users: await Promise.all(s.users.filter((u) => !u.revoked).map(async (u: FleetUser) => ({ id: u.id, name: u.name, maxAgents: u.maxAgents, agentIds: u.agentIds, code: u.code, paused: !!u.paused,
      joinKey: u.code ? await userJoinKey(s, u) : undefined, redeemed: !!u.tokenHash || !!u.devices?.length, devices: [...(u.devices ?? []).map((d) => ({ id: d.id, name: d.name, noCert: !d.cert })), ...(u.tokenHash ? [{ id: "legacy", name: "earlier device", noCert: true }] : [])], createdAt: u.createdAt }))),
    // The superadmin only gates AI access: workers' prompts and results stay off this page; their use shows in the report.
    jobs: s.jobs.filter((j) => j.userId === ADMIN_USER).slice(-100).reverse().map((j) => publicJob(j, s)),
  };
}

export async function fleetSetup(patch: { on?: boolean; port?: number; maxAgents?: number; channel?: string }) {
  const s = await load();
  if (typeof patch.port === "number" && patch.port >= 1024 && patch.port <= 65535) s.port = Math.floor(patch.port);
  if (typeof patch.maxAgents === "number" && patch.maxAgents >= 0) s.maxAgents = Math.floor(patch.maxAgents);
  if (typeof patch.on === "boolean") s.on = patch.on;
  if (typeof patch.channel === "string") {
    const c = patch.channel.trim();
    if (c && !gitAddress(c)) channelNote = "The job channel must be an https or ssh git address.";
    // Agents carry the address in their file, so a change means adding them again.
    else s.channel = c || undefined;
  }
  await save();
  if (s.on) start(s.port);
  else stop();
  await new Promise((r) => setTimeout(r, 200)); // let listen() report a busy port before the page reads the state
  return fleetState();
}

// Adds an agent: the desk makes its signing key and certificate and saves them, with the job channel address and the
// agent's own API key, inside the agent script as one file the superadmin copies to the agent's computer. The desk
// keeps only the certificate. null = cancelled.
export async function fleetAddAgent(name: string, apiKey: string): Promise<{ path?: string; error?: string } | null> {
  const s = await load();
  const out = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), `agentd-${name.trim().replace(/[^\w.-]+/g, "-") || "agent"}.mjs`), filters: [{ name: "Agent", extensions: ["mjs"] }] });
  if (out.canceled || !out.filePath) return null;
  const bundle = addAgent(s, name, apiKey, tlsPrivPem);
  if (typeof bundle === "string") return { error: bundle };
  await fs.writeFile(out.filePath, serveAgent(AGENT_SRC, bundle), { encoding: "utf8", mode: 0o600 });
  await save();
  return { path: out.filePath };
}

// The join key for a user's unused code, with the client certificate the worker desk must connect with.
async function userJoinKey(s: FleetState, u: FleetUser) {
  if (!u.enrolCert || !u.enrolKeyEnc) {
    const made = newClientCert(`user ${u.id}`, tlsPrivPem);
    u.enrolCert = made.certPem;
    u.enrolKeyEnc = safeStorage.encryptString(made.keyPem).toString("base64");
    await save();
  }
  return joinKey(addresses(s.port)[0], pubkeyPin(s.tls!.cert), u.code!, safeStorage.decryptString(Buffer.from(u.enrolKeyEnc!, "base64")), u.enrolCert!, s.tls!.cert);
}

// The desk stops trusting the agent's signature at once. Its API key lives on the agent, so the superadmin revokes
// that in the Claude Console.
export async function fleetRemoveAgent(id: string) {
  const s = await load();
  const a = s.agents.find((x) => x.id === id);
  if (a) {
    a.status = "revoked";
    for (const j of s.jobs) if (j.agentId === id && j.status === "running") finish(j, "failed", "The superadmin removed this agent.");
  }
  await save();
  syncChannel();
}

export async function fleetAddUser(name: string, maxAgents: number, agentIds: string[]) {
  const s = await load();
  const u = addUser(s, name, maxAgents, Array.isArray(agentIds) ? agentIds.map(String) : []);
  return userJoinKey(s, u);
}

// The phone pairing QR carries a ready cloud login, so the phone never types a desk address or access code.
// One "Your phone" user (all agents); each pairing adds a device token to it. Nothing when cloud agents are off.
// pin = the desk's public-key pin; the phone trusts only that key, so no certificate is installed on it.
export async function fleetPhoneLogin(): Promise<{ url: string; token: string; pin: string; keyPem: string; certPem: string } | undefined> {
  const s = await load();
  if (!s.on || !server?.listening) return undefined;
  const u = s.users.find((x) => x.name === "Your phone" && !x.revoked) ?? addUser(s, "Your phone", s.maxAgents, []);
  u.code = undefined;
  const made = newClientCert(`phone of ${u.id}`, tlsPrivPem);
  const token = addDevice(u, "phone (paired from the desk)", made.certPem);
  pruneUnscanned(u);
  await save();
  return { url: addresses(s.port)[0], token, pin: pubkeyPin(s.tls!.cert), keyPem: made.keyPem, certPem: made.certPem };
}

export async function fleetUpdateUser(id: string, patch: { maxAgents?: number; agentIds?: string[]; revoke?: boolean; newCode?: boolean; revokeDevice?: string; signOutAll?: boolean; paused?: boolean }) {
  const s = await load();
  const u = s.users.find((x) => x.id === id);
  if (!u) return;
  if (typeof patch.paused === "boolean") {
    u.paused = patch.paused;
    if (u.paused) for (const j of s.jobs) if (j.userId === id) cancelJob(j);
  }
  if (typeof patch.maxAgents === "number" && patch.maxAgents >= 0) u.maxAgents = Math.floor(patch.maxAgents);
  if (Array.isArray(patch.agentIds)) u.agentIds = patch.agentIds.map(String);
  if (patch.revoke) {
    u.revoked = true;
    u.tokenHash = undefined;
    u.devices = [];
    for (const j of s.jobs) if (j.userId === id) cancelJob(j);
  }
  // A new code is for one more device; the devices already signed in stay.
  if (patch.newCode) (u.code = newCode()), (u.enrolCert = u.enrolKeyEnc = undefined);
  if (patch.revokeDevice) {
    u.devices = (u.devices ?? []).filter((d) => d.id !== patch.revokeDevice);
    if (!u.devices.length) u.tokenHash = undefined;
  }
  if (patch.signOutAll) u.devices = [], u.tokenHash = undefined;
  await save();
}

// Also the manager's submit_work cloud path (pool.ts cloudSubmit): the job goes to git on the next channel tick, now.
export async function fleetSubmit(input: { prompt: string; repo?: string; agentId?: string; model?: string }) {
  const s = await load();
  const r = submit(s, ADMIN_USER, input);
  if (typeof r === "string") return r;
  await save();
  syncChannel();
  return null;
}

export async function fleetCancel(id: string) {
  const s = await load();
  const j = s.jobs.find((x) => x.id === id);
  if (j) cancelJob(j);
  await save();
}

const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()] as const;
};

export async function fleetReport(month: string) {
  const s = await load();
  return report(s, ...monthRange(month));
}

export async function fleetExportCsv(month: string) {
  const s = await load();
  const out = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), `cloud-agents-${month}.csv`), filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (out.canceled || !out.filePath) return null;
  await fs.writeFile(out.filePath, reportCsv(report(s, ...monthRange(month))), "utf8");
  return out.filePath;
}
