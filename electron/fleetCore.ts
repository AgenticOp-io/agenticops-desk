import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { pairCode } from "../agent/wire.mjs";

// Cloud agents run by this desk, the superadmin. Pure state logic, no Electron, so it can be tested.
// Tokens are stored only as sha256 hashes; a token is shown once, when it is handed out.

// pub is the agent's long-term X25519 key (agent/wire.mjs); its code is derived from it.
export type FleetAgent = { id: string; name: string; os: string; code: string; pub: string; status: "pending" | "approved" | "revoked"; createdAt: number; lastSeen: number };
// One per phone or browser that redeemed a code: its own token, so the superadmin can cut off one device.
export type FleetDevice = { id: string; name: string; tokenHash: string; createdAt: number; usedAt?: number };
// A user is a desktop worker the superadmin added; its devices are that desktop and the phones it paired.
// paused = the superadmin denied access for now; the user and its devices stay.
export type FleetUser = { id: string; name: string; maxAgents: number; agentIds: string[]; code?: string; tokenHash?: string; devices?: FleetDevice[]; revoked?: boolean; paused?: boolean; createdAt: number };
export type FleetJob = {
  id: string; userId: string; agentId?: string; wantAgent?: string; prompt: string; repo?: string; model: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled"; createdAt: number; startedAt?: number; endedAt?: number;
  log: string[]; result?: string; input: number; output: number; costUsd: number;
};
// deskPub/deskPrivEnc: the desk's long-term X25519 key; the private half is encrypted with the OS credential store.
export type FleetState = { adminId: string; createdAt: number; on: boolean; port: number; maxAgents: number; deskPub?: string; deskPrivEnc?: string; tls?: { cert: string; keyEnc: string }; agents: FleetAgent[]; users: FleetUser[]; jobs: FleetJob[] };

export const ADMIN_USER = "admin";
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ONLINE_MS = 60_000;

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

// An agent polls this with its public key. The code it shows is a hash of that key, so the code the
// superadmin types approves exactly that key; nothing secret is handed out here.
export function pair(s: FleetState, input: { pub: unknown; name: unknown; os: unknown }, now = Date.now()): { status: string; agentId?: string; desk?: string } {
  const pub = String(input.pub ?? "");
  let code: string;
  try {
    code = pairCode(pub);
  } catch {
    return { status: "invalid" };
  }
  const a = s.agents.find((x) => x.pub === pub);
  if (!a) {
    if (s.agents.filter((x) => x.status === "pending").length >= 20) return { status: "busy" };
    s.agents.push({ id: newId(), name: String(input.name ?? "agent").slice(0, 60), os: String(input.os ?? "").slice(0, 30), code, pub, status: "pending", createdAt: now, lastSeen: now });
    return { status: "pending" };
  }
  a.lastSeen = now;
  return a.status === "approved" ? { status: "approved", agentId: a.id, desk: s.deskPub } : { status: a.status };
}

// The agent script as the desk serves it: one file, with agent/wire.mjs pasted in place of its import,
// and this desk's TLS certificate built in so the agent trusts only this desk.
export function serveAgent(agentSrc: string, wireSrc: string, certPem: string) {
  const re = /^import [^\n]*from "\.\/wire\.mjs";\r?$/m;
  const certRe = /^const DESK_CERT = null;\r?$/m;
  if (!re.test(agentSrc) || !certRe.test(agentSrc)) throw new Error("agentd.mjs no longer imports ./wire.mjs or has no DESK_CERT line");
  return agentSrc.replace(re, () => wireSrc.replace(/^export /gm, "")).replace(certRe, () => `const DESK_CERT = ${JSON.stringify(certPem)};`);
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

// keyPem reuses the desk's key: a re-issue for a new address keeps the pin agents already carry.
export function makeDeskCert(names: string[], now = new Date(), keyPem?: string) {
  const privateKey = keyPem ? createPrivateKey(keyPem) : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("AgenticOps Desk")))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x40;
  const until = new Date(now.getTime() + 10 * 365 * 86_400_000);
  const san = seq(...[...new Set(names)].map((n) => (isIP(n) === 4 ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n)))));
  const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    sigAlg,
    name,
    seq(utc(now), utc(until)),
    name,
    spki,
    tlv(0xa3, seq(ext("2.5.29.19", true, seq(tlv(0x01, Buffer.from([0xff])))), ext("2.5.29.17", false, san))),
  );
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;
  return { cert, pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

// The host names and addresses a desk certificate covers.
export function certNames(certPem: string): string[] {
  const san = new X509Certificate(certPem).subjectAltName ?? "";
  return san.split(/,\s*/).filter(Boolean).map((e) => e.replace(/^(DNS|IP Address):/, ""));
}

// What `curl --pinnedpubkey` wants: sha256 of the certificate's public key, base64.
export function pubkeyPin(certPem: string | Buffer) {
  return createHash("sha256").update(new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
}

export function approve(s: FleetState, codeIn: string): string | null {
  const code = normCode(codeIn);
  const a = s.agents.find((x) => x.code === code && x.status === "pending");
  if (!a) return "No agent is waiting with that code. Check the code on the agent's screen, and that the agent can reach this desk.";
  if (s.agents.filter((x) => x.status === "approved").length >= s.maxAgents) return `This desk allows ${s.maxAgents} agents. Raise the limit or remove one first.`;
  a.status = "approved";
  return null;
}

export function addUser(s: FleetState, name: string, maxAgents: number, agentIds: string[], now = Date.now()): FleetUser {
  const u: FleetUser = { id: newId(), name: name.trim().slice(0, 60) || "User", maxAgents: Math.max(0, Math.floor(maxAgents) || 0), agentIds, code: newCode(), createdAt: now };
  s.users.push(u);
  return u;
}

// One-time: the code becomes a token on the device that redeems it.
export function redeem(s: FleetState, codeIn: unknown, device?: unknown): { token: string; name: string } | null {
  const code = normCode(codeIn);
  const u = s.users.find((x) => x.code === code && !x.revoked);
  if (!u) return null;
  u.code = undefined;
  return { token: addDevice(u, device), name: u.name };
}

// A new signed-in device for this user; the token is returned once and only its hash is kept.
export function addDevice(u: FleetUser, device?: unknown): string {
  const token = newToken();
  (u.devices ??= []).push({ id: newId(), name: String(device ?? "device").slice(0, 60) || "device", tokenHash: hash(token), createdAt: Date.now() });
  return token;
}

// Everything a desktop worker needs to join this desk's pool, in one string the superadmin hands over:
// the address, the desk's public-key pin (so the worker trusts only this desk), and the one-time code.
export const joinKey = (url: string, pin: string, code: string) => `${url}#${pin}#${code}`;
export function parseJoinKey(key: unknown): { url: string; pin: string; code: string } | null {
  const [url, pin, code, extra] = String(key ?? "").trim().split("#");
  if (extra !== undefined || !/^https:\/\/[\w.-]+(:\d+)?$/.test(url ?? "") || !/^[A-Za-z0-9+/]{43}=$/.test(pin ?? "")) return null;
  const c = normCode(code);
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c) ? { url, pin, code: c } : null;
}

const bearer = (header: unknown) => /^Bearer (\w{64})$/.exec(String(header ?? ""))?.[1];
// Marks the device's first use, so pruneUnscanned never drops a token a person is actually using.
export const userFor = (s: FleetState, header: unknown, onFirstUse?: () => void) => {
  const t = bearer(header);
  if (!t) return undefined;
  const h = hash(t);
  for (const u of s.users) {
    if (u.revoked) continue;
    if (u.tokenHash === h) return u;
    const d = u.devices?.find((x) => x.tokenHash === h);
    if (d) {
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
  if (repo && !/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(repo)) return "Repository must be an https or ssh git address.";
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
