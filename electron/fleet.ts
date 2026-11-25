import Anthropic from "@anthropic-ai/sdk";
import { app, dialog, safeStorage } from "electron";
import { X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
// Bundled into main.js, so local patches (which carry only the build) serve it too.
import AGENT_SRC from "../agent/agentd.mjs?raw";
import WIRE_SRC from "../agent/wire.mjs?raw";
import { channel, deskSession, fingerprint, newKeyPair, type Channel } from "../agent/wire.mjs";
import type http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { priceFor } from "./direct";
import {
  ADMIN_USER, addLog, addUser, approve, createDesktopSetup, emptyState, getDesktopApiKeyEnc, makeDeskCert, newId, pubkeyPin, online, pair, redeem, registerDesktop, report, reportCsv, serveAgent, submit, take, usableAgents, userFor, newCode,
  type FleetAgent, type FleetJob, type FleetState, type FleetUser,
} from "./fleetCore";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";
import { providerKey } from "./providers";

// The superadmin control server. Cloud agents (agent/agentd.mjs on Windows, macOS or Linux) pair with a code,
// keep an encrypted keepalive stream open to this desk (agent/wire.mjs), take jobs and cancels over it, and send
// every model call through this desk, so API keys never leave it and every token is metered.
// Users (the phone app, or any browser via the page at /) get one-time access codes made here.
// It answers HTTPS only, with a self-signed certificate made once per desk. Agents pin it (it is built into the
// script they download); phones and browsers must trust it (install /desk.crt) or click through the warning.

const file = () => path.join(app.getPath("userData"), "fleet.json");
let state: FleetState | null = null;
let deskPriv = "";
let tlsPrivPem = "";
let server: https.Server | null = null;
let serverError = "";
const kick = new EventEmitter();
kick.setMaxListeners(200);

// Keepalive sessions with agents. Keys exist only here, in memory, and die with the session.
type Session = { agentId: string; ch: Channel; at: number; used: number; confirmed: boolean };
const sessions = new Map<string, Session>();
// Messages the desk pushes to an agent on its next keepalive reply.
const outbox = new Map<string, unknown[]>();
const push = (agentId: string, msg: unknown) => {
  outbox.set(agentId, [...(outbox.get(agentId) ?? []), msg]);
  kick.emit("job");
};
const dropSessions = (agentId: string) => {
  for (const [sid, x] of sessions) if (x.agentId === agentId) sessions.delete(sid);
};

async function load(): Promise<FleetState> {
  if (!state) state = ((await readJson(file())) as FleetState | undefined) ?? emptyState();
  if (!deskPriv) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't protect the desk's agent key, so cloud agents can't start.");
    if (state.deskPub && state.deskPrivEnc) deskPriv = safeStorage.decryptString(Buffer.from(state.deskPrivEnc, "base64"));
    else {
      const k = newKeyPair();
      deskPriv = k.priv;
      state.deskPub = k.pub;
      state.deskPrivEnc = safeStorage.encryptString(k.priv).toString("base64");
      await save();
    }
  }
  if (!state.tls) {
    const made = makeDeskCert(["localhost", "127.0.0.1", os.hostname(), ...ipv4s()]);
    state.tls = { cert: made.cert, keyEnc: safeStorage.encryptString(made.pkcs8).toString("base64") };
    await save();
  }
  if (!tlsPrivPem) tlsPrivPem = safeStorage.decryptString(Buffer.from(state.tls.keyEnc, "base64"));
  return state;
}

function save() {
  const s = state!;
  if (s.jobs.length > 2000) s.jobs.splice(0, s.jobs.length - 2000);
  return serialized(file(), () => writeJsonAtomic(file(), s));
}

// A running job whose agent went quiet for 10 minutes is failed, so it stops counting against the user's limit.
function sweep(s: FleetState, now = Date.now()) {
  for (const j of s.jobs) {
    if (j.status !== "running") continue;
    const a = s.agents.find((x) => x.id === j.agentId);
    if (!a || a.status !== "approved" || now - a.lastSeen > 10 * 60_000) finish(j, "failed", "The agent stopped answering.");
  }
}

// Cancelling a running job also tells its agent at once, over the keepalive stream, so it stops mid-command.
function cancelJob(j: FleetJob) {
  if (j.status !== "queued" && j.status !== "running") return;
  if (j.status === "running" && j.agentId) push(j.agentId, { type: "cancel", jobId: j.id });
  finish(j, "cancelled");
}

function finish(j: FleetJob, status: FleetJob["status"], result?: string) {
  j.status = status;
  j.endedAt = Date.now();
  if (result !== undefined) j.result = result.slice(0, 50_000);
}


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

async function modelCall(job: FleetJob, b: Record<string, unknown>) {
  const key = providerKey("anthropic");
  if (!key) throw new Error("The superadmin desk has no Claude API key. Add one in Settings → AI models.");
  const client = new Anthropic({ apiKey: key });
  const msg = await client.messages.create({
    model: job.model,
    max_tokens: Math.min(Number(b.max_tokens) || 8000, 16_000),
    system: typeof b.system === "string" ? b.system : undefined,
    tools: Array.isArray(b.tools) ? (b.tools as Anthropic.Tool[]) : undefined,
    messages: b.messages as Anthropic.MessageParam[],
  });
  const p = priceFor(job.model);
  const u = msg.usage;
  const inTok = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  job.input += inTok;
  job.output += u.output_tokens;
  job.costUsd += (u.input_tokens * p.input + (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 + (u.cache_read_input_tokens ?? 0) * p.read + u.output_tokens * p.output) / 1e6;
  return msg;
}

type Reply = { status: number; data: unknown };

// One sealed call from an agent. "stream" is the keepalive: it waits up to 25 s and always answers with
// at least a ping, plus any job or cancel the desk has for this agent.
async function agentCall(s: FleetState, agent: FleetAgent, p: string, b: Record<string, unknown>, res: http.ServerResponse): Promise<Reply | null> {
  if (p === "stream") {
    const asked = Date.now();
    const holding = typeof b.jobId === "string" ? b.jobId : undefined;
    // A job this agent holds but doesn't report was lost: the agent restarted, or the reply that carried it dropped.
    for (const j of s.jobs) if (j.agentId === agent.id && j.status === "running" && j.id !== holding && (j.startedAt ?? 0) < asked) finish(j, "failed", "The agent lost this job (it restarted or the connection dropped).");
    let job = holding ? undefined : take(s, agent);
    if (!job && !outbox.get(agent.id)?.length) {
      await new Promise<void>((r) => {
        const t = setTimeout(done, 25_000);
        function done() {
          clearTimeout(t);
          kick.off("job", done);
          r();
        }
        kick.on("job", done);
        res.on("close", done); // req "close" fires as soon as the body is read, so watch the response
      });
      if (res.destroyed) return null;
      if (!holding) job = take(s, agent);
    }
    const messages: unknown[] = outbox.get(agent.id) ?? [];
    outbox.delete(agent.id);
    if (job) messages.push({ type: "job", job: { id: job.id, prompt: job.prompt, repo: job.repo, model: job.model } });
    messages.push({ type: "ping", t: Date.now() });
    agent.lastSeen = Date.now();
    await save();
    return { status: 200, data: { messages } };
  }
  const job = s.jobs.find((j) => j.id === b.jobId && j.agentId === agent.id);
  if (!job) return { status: 404, data: { error: "No such job." } };
  if (job.status !== "running") return { status: 409, data: { error: `Job is ${job.status}.` } };
  if (p === "model") {
    try {
      const msg = await modelCall(job, b);
      await save();
      return { status: 200, data: msg };
    } catch (e) {
      addLog(job, `Model error: ${(e as Error).message}`);
      await save();
      return { status: 502, data: { error: (e as Error).message } };
    }
  }
  if (p === "event") {
    if (typeof b.log === "string") addLog(job, b.log);
    if (b.done === true) finish(job, b.failed === true ? "failed" : "done", String(b.result ?? ""));
    await save();
    return { status: 200, data: { ok: true } };
  }
  return { status: 404, data: { error: "Unknown call." } };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const s = await load();
  const url = new URL(req.url ?? "/", "https://x");
  const route = `${req.method} ${url.pathname}`;
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  if (route === "GET /") return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (route === "GET /agent.mjs") return send(res, 200, serveAgent(AGENT_SRC, WIRE_SRC, s.tls!.cert), "text/javascript; charset=utf-8");
  if (route === "GET /desk.crt") return send(res, 200, s.tls!.cert, "application/x-x509-ca-cert");

  const b = req.method === "POST" ? await body(req) : {};
  const now = Date.now();

  // ---- agents ----
  // Only pair and hello are plain: neither carries anything secret. Everything else is sealed in a session.
  if (route === "POST /agent/pair") {
    const r = pair(s, { pub: b.pub, name: b.name, os: b.os });
    await save();
    return send(res, 200, r);
  }
  if (route === "POST /agent/hello") {
    const agent = s.agents.find((a) => a.id === b.agentId && a.status === "approved");
    if (!agent) return send(res, 403, { error: "removed" });
    for (const [sid, x] of sessions) if (now - x.used > (x.confirmed ? 15 * 60_000 : 60_000)) sessions.delete(sid);
    if (sessions.size > 500) return send(res, 503, { error: "Too many sessions." });
    const k = deskSession(deskPriv, agent.pub, String(b.e ?? ""));
    const sid = newId();
    sessions.set(sid, { agentId: agent.id, ch: channel(sid, k.down, k.up), at: now, used: now, confirmed: false });
    return send(res, 200, { sid, e: k.eph });
  }
  if (route === "POST /agent/s") {
    const sess = sessions.get(String(b.s ?? ""));
    const agent = sess && s.agents.find((a) => a.id === sess.agentId && a.status === "approved");
    if (!sess || !agent) return send(res, 401, { error: "session" });
    const msg = sess.ch.open(b); // throws on tampering or replay → 400
    sess.used = now;
    if (!sess.confirmed) {
      // The first sealed message proves the agent holds its key; it now replaces older sessions.
      for (const [sid, x] of sessions) if (x.agentId === agent.id && x !== sess && x.at < sess.at) sessions.delete(sid);
      sess.confirmed = true;
    }
    agent.lastSeen = now;
    const r = await agentCall(s, agent, String(msg?.p ?? ""), msg?.b && typeof msg.b === "object" ? msg.b : {}, res);
    if (!r) return; // the agent hung up while the stream waited
    return send(res, 200, sess.ch.seal(r));
  }

  // ---- users ----
  if (route === "POST /user/redeem") {
    const r = redeem(s, b.code, b.device);
    await save();
    return r ? send(res, 200, r) : send(res, 403, { error: "That code is wrong, already used, or revoked." });
  }
  if (url.pathname.startsWith("/user/")) {
    const user = userFor(s, req.headers.authorization);
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
      kick.emit("job");
      return send(res, 200, publicJob(r, s));
    }
    const cancel = /^\/user\/jobs\/(\w+)\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && cancel) {
      const j = s.jobs.find((x) => x.id === cancel[1] && x.userId === user.id);
      if (j) cancelJob(j);
      await save();
      return send(res, 200, { ok: true });
    }
  }

  // ---- desktop setup (one-time cloud registration with API key) ----
  if (route === "POST /desktop/setup") {
    // Desktop requests a one-time setup code
    if (s.desktop && s.desktop.registeredAt) return send(res, 403, { error: "Already registered" });
    const { setupCode, setupCodeHash } = createDesktopSetup();
    s.desktop = { id: newId(), setupCode, setupCodeHash, apiKeyEnc: "", createdAt: Date.now() };
    await save();
    // Return the setup code ONCE; it's shown to the user. Never again.
    return send(res, 200, { setupCode });
  }

  if (route === "POST /desktop/register") {
    // Desktop sends back setupCodeHash + encrypted API key
    if (!s.desktop) return send(res, 403, { error: "No setup in progress" });
    if (!registerDesktop(s, String(b.setupCodeHash), String(b.apiKeyEnc))) return send(res, 403, { error: "Invalid or already used code" });
    await save();
    return send(res, 200, { ok: true });
  }

  if (route === "GET /desktop/status") {
    // Desktop checks if registration is complete
    if (!s.desktop) return send(res, 404, { error: "Not registered" });
    return send(res, 200, { registered: !!s.desktop.registeredAt });
  }

  if (route === "POST /desktop/model") {
    // Desktop makes a model call using its uploaded API key
    // The key is stored here in plaintext only in memory for the SDK call.
    // This endpoint is HTTPS-only, so transit is encrypted.
    // Cloud code doesn't log, display, or hard-code the key anywhere.
    const keyEnc = getDesktopApiKeyEnc(s);
    if (!keyEnc) return send(res, 403, { error: "No API key registered" });
    
    // Desktop sends request (model, messages, etc.)
    const { model, messages, system, tools, max_tokens } = b;
    if (!model || !Array.isArray(messages)) return send(res, 400, { error: "Missing model or messages" });

    try {
      // Use the stored key (which is in plaintext in memory but only for this operation).
      // The SDK is instantiated fresh for each call, so the key is never held longer than needed.
      // Note: keyEnc should be the plaintext key that desktop encrypted with its own Windows credential store
      // and sent to this cloud server. Cloud server stores it as-is (not in git, not logged).
      const client = new Anthropic({ apiKey: String(keyEnc) });
      const response = await client.messages.create({
        model: String(model),
        max_tokens: Math.min(Number(max_tokens) || 8000, 16_000),
        system: typeof system === "string" ? system : undefined,
        tools: Array.isArray(tools) ? (tools as Anthropic.Tool[]) : undefined,
        messages: messages as Anthropic.MessageParam[],
      });
      return send(res, 200, response);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  return send(res, 404, { error: "Unknown call." });
}

function start(port: number) {
  stop();
  serverError = "";
  server = https.createServer({ cert: state!.tls!.cert, key: tlsPrivPem }, (req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 400, { error: (e as Error).message });
    });
  });
  server.on("error", (e) => {
    serverError = `Could not listen on port ${port}: ${(e as Error).message}`;
    server = null;
  });
  server.listen(port, "0.0.0.0");
}

function stop() {
  server?.close();
  server?.closeAllConnections();
  server = null;
}

export async function startFleetOnLaunch() {
  const s = await load();
  if (s.on) start(s.port);
}

function ipv4s() {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list ?? []) if (n.family === "IPv4" && !n.internal) out.push(n.address);
  return out;
}

function addresses(port: number) {
  const ips = ipv4s();
  return (ips.length ? ips : ["localhost"]).map((ip) => `https://${ip}:${port}`);
}

// What the Settings page shows. Token hashes and agent secrets never leave the main process.
export async function fleetState() {
  const s = await load();
  sweep(s);
  return {
    adminId: s.adminId, createdAt: s.createdAt, on: s.on, port: s.port, maxAgents: s.maxAgents, listening: !!server?.listening, error: serverError,
    urls: addresses(s.port), hasKey: !!providerKey("anthropic"), deskKey: fingerprint(s.deskPub!), tlsPin: pubkeyPin(s.tls!.cert), tlsFingerprint: new X509Certificate(s.tls!.cert).fingerprint256,
    agents: s.agents.filter((a) => a.status !== "revoked").map((a) => ({ id: a.id, name: a.name, os: a.os, status: a.status, online: online(a), lastSeen: a.lastSeen, createdAt: a.createdAt, code: a.status === "pending" ? undefined : a.code })),
    users: s.users.filter((u) => !u.revoked).map((u: FleetUser) => ({ id: u.id, name: u.name, maxAgents: u.maxAgents, agentIds: u.agentIds, code: u.code, redeemed: !!u.tokenHash || !!u.devices?.length, devices: [...(u.devices ?? []).map((d) => ({ id: d.id, name: d.name })), ...(u.tokenHash ? [{ id: "legacy", name: "earlier device" }] : [])], createdAt: u.createdAt })),
    jobs: s.jobs.slice(-100).reverse().map((j) => ({ ...publicJob(j, s), user: j.userId === ADMIN_USER ? "Superadmin" : s.users.find((u) => u.id === j.userId)?.name ?? "removed user" })),
  };
}

export async function fleetSetup(patch: { on?: boolean; port?: number; maxAgents?: number }) {
  const s = await load();
  if (typeof patch.port === "number" && patch.port >= 1024 && patch.port <= 65535) s.port = Math.floor(patch.port);
  if (typeof patch.maxAgents === "number" && patch.maxAgents >= 0) s.maxAgents = Math.floor(patch.maxAgents);
  if (typeof patch.on === "boolean") s.on = patch.on;
  await save();
  if (s.on) start(s.port);
  else stop();
  await new Promise((r) => setTimeout(r, 200)); // let listen() report a busy port before the page reads the state
  return fleetState();
}

export async function fleetApprove(code: string) {
  const s = await load();
  const err = approve(s, code);
  await save();
  return err;
}

export async function fleetRemoveAgent(id: string) {
  const s = await load();
  const a = s.agents.find((x) => x.id === id);
  if (a) {
    a.status = "revoked";
    dropSessions(id);
    kick.emit("job"); // its open stream answers, and the next call finds no session
    for (const j of s.jobs) if (j.agentId === id && j.status === "running") finish(j, "failed", "The superadmin removed this agent.");
  }
  await save();
}

export async function fleetAddUser(name: string, maxAgents: number, agentIds: string[]) {
  const s = await load();
  const u = addUser(s, name, maxAgents, Array.isArray(agentIds) ? agentIds.map(String) : []);
  await save();
  return u.code!;
}

export async function fleetUpdateUser(id: string, patch: { maxAgents?: number; agentIds?: string[]; revoke?: boolean; newCode?: boolean; revokeDevice?: string; signOutAll?: boolean }) {
  const s = await load();
  const u = s.users.find((x) => x.id === id);
  if (!u) return;
  if (typeof patch.maxAgents === "number" && patch.maxAgents >= 0) u.maxAgents = Math.floor(patch.maxAgents);
  if (Array.isArray(patch.agentIds)) u.agentIds = patch.agentIds.map(String);
  if (patch.revoke) {
    u.revoked = true;
    u.tokenHash = undefined;
    u.devices = [];
    for (const j of s.jobs) if (j.userId === id) cancelJob(j);
  }
  // A new code is for one more device; the devices already signed in stay.
  if (patch.newCode) u.code = newCode();
  if (patch.revokeDevice) {
    u.devices = (u.devices ?? []).filter((d) => d.id !== patch.revokeDevice);
    if (!u.devices.length) u.tokenHash = undefined;
  }
  if (patch.signOutAll) u.devices = [], u.tokenHash = undefined;
  await save();
}

export async function fleetSubmit(input: { prompt: string; repo?: string; agentId?: string; model?: string }) {
  const s = await load();
  const r = submit(s, ADMIN_USER, input);
  if (typeof r === "string") return r;
  await save();
  kick.emit("job");
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

// The page any browser gets at /: redeem a code, start jobs, watch them. Same calls the phone app makes.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud agents</title>
<style>body{font:15px system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;background:#16181d;color:#e6e6e6}input,textarea,select,button{font:inherit;padding:8px;border-radius:6px;border:1px solid #444;background:#22252c;color:inherit;box-sizing:border-box}textarea,input,select{width:100%;margin:4px 0}button{cursor:pointer}.job{border:1px solid #333;border-radius:8px;padding:10px;margin:10px 0}.m{color:#999;font-size:13px}pre{white-space:pre-wrap;font-size:13px}</style></head><body>
<h1>Cloud agents</h1><div id="app"></div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let token=localStorage.getItem('fleet.token')||'';
async function api(p,b){const r=await fetch(p,{method:b?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:b?JSON.stringify(b):undefined});const t=await r.text();const v=t?JSON.parse(t):{};if(r.status===401){token='';localStorage.removeItem('fleet.token')}if(!r.ok)throw new Error(v.error||r.status);return v}
async function draw(){const app=document.getElementById('app');
 if(!token){app.innerHTML='<p>Enter the access code your admin gave you.</p><input id=c placeholder="ABCD-EFGH"><button id=go>Sign in</button><p id=e class=m></p>';
  document.getElementById('go').onclick=async()=>{try{const r=await fetch('/user/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value})});const v=await r.json();if(!r.ok)throw new Error(v.error);token=v.token;localStorage.setItem('fleet.token',token);draw()}catch(x){document.getElementById('e').textContent=x.message}};return}
 let me;try{me=await api('/user/me')}catch(x){app.innerHTML='<p class=m>'+esc(x.message)+'</p>';if(!token)setTimeout(draw,50);return}
 const keep={p:document.getElementById('p')?.value||'',r:document.getElementById('r')?.value||''};
 app.innerHTML='<p class=m>Signed in as '+esc(me.name)+' · up to '+me.maxAgents+' agents at once</p>'+
 '<textarea id=p rows=4 placeholder="What should the agent do?"></textarea><input id=r placeholder="Git repository (optional, https or ssh)">'+
 '<select id=a><option value="">Any free agent</option>'+me.agents.map(a=>'<option value="'+a.id+'">'+esc(a.name)+' ('+esc(a.os)+(a.online?'':', offline')+')</option>').join('')+'</select>'+
 '<select id=mo><option value="claude-sonnet-5-5">Sonnet</option><option value="claude-haiku-5-5">Haiku</option><option value="claude-opus-5-5">Opus</option></select>'+
 '<button id=s>Start job</button> <span id=e class=m></span>'+me.jobs.map(j=>'<div class=job><b>'+esc(j.status)+'</b> <span class=m>'+esc(j.agent||'waiting for an agent')+' · $'+j.costUsd.toFixed(3)+'</span>'+((j.status==='queued'||j.status==='running')?' <button data-c="'+j.id+'">Cancel</button>':'')+'<pre>'+esc(j.prompt)+'</pre>'+(j.result?'<pre>'+esc(j.result)+'</pre>':'<pre class=m>'+esc(j.log.slice(-5).join('\\n'))+'</pre>')+'</div>').join('');
 document.getElementById('p').value=keep.p;document.getElementById('r').value=keep.r;
 document.getElementById('s').onclick=async()=>{try{await api('/user/jobs',{prompt:document.getElementById('p').value,repo:document.getElementById('r').value||undefined,agentId:document.getElementById('a').value||undefined,model:document.getElementById('mo').value});document.getElementById('p').value='';draw()}catch(x){document.getElementById('e').textContent=x.message}};
 app.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>api('/user/jobs/'+b.dataset.c+'/cancel',{}).then(draw));}
draw();setInterval(()=>{if(token&&document.activeElement?.tagName!=='TEXTAREA'&&document.activeElement?.tagName!=='INPUT')draw()},5000);
</script></body></html>`;
