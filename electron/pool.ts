import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fleetPhoneLogin, fleetState, fleetSubmit } from "./fleet";
import { parseJoinKey, pubkeyPin } from "./fleetCore";
import { readJson, writeJsonAtomic } from "./jsonStore";

// A desktop worker's link to a superadmin desk's pool of cloud agents. The superadmin adds the worker and
// hands over a join key (fleetCore joinKey); this desk then sends jobs to the pool and pairs its own phone
// under that worker. TLS both ways: the desk must be signed by the desk CA in the join key and have the pinned key,
// and this desk presents the client certificate from the join key, without which the superadmin hangs up.

// cert: the superadmin's CA. clientCert/clientKeyEnc: this desk's client certificate and its key, encrypted.
type Pool = { url: string; pin: string; cert: string; clientCert?: string; clientKeyEnc?: string; name: string; tokenEnc: string };
const file = () => path.join(app.getPath("userData"), "pool.json");
let pool: Pool | null | undefined;
const load = async () => (pool === undefined ? (pool = ((await readJson(file())) as Pool | undefined) ?? null) : pool);

type Reply = { status: number; data: Record<string, unknown> };
type Tls = { pin: string; ca: string; keyPem: string; certPem: string };
function request(url: string, method: string, opts: Tls & { token?: string; body?: unknown }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = https.request(
      url,
      {
        method,
        timeout: 20_000,
        headers: { ...(payload ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        ca: opts.ca,
        key: opts.keyPem,
        cert: opts.certPem,
        minVersion: "TLSv1.3",
        checkServerIdentity: (_host, cert) => (pubkeyPin(cert.raw) === opts.pin ? undefined : new Error("The desk's key does not match the join key.")),
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          let data: Record<string, unknown> = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("The superadmin desk did not answer.")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function call(method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
  const s = await load();
  if (!s) throw new Error("This desk has not joined a cloud agent pool.");
  if (!s.clientCert || !s.clientKeyEnc) throw new Error("The superadmin desk now accepts only devices with its certificate. Ask the superadmin for a new join key and join again.");
  const dec = (v: string) => safeStorage.decryptString(Buffer.from(v, "base64"));
  const r = await request(s.url + p, method, { pin: s.pin, ca: s.cert, keyPem: dec(s.clientKeyEnc), certPem: s.clientCert, token: dec(s.tokenEnc), body });
  if (r.status >= 400) throw new Error(String(r.data.error ?? `The superadmin desk answered ${r.status}.`));
  return r.data;
}

export async function poolState() {
  const s = await load();
  return s ? { joined: true, url: s.url, name: s.name } : { joined: false };
}

export async function poolJoin(key: string): Promise<string | null> {
  const k = parseJoinKey(key);
  if (!k) return "That isn't a join key. Ask the superadmin to copy it again from Settings → Cloud agents.";
  if (!safeStorage.isEncryptionAvailable()) return "This computer can't protect the pool login, so it can't join.";
  try {
    const r = await request(`${k.url}/user/redeem`, "POST", { pin: k.pin, ca: k.caPem, keyPem: k.keyPem, certPem: k.certPem, body: { code: k.code, device: `${os.hostname()} (desktop)` } });
    if (r.status !== 200 || typeof r.data.token !== "string") return String(r.data.error ?? "The superadmin desk refused the join key.");
    const enc = (v: string) => safeStorage.encryptString(v).toString("base64");
    pool = { url: k.url, pin: k.pin, cert: k.caPem, clientCert: k.certPem, clientKeyEnc: enc(k.keyPem), name: String(r.data.name ?? ""), tokenEnc: enc(r.data.token) };
    await writeJsonAtomic(file(), pool);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// Only forgets the login here; the superadmin removes the worker on its side.
export async function poolLeave() {
  pool = null;
  await fs.rm(file(), { force: true });
}

// The phone's cloud login for this desk's QR: the superadmin's own phone user, or a phone under this worker.
// keyPem/certPem: the phone's own client certificate, which the superadmin made for it.
export async function phoneCloudLogin(): Promise<{ url: string; token: string; pin: string; keyPem: string; certPem: string } | undefined> {
  const own = await fleetPhoneLogin().catch(() => undefined);
  if (own) return own;
  const s = await load();
  if (!s) return undefined;
  const r = await call("POST", "/user/device").catch(() => undefined);
  return typeof r?.token === "string" && typeof r.keyPem === "string" && typeof r.certPem === "string" ? { url: s.url, token: r.token, pin: s.pin, keyPem: r.keyPem, certPem: r.certPem } : undefined;
}

type Agent = { id: string; name: string; os: string; online: boolean };
type Job = { id: string; status: string; prompt: string; agent?: string; costUsd: number };

// The pool this desk sends work to: its own, when it is the superadmin, otherwise the one it joined.
export async function cloudPool(): Promise<{ agents: Agent[]; jobs: Job[] }> {
  const f = await fleetState();
  if (f.on) return { agents: f.agents.filter((a) => a.status === "approved"), jobs: f.jobs };
  if (!(await load())) return { agents: [], jobs: [] };
  const me = await call("GET", "/user/me");
  return { agents: (me.agents as Agent[]) ?? [], jobs: (me.jobs as Job[]) ?? [] };
}

export async function cloudSubmit(input: { prompt: string; repo?: string; agentId?: string; model?: string }): Promise<string | null> {
  if ((await fleetState()).on) return fleetSubmit(input);
  return call("POST", "/user/jobs", input).then(() => null, (e: Error) => e.message);
}
