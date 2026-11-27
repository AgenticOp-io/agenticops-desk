import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

// Cloud agents run by this desk, the superadmin. Pure state logic, no Electron, so it can be tested.
// Tokens are stored only as sha256 hashes; a token is shown once, when it is handed out.

// cert: the certificate the desk made for the agent; the agent signs everything it pushes to the job channel with
// its key, which lives only on the agent. aliveAt: the agent's newest heartbeat. "pending", code and pub are left
// from older pairing flows.
export type FleetAgent = { id: string; name: string; os: string; code: string; pub: string; cert?: string; aliveAt?: number; status: "pending" | "approved" | "revoked"; createdAt: number; lastSeen: number };
// One per worker desk or phone that signed in: its own token and client certificate, so the superadmin can cut off one device.
export type FleetDevice = { id: string; name: string; tokenHash: string; cert?: string; createdAt: number; usedAt?: number };
// A user is a desktop worker the superadmin added; its devices are that desktop and the phones it paired.
// paused = the superadmin denied access for now; the user and its devices stay.
// enrolCert/enrolKeyEnc: the client certificate in the user's join key, trusted only while code is unused.
export type FleetUser = { id: string; name: string; maxAgents: number; agentIds: string[]; code?: string; enrolCert?: string; enrolKeyEnc?: string; tokenHash?: string; devices?: FleetDevice[]; revoked?: boolean; paused?: boolean; createdAt: number };
export type FleetJob = {
  id: string; userId: string; agentId?: string; wantAgent?: string; prompt: string; repo?: string; model: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled"; createdAt: number; startedAt?: number; endedAt?: number;
  log: string[]; result?: string; input: number; output: number; costUsd: number;
};
// channel: the git repository whose agent-jobs branch carries jobs to agents and their results back (fleet.ts).
// tls.keyEnc: the desk CA key, encrypted with the OS credential store; it also signs every job.
export type FleetState = { adminId: string; createdAt: number; on: boolean; port: number; maxAgents: number; channel?: string; tls?: { cert: string; keyEnc: string; server?: string }; agents: FleetAgent[]; users: FleetUser[]; jobs: FleetJob[] };

export const ADMIN_USER = "admin";
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
// Agents push a heartbeat to the job channel every 5 minutes, so two missed ones = offline.
export const ONLINE_MS = 11 * 60_000;
export const CHANNEL_BRANCH = "agent-jobs";
// The agent hands these to git and a shell, so only plain URL characters.
export const gitAddress = (v: unknown) => /^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(String(v ?? ""));

export const newId = () => randomBytes(8).toString("hex");
export const newToken = () => randomBytes(32).toString("hex");
export const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export function newCode() {
  const b = randomBytes(8);
  const s = [...b].map((x) => ALPHABET[x % 32]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

export function emptyState(): FleetState {
  return { adminId: newId(), createdAt: Date.now(), on: false, port: 7377, maxAgents: 5, agents: [], users: [], jobs: [] };
}

export const online = (a: FleetAgent, now = Date.now()) => a.status === "approved" && now - a.lastSeen < ONLINE_MS;

// What a new agent needs, all made here: the desk and agent never connect, so the agent file is the whole handover.
// signKey: the agent's private signing key (only in the file); cert: its desk-signed certificate. channel: the job
// channel repository. apiKey: the agent's own Claude API key, so model calls never pass through the desk.
export type AgentBundle = { deskCert: string; agentId: string; name: string; signKey: string; cert: string; channel: string; apiKey: string };
export function addAgent(s: FleetState, name: string, apiKey: string, deskTlsKeyPem: string, now = Date.now()): AgentBundle | string {
  if (!s.channel) return "Set the job channel repository first.";
  const key = String(apiKey ?? "").trim();
  if (!/^\S{20,}$/.test(key)) return "Paste the Claude API key you made for this agent (Claude Console → API keys, with a spend limit).";
  if (s.agents.filter((x) => x.status === "approved").length >= s.maxAgents) return `This desk allows ${s.maxAgents} agents. Raise the limit or remove one first.`;
  const id = newId();
  const made = newClientCert(`agent ${id}`, deskTlsKeyPem, new Date(now));
  const n = name.trim().slice(0, 60) || "agent";
  s.agents.push({ id, name: n, os: "", code: "", pub: "", cert: made.certPem, status: "approved", createdAt: now, lastSeen: 0 });
  return { deskCert: s.tls!.cert, agentId: id, name: n, signKey: made.keyPem, cert: made.certPem, channel: s.channel, apiKey: key };
}

// The agent file: the agent script with its bundle built in.
export function serveAgent(agentSrc: string, bundle: AgentBundle | null) {
  const bundleRe = /^const BUNDLE = null;\r?$/m;
  if (!bundleRe.test(agentSrc)) throw new Error("agentd.mjs has no BUNDLE line");
  return agentSrc.replace(bundleRe, () => `const BUNDLE = ${JSON.stringify(bundle)};`);
}

// ---- the job channel: files on the agent-jobs branch, each { data, sig } signed by its writer ----
// jobs/<agentId>/<jobId>.json  desk → agent, signed with the desk CA key
// agents/<agentId>/*.json       agent → desk (alive.json heartbeat, <jobId>.json progress and result), signed by the agent
// Anyone who can push to the repository can write files there; only signatures decide what is believed.
export type Signed = { data: Record<string, unknown>; sig: string };
export const signed = (data: Record<string, unknown>, keyPem: string): Signed => ({ data, sig: sign("sha256", Buffer.from(JSON.stringify(data)), createPrivateKey(keyPem)).toString("base64") });
export function opened(file: unknown, certPem: string): Record<string, unknown> | null {
  const f = file as Partial<Signed> | null;
  if (!f || typeof f.sig !== "string" || !f.data || typeof f.data !== "object" || Array.isArray(f.data)) return null;
  try {
    return verify("sha256", Buffer.from(JSON.stringify(f.data)), new X509Certificate(certPem).publicKey, Buffer.from(f.sig, "base64")) ? f.data : null;
  } catch {
    return null;
  }
}

// The job files the desk publishes: every running job, and a cancelled one for an hour so its agent stops it.
export function jobOrders(s: FleetState, now = Date.now()) {
  return s.jobs
    .filter((j) => j.agentId && (j.status === "running" || (j.status === "cancelled" && now - (j.endedAt ?? 0) < 3_600_000)))
    .map((j) => ({ path: `jobs/${j.agentId}/${j.id}.json`, data: { agentId: j.agentId!, id: j.id, prompt: j.prompt, repo: j.repo ?? null, model: j.model, cancelled: j.status === "cancelled" } }));
}

export type Price = { input: number; read: number; output: number };
// One verified file from an agent. Results only count for a job the desk gave that agent and still runs.
export function applyReport(s: FleetState, a: FleetAgent, d: Record<string, unknown>, priceOf: (model: string) => Price, now = Date.now()) {
  if (d.agentId !== a.id) return;
  if (d.kind === "alive") {
    const at = Number(d.at) || 0;
    if (at > (a.aliveAt ?? 0)) {
      a.aliveAt = at;
      a.lastSeen = now;
      if (typeof d.os === "string") a.os = d.os.slice(0, 30);
    }
    return;
  }
  const j = s.jobs.find((x) => x.id === d.jobId && x.agentId === a.id && x.status === "running");
  if (!j) return;
  a.lastSeen = now;
  if (Array.isArray(d.log)) j.log = d.log.slice(-200).map((l) => String(l).slice(0, 2000));
  const u = (d.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  const [inp, write, read, out] = [n(u.input), n(u.cacheWrite), n(u.cacheRead), n(u.output)];
  const p = priceOf(j.model);
  j.input = inp + write + read;
  j.output = out;
  j.costUsd = (inp * p.input + write * p.input * 1.25 + read * p.read + out * p.output) / 1e6;
  if (d.status === "done" || d.status === "failed") {
    j.status = d.status;
    j.endedAt = now;
    j.result = String(d.result ?? "").slice(0, 50_000);
  }
}

// ---- the desk's own TLS certificate: self-signed ECDSA P-256, made once, DER written by hand (Node can't make X.509) ----
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split(".").map(Number);
  const out = [a * 40 + b];
  for (let v of rest) {
    const bytes = [v & 0x7f];
    while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ipBytes = (ip: string) => Buffer.from(ip.split(".").map(Number));

const cn = (s: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(s)))));
const DESK_NAME = cn("AgenticOps Desk");
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

// A certificate issued by the desk (issuer name DESK_NAME), signed with the desk's TLS key.
function buildCert(subject: Buffer, spki: Buffer, exts: Buffer[], deskKey: KeyObject, now: Date) {
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x40;
  const until = new Date(now.getTime() + 10 * 365 * 86_400_000);
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), sigAlg, DESK_NAME, seq(utc(now), utc(until)), subject, spki, tlv(0xa3, seq(...exts)));
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, deskKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;
}

// keyPem reuses the desk's key: a re-issue for a new address keeps the pin agents already carry,
// and agent certificates it signed still verify (same name, same key).
export function makeDeskCert(names: string[], now = new Date(), keyPem?: string) {
  const privateKey = keyPem ? createPrivateKey(keyPem) : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const san = seq(...[...new Set(names)].map((n) => (isIP(n) === 4 ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n)))));
  const cert = buildCert(DESK_NAME, spki, [ext("2.5.29.19", true, seq(tlv(0x01, Buffer.from([0xff])))), ext("2.5.29.17", false, san)], privateKey, now);
  return { cert, pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

// The certificate the desk's server presents: its addresses, the desk's own key (so phone pins hold), signed by the
// desk CA (makeDeskCert). Re-issued when the address changes; the CA never is, so clients that trust it keep working.
export function makeServerCert(names: string[], deskKeyPem: string, now = new Date()) {
  const key = createPrivateKey(deskKeyPem);
  const san = seq(...[...new Set(names)].map((n) => (isIP(n) === 4 ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n)))));
  return buildCert(cn("AgenticOps Desk server"), createPublicKey(key).export({ type: "spki", format: "der" }), [ext("2.5.29.19", true, seq()), ext("2.5.29.17", false, san)], key, now);
}

// A client key and certificate for an agent, worker desk or phone: signed by the desk, not a CA, client use only.
// The desk's TLS server accepts no connection without one (fleet.ts). Agents use theirs to sign job-channel files.
export function newClientCert(name: string, deskKeyPem: string, now = new Date()) {
  const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const eku = seq(oid("1.3.6.1.5.5.7.3.2"));
  const cert = buildCert(cn(name), k.publicKey.export({ type: "spki", format: "der" }), [ext("2.5.29.19", true, seq()), ext("2.5.29.37", false, eku)], createPrivateKey(deskKeyPem), now);
  return { keyPem: k.privateKey.export({ type: "pkcs8", format: "pem" }) as string, certPem: cert };
}

// Every client certificate the desk's HTTPS server accepts right now (sha256 fingerprints): signed-in devices of users
// still on, and the one-time join certificate of a user whose code is unused. Agents never connect, so theirs aren't.
export function trustedCerts(s: FleetState): Set<string> {
  const pems = s.users.filter((u) => !u.revoked).flatMap((u) => [...(u.devices ?? []).map((d) => d.cert), u.code ? u.enrolCert : undefined]);
  return new Set(pems.filter((p): p is string => !!p).map(fpOf));
}
export const fpOf = (pem?: string) => (pem ? new X509Certificate(pem).fingerprint256 : "");

// The host names and addresses a desk certificate covers.
export function certNames(certPem: string): string[] {
  const san = new X509Certificate(certPem).subjectAltName ?? "";
  return san.split(/,\s*/).filter(Boolean).map((e) => e.replace(/^(DNS|IP Address):/, ""));
}

// What `curl --pinnedpubkey` wants: sha256 of the certificate's public key, base64.
export function pubkeyPin(certPem: string | Buffer) {
  return createHash("sha256").update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
}

export function addUser(s: FleetState, name: string, maxAgents: number, agentIds: string[], now = Date.now()): FleetUser {
  const u: FleetUser = { id: newId(), name: name.trim().slice(0, 60) || "User", maxAgents: Math.max(0, Math.floor(maxAgents) || 0), agentIds, code: newCode(), createdAt: now };
  s.users.push(u);
  return u;
}

// One-time: the code becomes a token on the device that redeems it. That device connected with the user's join
// certificate (enrolCert), which now becomes the device's own, so revoking the device cuts its connection too.
// certFp: the connection's client certificate; it must be this user's join certificate.
export function redeem(s: FleetState, codeIn: unknown, device?: unknown, certFp?: string): { token: string; name: string } | null {
  const code = normCode(codeIn);
  const u = s.users.find((x) => x.code === code && !x.revoked);
  if (!u || (certFp !== undefined && fpOf(u.enrolCert) !== certFp)) return null;
  const cert = u.enrolCert;
  u.code = u.enrolCert = u.enrolKeyEnc = undefined;
  return { token: addDevice(u, device, cert), name: u.name };
}

// A new signed-in device for this user; the token is returned once and only its hash is kept.
// cert: the client certificate the device connects with; without one it can't reach the desk.
export function addDevice(u: FleetUser, device?: unknown, cert?: string): string {
  const token = newToken();
  (u.devices ??= []).push({ id: newId(), name: String(device ?? "device").slice(0, 60) || "device", tokenHash: hash(token), cert, createdAt: Date.now() });
  return token;
}

// Everything a desktop worker needs to join this desk's pool, in one string the superadmin hands over:
// the address, the desk's public-key pin, the one-time code, the client key and certificate it must present to
// connect at all, and the desk CA it checks the desk against (PEM, base64url).
export const joinKey = (url: string, pin: string, code: string, keyPem: string, certPem: string, caPem: string) =>
  [url, pin, code, ...[keyPem, certPem, caPem].map((x) => Buffer.from(x).toString("base64url"))].join("#");
export function parseJoinKey(key: unknown): { url: string; pin: string; code: string; keyPem: string; certPem: string; caPem: string } | null {
  const [url, pin, code, k, c, a, extra] = String(key ?? "").trim().split("#");
  if (extra !== undefined || !k || !c || !a || !/^https:\/\/[\w.-]+(:\d+)?$/.test(url ?? "") || !/^[A-Za-z0-9+/]{43}=$/.test(pin ?? "")) return null;
  const n = normCode(code);
  const [keyPem, certPem, caPem] = [k, c, a].map((x) => Buffer.from(x, "base64url").toString("utf8"));
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(n) || !keyPem.includes("PRIVATE KEY") || !certPem.includes("CERTIFICATE") || !caPem.includes("CERTIFICATE")) return null;
  return { url, pin, code: n, keyPem, certPem, caPem };
}

const bearer = (header: unknown) => /^Bearer (\w{64})$/.exec(String(header ?? ""))?.[1];
// Marks the device's first use, so pruneUnscanned never drops a token a person is actually using.
// certFp: the connection's client certificate; the token only counts on the device it was issued to.
export const userFor = (s: FleetState, header: unknown, onFirstUse?: () => void, certFp?: string) => {
  const t = bearer(header);
  if (!t) return undefined;
  const h = hash(t);
  for (const u of s.users) {
    if (u.revoked) continue;
    if (u.tokenHash === h && certFp === undefined) return u;
    const d = u.devices?.find((x) => x.tokenHash === h);
    if (d && (certFp === undefined || fpOf(d.cert) === certFp)) {
      if (!d.usedAt) (d.usedAt = Date.now()), onFirstUse?.();
      return u;
    }
  }
  return undefined;
};

// Many people can pair phones from the same desk QR, so keep every token in use and only cap
// the ones minted for a QR that nobody has scanned yet.
export function pruneUnscanned(u: FleetUser, keep = 3) {
  const unused = (u.devices ?? []).filter((d) => !d.usedAt);
  const drop = new Set(unused.slice(0, Math.max(0, unused.length - keep)));
  u.devices = (u.devices ?? []).filter((d) => !drop.has(d));
}

export const usableAgents = (s: FleetState, userId: string) => {
  const u = s.users.find((x) => x.id === userId);
  return s.agents.filter((a) => a.status === "approved" && (userId === ADMIN_USER || !u?.agentIds.length || u.agentIds.includes(a.id)));
};

// maxAgents = how many cloud agents the user may keep busy at once (queued + running jobs).
export function submit(s: FleetState, userId: string, input: { prompt: unknown; repo?: unknown; agentId?: unknown; model?: unknown }, now = Date.now()): FleetJob | string {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) return "Write what the agent should do.";
  const u = s.users.find((x) => x.id === userId);
  if (userId !== ADMIN_USER) {
    if (!u || u.revoked) return "This access code was revoked.";
    if (u.paused) return "The superadmin has paused your access to the cloud agents.";
    const busy = s.jobs.filter((j) => j.userId === userId && (j.status === "queued" || j.status === "running")).length;
    if (busy >= u.maxAgents) return `You can use ${u.maxAgents} cloud agent${u.maxAgents === 1 ? "" : "s"} at a time. Wait for a job to finish.`;
  }
  const want = input.agentId ? String(input.agentId) : undefined;
  const pool = usableAgents(s, userId);
  if (!pool.length) return "No cloud agent is available to you.";
  if (want && !pool.some((a) => a.id === want)) return "You can't use that agent.";
  const repo = input.repo ? String(input.repo).trim() : undefined;
  // The agent puts this into a shell line, so only plain URL characters.
  if (repo && !gitAddress(repo)) return "Repository must be an https or ssh git address.";
  const model = MODELS.includes(String(input.model)) ? String(input.model) : "claude-sonnet-5-5";
  const job: FleetJob = { id: newId(), userId, wantAgent: want, prompt: prompt.slice(0, 20_000), repo, model, status: "queued", createdAt: now, log: [], input: 0, output: 0, costUsd: 0 };
  s.jobs.push(job);
  return job;
}

// Oldest queued job this agent may take.
export function take(s: FleetState, agent: FleetAgent, now = Date.now()): FleetJob | undefined {
  const job = s.jobs.find((j) => j.status === "queued" && (j.wantAgent ? j.wantAgent === agent.id : usableAgents(s, j.userId).some((a) => a.id === agent.id)));
  if (job) Object.assign(job, { status: "running", agentId: agent.id, startedAt: now });
  return job;
}

// A queued job no approved agent may take would wait forever and hold the user's slot.
export const stranded = (s: FleetState, j: FleetJob) => {
  const pool = usableAgents(s, j.userId);
  return j.status === "queued" && (j.wantAgent ? !pool.some((a) => a.id === j.wantAgent) : !pool.length);
};

// Past the cap, drop the oldest finished jobs; a queued or running one is never dropped.
export function trimJobs(s: FleetState, max = 2000) {
  let extra = s.jobs.length - max;
  if (extra > 0) s.jobs = s.jobs.filter((j) => extra <= 0 || j.status === "queued" || j.status === "running" || (extra--, false));
}

export function addLog(job: FleetJob, line: string) {
  job.log.push(line.slice(0, 2000));
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}

export type ReportRow = { kind: "user" | "agent"; id: string; name: string; jobs: number; failed: number; input: number; output: number; costUsd: number; minutes: number };

export function report(s: FleetState, from: number, to: number): ReportRow[] {
  const rows = new Map<string, ReportRow>();
  const nameOf = (kind: "user" | "agent", id: string) =>
    kind === "agent" ? s.agents.find((a) => a.id === id)?.name ?? "removed agent" : id === ADMIN_USER ? "Superadmin (this desk)" : s.users.find((u) => u.id === id)?.name ?? "removed user";
  for (const j of s.jobs) {
    if (j.createdAt < from || j.createdAt >= to) continue;
    for (const [kind, id] of [["user", j.userId], ["agent", j.agentId]] as const) {
      if (!id) continue;
      const key = `${kind}:${id}`;
      const r = rows.get(key) ?? { kind, id, name: nameOf(kind, id), jobs: 0, failed: 0, input: 0, output: 0, costUsd: 0, minutes: 0 };
      r.jobs++;
      if (j.status === "failed") r.failed++;
      r.input += j.input;
      r.output += j.output;
      r.costUsd += j.costUsd;
      if (j.startedAt && j.endedAt) r.minutes += (j.endedAt - j.startedAt) / 60_000;
      rows.set(key, r);
    }
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? b.costUsd - a.costUsd : a.kind === "user" ? -1 : 1));
}

export function reportCsv(rows: ReportRow[]): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return ["kind,name,jobs,failed,input_tokens,output_tokens,cost_usd,minutes", ...rows.map((r) => [r.kind, q(r.name), r.jobs, r.failed, r.input, r.output, r.costUsd.toFixed(4), r.minutes.toFixed(1)].join(","))].join("\n") + "\n";
}
