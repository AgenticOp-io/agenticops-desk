import type { TranscriptMsg } from "../src/transcript";
import { secret } from "./secrets.ts"; // .ts so node's test runner can load it (mobile/github.test.ts)

// The phone's only link to the desk: GitHub. Sign-in is GitHub's device flow (the user approves on github.com; no token is
// typed). Each project's desk-chats branch (written by syncProjectBranches in electron/deskSync.ts) holds chats.json,
// threads/<id>.json, jobs/<computer>.jsonl, and inbox/<id>.json for messages the phone sends.
// Requests go through CapacitorHttp (capacitor.config.json), so github.com's missing CORS headers don't matter on the phone.

// The OAuth app's client ID is public, not a secret. Set it in mobile/.env as VITE_GITHUB_CLIENT_ID.
export const CLIENT_ID: string = import.meta.env?.VITE_GITHUB_CLIENT_ID ?? "";
const BRANCH = "desk-chats";
const API = "https://api.github.com";

// The token is in the Keystore vault (secrets.ts); login and id are public and stay in localStorage.
export const session = {
  token: () => secret.get("gh.token"),
  login: () => localStorage.getItem("gh.login") ?? "",
  id: () => localStorage.getItem("gh.id") ?? "",
  save(token: string, login: string, id: string) {
    secret.set("gh.token", token);
    localStorage.setItem("gh.login", login);
    localStorage.setItem("gh.id", id);
  },
  clear() {
    secret.set("gh.token", "");
    for (const k of ["gh.login", "gh.id", "gh.repos"]) localStorage.removeItem(k);
  },
};

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function startSignIn(): Promise<DeviceCode> {
  if (!CLIENT_ID) throw new Error("This build has no GitHub app client ID (VITE_GITHUB_CLIENT_ID in mobile/.env).");
  const r = await postJson("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: "repo read:user" });
  if (typeof r.device_code !== "string") throw new Error(String(r.error_description ?? r.error ?? "GitHub did not start the sign-in."));
  return r as unknown as DeviceCode;
}

// Waits until the user approves the code on github.com, then stores the token and the account it belongs to.
export async function finishSignIn(code: DeviceCode, cancelled: () => boolean): Promise<void> {
  let wait = Math.max(5, code.interval) * 1000;
  const until = Date.now() + code.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, wait));
    if (cancelled()) return;
    const r = await postJson("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: code.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof r.access_token === "string") {
      const me = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${r.access_token}` } });
      if (!me.ok) throw new Error(`GitHub said ${me.status} reading your account`);
      const user = (await me.json()) as { login: string; id: number };
      session.save(r.access_token, user.login, String(user.id));
      return;
    }
    if (r.error === "slow_down") wait += 5000;
    else if (r.error !== "authorization_pending") throw new Error(String(r.error_description ?? r.error));
  }
  throw new Error("The code expired. Start again.");
}

// The desk's pairing QR (sealPairing in electron/pureFeatures.ts): the token is encrypted under an 8-digit code the desk screen shows.
export interface PairCode { login: string; id: string; salt: string; iv: string; ct: string }
export function parsePairCode(text: string): PairCode | null {
  const m = /^ADPAIR2 ([A-Za-z0-9-]{1,39}) (\d{1,20}) ([\w-]{22})\.([\w-]{16})\.([\w-]{20,4000})$/.exec(text.trim());
  return m ? { login: m[1], id: m[2], salt: m[3], iv: m[4], ct: m[5] } : null;
}

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function openPairCode(p: PairCode, pin: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(p.salt), iterations: 300_000 }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.iv) }, key, unb64(p.ct)));
  } catch {
    throw new Error("Wrong code. Check the 8 digits on the desk.");
  }
}

// Checks the opened token with GitHub before keeping it, so a stale or foreign code never signs the phone in.
export async function signInWithPairCode(p: PairCode, pin: string): Promise<void> {
  const [token, list = "", conf = ""] = (await openPairCode(p, pin.trim())).split("\n");
  const me = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) throw new Error(me.status === 401 ? "That code no longer works. Show a new one on the desk." : `GitHub said ${me.status}`);
  const user = (await me.json()) as { login: string; id: number };
  if (String(user.id) !== p.id) throw new Error("The code doesn't match its GitHub account.");
  session.save(token, user.login, String(user.id));
  localStorage.setItem("gh.repos", list);
  // The desk's setup replaces the phone's: what the desk didn't send is removed, so re-pairing is how settings change.
  // cloud.key/cert: the phone's client certificate (base64 DER) made by the desk; the desk refuses connections without it.
  const setup = (conf ? JSON.parse(conf) : {}) as { sign?: string; ai?: string; cloud?: { url: string; token: string; pin: string; key: string; cert: string } };
  secret.set("phone.sign", typeof setup.sign === "string" && /^[\w-]{43}$/.test(setup.sign) ? setup.sign : "");
  secret.set("phone.ai", typeof setup.ai === "string" ? setup.ai : "");
  const c = setup.cloud;
  secret.set("cloud.desk", c?.url?.startsWith("https://") && c.token && c.pin && c.key && c.cert ? JSON.stringify({ url: c.url, token: c.token, pin: c.pin, key: c.key, cert: c.cert }) : "");
}

export async function api(path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${session.token()}`, Accept: accept, ...init.headers } });
  if (res.status === 401) {
    session.clear();
    throw new Error("GitHub signed this phone out. Sign in again.");
  }
  return res;
}

// Every repository the account can reach that has a desk-chats branch, with that branch's head (unchanged head = nothing new).
export async function projectRepos(): Promise<Array<{ repo: string; head: string }>> {
  const out: Array<{ repo: string; head: string }> = [];
  // Paired from the desk's QR: the repos the desk works on are the list; no scan of the whole account.
  const listed = (localStorage.getItem("gh.repos") ?? "").split(" ").filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  if (listed.length) {
    for (const repo of listed) {
      const res = await api(`/repos/${repo}/git/ref/heads/${BRANCH}`);
      // The desk controls this list, so a repo with no desk-chats branch yet still shows (empty, head "").
      if (res.ok) out.push({ repo, head: ((await res.json()) as { object: { sha: string } }).object.sha });
      else if (res.status === 404 || res.status === 409) out.push({ repo, head: "" });
    }
    return out;
  }
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await api("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($after:String){viewer{repositories(first:100,after:$after,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],ownerAffiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER]){pageInfo{hasNextPage endCursor} nodes{nameWithOwner ref(qualifiedName:"refs/heads/${BRANCH}"){target{oid}}}}}}`,
        variables: { after },
      }),
    });
    if (!res.ok) throw new Error(`GitHub said ${res.status} listing your repositories`);
    type Page = { data?: { viewer: { repositories: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Array<{ nameWithOwner: string; ref: { target: { oid: string } } | null }> } } }; errors?: Array<{ message: string }> };
    const body = (await res.json()) as Page;
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub did not list your repositories");
    const repos = body.data.viewer.repositories;
    for (const n of repos.nodes) if (n.ref) out.push({ repo: n.nameWithOwner, head: n.ref.target.oid });
    if (!repos.pageInfo.hasNextPage) break;
    after = repos.pageInfo.endCursor;
  }
  return out;
}

export type Chat = { id: string; title: string; updatedAt: number; projectId?: string; projectName?: string };
export type Job = { chat: string; ev: "start" | "end"; at: number; host: string };
// Written by phoneApprovals (electron/claude.ts). tool is absent from desks older than question support.
export type Question = { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> };
export type Approval = { chat: string; request: string; summary: string; detail: string; host: string; tool?: string; questions?: Question[] };
export type Answer = { request: string; allow: boolean; answers?: Record<string, string> };
export type Project = { repo: string; head: string; name: string; projectId?: string; chats: Chat[]; jobs: Job[]; inbox: string[]; approvals: Approval[] };

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

export async function readFile(repo: string, file: string): Promise<string | null> {
  const res = await api(`/repos/${repo}/contents/${file}?ref=${BRANCH}`, {}, "application/vnd.github.raw+json");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${repo}: GitHub said ${res.status}`);
  return res.text();
}

export async function loadProject(repo: string, head: string): Promise<Project> {
  if (!head) return { repo, head, name: repo.split("/")[1], chats: [], jobs: [], inbox: [], approvals: [] };
  const res = await api(`/repos/${repo}/git/trees/${head}?recursive=1`);
  if (!res.ok) throw new Error(`${repo}: GitHub said ${res.status}`);
  const paths = ((await res.json()) as { tree: Array<{ path: string }> }).tree.map((t) => t.path);
  const chats = (JSON.parse((await readFile(repo, "chats.json")) ?? "[]") as Chat[]).filter((c) => SAFE.test(c.id));
  const jobs: Job[] = [];
  for (const p of paths) {
    const host = /^jobs\/([\w.-]+)\.jsonl$/.exec(p)?.[1];
    if (!host) continue;
    for (const line of ((await readFile(repo, p)) ?? "").split("\n")) {
      try {
        if (line) jobs.push({ ...(JSON.parse(line) as Job), host });
      } catch {
        /* a half-written line; skip it */
      }
    }
  }
  const approvals: Approval[] = [];
  for (const p of paths) {
    const host = /^approvals\/([\w.-]+)\.json$/.exec(p)?.[1];
    if (!host) continue;
    try {
      for (const a of JSON.parse((await readFile(repo, p)) ?? "[]") as Approval[]) approvals.push({ ...a, host });
    } catch {
      /* a half-written file; skip it */
    }
  }
  const inbox = paths.flatMap((p) => /^inbox\/([\w-]+)\.json$/.exec(p)?.[1] ?? []);
  const named = chats.find((c) => c.projectName);
  return { repo, head, name: named?.projectName || repo.split("/")[1], projectId: named?.projectId, chats, jobs: jobs.sort((a, b) => b.at - a.at), inbox, approvals };
}

export type Msg = TranscriptMsg;

export async function loadThread(repo: string, chatId: string): Promise<Msg[]> {
  const raw = await readFile(repo, `threads/${chatId}.json`);
  const list = raw ? (JSON.parse(raw) as unknown) : [];
  return Array.isArray(list) ? (list as Msg[]) : [];
}

const base64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));

// Seals a message for the desk (openPhoneEnvelope in electron/pureFeatures.ts): AES-256-GCM under the desk's phone key, with
// the file ID as associated data, so nobody else with access to the repo can read, forge, edit or rename it.
export async function sealForDesk(id: string, msg: Record<string, unknown>, sign: string): Promise<string> {
  const raw = unb64(sign);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(JSON.stringify(msg))));
  const kid = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  const b64u = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return JSON.stringify({ v: 2, kid, iv: b64u(iv), ct: b64u(ct) });
}

// One file per message, so two phones (or a phone and the desk) never edit the same file. The desktop runs it and deletes it.
export async function sendMessage(repo: string, msg: { chat?: string; title?: string; text?: string; host?: string; approve?: Answer; stop?: boolean; image?: string }): Promise<string> {
  const sign = secret.get("phone.sign");
  if (!sign) throw new Error("This phone has no key for the desk. Scan the desk's code again (Settings).");
  const id = crypto.randomUUID();
  const login = session.login().replace(/[^A-Za-z0-9._-]+/g, "-") || "user";
  const body = JSON.stringify({
    message: msg.approve ? "Answer from phone" : msg.stop ? "Stop from phone" : msg.chat ? "Message from phone" : "New chat from phone",
    content: base64(await sealForDesk(id, { ...msg, at: Date.now() }, sign)),
    branch: BRANCH,
    // Same naming as the desktop's commits (deviceGitIdentity in electron/pureFeatures.ts): login-mobile, GitHub no-reply email.
    author: { name: `${login}-mobile`, email: `${session.id()}+${login}@users.noreply.github.com` },
  });
  for (let attempt = 0; ; attempt++) {
    const res = await api(`/repos/${repo}/contents/inbox/${id}.json`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (res.ok) return id;
    // 409: the desk pushed at the same moment; the file is new, so trying again is safe.
    if (res.status !== 409 || attempt >= 2) throw new Error(`GitHub said ${res.status} sending the message`);
  }
}

// A chat is running when its last job line is a start, and that start is recent (a crash leaves no end line).
export function isRunning(jobs: Job[], chatId: string): Job | undefined {
  const last = jobs.find((j) => j.chat === chatId);
  return last?.ev === "start" && Date.now() - last.at < 6 * 3600_000 ? last : undefined;
}

// Tools for the phone's own agent. Reads use the repo's default branch; writes go to a `phone-work` branch, never the default.
const WORK = "phone-work";
const repoOk = (r: string) => /^[\w.-]+\/[\w.-]+$/.test(r);
const pathOk = (f: string) => !!f && !f.startsWith("/") && !f.split("/").includes("..");

export async function listFiles(repo: string): Promise<string> {
  if (!repoOk(repo)) throw new Error("bad repo");
  const res = await api(`/repos/${repo}/git/trees/HEAD?recursive=1`);
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const t = ((await res.json()) as { tree: Array<{ path: string; type: string }> }).tree.filter((x) => x.type === "blob").map((x) => x.path);
  return t.slice(0, 500).join(String.fromCharCode(10)) + (t.length > 500 ? ` … ${t.length - 500} more` : "");
}

export async function readRepoFile(repo: string, file: string): Promise<string> {
  if (!repoOk(repo) || !pathOk(file)) throw new Error("bad path");
  let res = await api(`/repos/${repo}/contents/${file}?ref=${WORK}`, {}, "application/vnd.github.raw+json");
  if (res.status === 404) res = await api(`/repos/${repo}/contents/${file}`, {}, "application/vnd.github.raw+json");
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return (await res.text()).slice(0, 60_000);
}

export async function writeRepoFile(repo: string, file: string, content: string): Promise<string> {
  if (!repoOk(repo) || !pathOk(file)) throw new Error("bad path");
  if (!(await api(`/repos/${repo}/git/ref/heads/${WORK}`)).ok) {
    const info = (await (await api(`/repos/${repo}`)).json()) as { default_branch: string };
    const ref = (await (await api(`/repos/${repo}/git/ref/heads/${info.default_branch}`)).json()) as { object: { sha: string } };
    const made = await api(`/repos/${repo}/git/refs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${WORK}`, sha: ref.object.sha }) });
    if (!made.ok) throw new Error(`GitHub said ${made.status} creating ${WORK}`);
  }
  const cur = await api(`/repos/${repo}/contents/${file}?ref=${WORK}`);
  const sha = cur.ok ? ((await cur.json()) as { sha: string }).sha : undefined;
  const login = session.login().replace(/[^A-Za-z0-9._-]+/g, "-") || "user";
  const res = await api(`/repos/${repo}/contents/${file}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Phone agent: ${file}`, content: base64(content), branch: WORK, sha, author: { name: `${login}-mobile`, email: `${session.id()}+${login}@users.noreply.github.com` } }),
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status} writing ${file}`);
  return `Wrote ${file} to branch ${WORK}`;
}
