import { app } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CursorChat } from "./cursor";
import { runGit } from "./features";
import { writeJsonAtomic } from "./jsonStore";
import { exportLibrarySlice, flushLibrary, importSyncedLibrary, libraryPending, type LibrarySlice } from "./library";
import { memoryDirs } from "./memory";
import {
  allowedGitRemote,
  mergeChats,
  mergeDeleted,
  mergeProjects,
  portablePrefs,
  remoteKey,
  type SyncChat,
  type SyncProject,
} from "./pureFeatures";
import { loadSettings, patchSettings, type UiPrefs } from "./settings";

// The desk's own copy of chats, memory and settings. Project source stays in each project's repo.
// shortcut: two computers editing the same chat at the same moment can conflict on that one file; the error is shown and nothing is force-pushed.
// shortcut: a folder with no git remote stays on this computer.

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

export type SyncView = {
  url: string;
  ok: boolean;
  note: string;
  projects: Array<{ remote: string; name: string; local: string | null }>;
};

let syncing: Promise<SyncView> | null = null;
let queued = false;
let applying = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let urlCache = "";
let loaded = false;
let lastOk = true;
let lastNote = "";

function configFile() {
  return path.join(app.getPath("userData"), "sync-config.json");
}

function syncDir() {
  return path.join(app.getPath("userData"), "desk-sync");
}

function checkoutFile() {
  return path.join(app.getPath("userData"), "checkouts.json");
}

export function syncApplying() {
  return applying;
}

async function config(): Promise<string> {
  if (!loaded) {
    loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(configFile(), "utf8")) as { url?: string };
      urlCache = typeof raw.url === "string" ? raw.url.trim() : "";
    } catch {
      urlCache = "";
    }
  }
  return urlCache;
}

async function readCheckouts(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(checkoutFile(), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value) out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeCheckouts(map: Record<string, string>) {
  await writeJsonAtomic(checkoutFile(), map);
}

function emptyView(url: string, note = lastNote, ok = lastOk): SyncView {
  return { url, ok, note, projects: [] };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function asProjects(value: unknown): SyncProject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is SyncProject => {
    const item = row as SyncProject;
    return !!item && typeof item.remote === "string" && typeof item.name === "string";
  });
}

function asChats(value: unknown): SyncChat[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is SyncChat => {
    const item = row as SyncChat;
    return !!item && typeof item.id === "string" && typeof item.title === "string";
  });
}

function chatToSync(chat: CursorChat, remoteOf: Map<string, string>): SyncChat {
  const remote = chat.projectPath ? remoteOf.get(path.resolve(chat.projectPath).toLowerCase()) ?? null : null;
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt ?? 0,
    lastUsedAt: chat.lastUsedAt,
    projectRemote: remote,
    projectName: chat.projectName,
    slug: chat.slug,
    pinned: chat.pinned,
    mode: chat.mode,
    model: chat.model,
    parentId: chat.parentId,
    size: chat.size,
  };
}

function chatFromSync(chat: SyncChat, pathOf: Map<string, string>): CursorChat {
  const key = chat.projectRemote ? remoteKey(chat.projectRemote) : null;
  const projectPath = key ? pathOf.get(key) ?? null : null;
  return {
    id: chat.id,
    slug: chat.slug || "",
    projectPath,
    projectName: chat.projectName || "",
    title: chat.title || "Chat",
    updatedAt: chat.updatedAt || 0,
    lastUsedAt: chat.lastUsedAt,
    size: chat.size || 0,
    pinned: chat.pinned,
    mode: chat.mode,
    model: chat.model,
    parentId: chat.parentId,
  };
}

async function remoteOfPath(dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const res = await runGit(dir, ["remote", "get-url", "origin"]);
  if (!res.ok) return null;
  const url = res.output.split("\n")[0]?.trim() ?? "";
  return remoteKey(url) ? url : null;
}

async function branchOf(dir: string): Promise<string> {
  const res = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.ok ? res.output.split("\n")[0]?.trim() || "main" : "main";
}

// Copies a file only when the bytes differ, so a sync does not dirty the repo forever.
async function copyIfDifferent(from: string, to: string) {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(from);
  } catch {
    return;
  }
  try {
    const cur = await fs.readFile(to);
    if (cur.equals(bytes)) return;
  } catch {
    /* missing */
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.tmp`;
  await fs.writeFile(tmp, bytes);
  try {
    await fs.rename(tmp, to);
  } catch {
    await fs.writeFile(to, bytes);
    await fs.rm(tmp, { force: true });
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".prompts" || entry.name.endsWith(".tmp")) continue;
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk("");
  return out;
}

async function mergeTrees(local: string, synced: string) {
  const names = new Set<string>([...(await listFiles(local)), ...(await listFiles(synced))]);
  for (const rel of names) {
    const left = path.join(local, rel);
    const right = path.join(synced, rel);
    const [a, b] = await Promise.all([fs.readFile(left).catch(() => null), fs.readFile(right).catch(() => null)]);
    if (a && b) {
      if (a.equals(b)) continue;
      const [sa, sb] = await Promise.all([fs.stat(left), fs.stat(right)]);
      if (sa.mtimeMs >= sb.mtimeMs) await copyIfDifferent(left, right);
      else await copyIfDifferent(right, left);
    } else if (a) await copyIfDifferent(left, right);
    else if (b) await copyIfDifferent(right, left);
  }
}

async function ensureRepo(dir: string, remote: string): Promise<{ ok: boolean; output: string }> {
  await fs.mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    let init = await runGit(dir, ["init", "-b", "main"]);
    if (!init.ok) {
      init = await runGit(dir, ["init"]);
      if (!init.ok) return init;
      await runGit(dir, ["checkout", "-b", "main"]);
    }
    const added = await runGit(dir, ["remote", "add", "origin", remote]);
    if (!added.ok) return added;
  } else {
    const set = await runGit(dir, ["remote", "set-url", "origin", remote]);
    if (!set.ok) {
      const added = await runGit(dir, ["remote", "add", "origin", remote]);
      if (!added.ok) return added;
    }
  }
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) await fs.writeFile(ignore, "*.tmp\n", "utf8");
  const attrs = path.join(dir, ".gitattributes");
  if (!existsSync(attrs)) await fs.writeFile(attrs, "* -text\n", "utf8");
  const fetched = await runGit(dir, ["fetch", "origin"], 120_000);
  const auth = /authentication failed|permission denied|could not read username|repository not found|access denied/i.test(fetched.output);
  if (!fetched.ok && auth) return fetched;
  const origin = await runGit(dir, ["rev-parse", "--verify", "origin/main"]);
  if (!origin.ok) {
    if (!fetched.ok && !/couldn't find remote ref|no refs in common|does not appear to be a git/i.test(fetched.output)) return fetched;
    return { ok: true, output: "" };
  }
  const head = await runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return runGit(dir, ["reset", "--hard", "origin/main"]);
  const pulled = await runGit(dir, ["pull", "--rebase", "--autostash", "origin", "main"], 120_000);
  return pulled.ok || /already up to date/i.test(pulled.output) ? { ok: true, output: pulled.output } : pulled;
}

async function isDeskRepo(dir: string): Promise<{ ok: boolean; output: string }> {
  const head = await runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { ok: true, output: "" };
  if (existsSync(path.join(dir, "chats.json"))) return { ok: true, output: "" };
  const files = await runGit(dir, ["ls-tree", "-r", "--name-only", "HEAD"]);
  if (files.ok && files.output && !files.output.split("\n").includes("chats.json")) {
    return { ok: false, output: "That repository is not a desk sync repo. Create an empty private repository and use that address." };
  }
  return { ok: true, output: "" };
}

async function projectList(dir: string, checks: Record<string, string>): Promise<SyncView["projects"]> {
  const projects = asProjects(await readJson(path.join(dir, "projects.json"), []));
  return projects.map((project) => {
    const key = remoteKey(project.remote) ?? "";
    const local = key && checks[key] && existsSync(checks[key]) ? checks[key] : null;
    return { remote: project.remote, name: project.name, local };
  });
}

async function doSync(): Promise<SyncView> {
  const url = await config();
  applying = true;
  const dir = syncDir();
  try {
    if (libraryPending()) await flushLibrary();
    if (!url) return emptyView("", "Sync is off.", true);
    const ready = await ensureRepo(dir, url);
    if (!ready.ok) return await viewOf(url, false, ready.output);
    const desk = await isDeskRepo(dir);
    if (!desk.ok) return await viewOf(url, false, desk.output);

    const slice = await exportLibrarySlice();
    const remoteOf = new Map<string, string>();
    const checks = await readCheckouts();
    const localProjects: SyncProject[] = [];
    for (const project of slice.projects) {
      const remote = await remoteOfPath(project.path);
      const key = remote ? remoteKey(remote) : null;
      if (!remote || !key) continue;
      remoteOf.set(path.resolve(project.path).toLowerCase(), remote);
      checks[key] = project.path;
      localProjects.push({ remote, name: project.name, branch: await branchOf(project.path) });
    }
    await writeCheckouts(checks);

    const incomingProjects = asProjects(await readJson(path.join(dir, "projects.json"), []));
    const incomingChats = asChats(await readJson(path.join(dir, "chats.json"), []));
    const incomingDeleted = await readJson<string[]>(path.join(dir, "deleted.json"), []);
    const projects = mergeProjects(localProjects, incomingProjects);
    const deleted = mergeDeleted(slice.deleted, Array.isArray(incomingDeleted) ? incomingDeleted : []);
    const previous = new Map(slice.chats.map((chat) => [chat.id, chat.updatedAt ?? 0]));
    const merged = mergeChats(slice.chats.map((chat) => chatToSync(chat, remoteOf)), incomingChats, deleted);

    const pathOf = new Map<string, string>();
    for (const [key, folder] of Object.entries(checks)) if (existsSync(folder)) pathOf.set(key, folder);
    const localChats = merged.map((chat) => chatFromSync(chat, pathOf));
    await importSyncedLibrary(localChats, deleted, [...pathOf.values()]);
    await mergeThreadFiles(dir, merged, previous, new Set(deleted));
    await mergeMemory(slice, remoteOf);
    await mergeSettings(dir);
    await writeSnapshot(dir, projects, merged, deleted);

    const status = await runGit(dir, ["status", "--porcelain"]);
    if (!status.ok) return await viewOf(url, false, status.output);
    if (status.output) {
      const added = await runGit(dir, ["add", "-A"]);
      if (!added.ok) return await viewOf(url, false, added.output);
      const committed = await runGit(dir, ["commit", "-m", "Sync desk"]);
      if (!committed.ok && !/nothing to commit/i.test(committed.output)) return await viewOf(url, false, committed.output);
      let pushed = await runGit(dir, ["push", "-u", "origin", "HEAD"], 120_000);
      if (!pushed.ok) {
        const pulled = await runGit(dir, ["pull", "--rebase", "--autostash", "origin", "main"], 120_000);
        if (!pulled.ok) return await viewOf(url, false, pulled.output);
        pushed = await runGit(dir, ["push", "-u", "origin", "HEAD"], 120_000);
        if (!pushed.ok) return await viewOf(url, false, pushed.output);
      }
    }
    return await viewOf(url, true, status.output ? "Synced." : "Already up to date.");
  } catch (err) {
    return await viewOf(url, false, err instanceof Error ? err.message : String(err));
  } finally {
    applying = false;
  }
}

async function viewOf(url: string, ok: boolean, note: string): Promise<SyncView> {
  lastOk = ok;
  lastNote = note;
  let projects: SyncView["projects"] = [];
  try {
    if (existsSync(syncDir())) projects = await projectList(syncDir(), await readCheckouts());
  } catch {
    projects = [];
  }
  return { url, ok, note, projects };
}

async function mergeThreadFiles(dir: string, chats: SyncChat[], previous: Map<string, number>, deleted: Set<string>) {
  const localDir = path.join(app.getPath("userData"), "threads");
  const remoteDir = path.join(dir, "threads");
  await fs.mkdir(localDir, { recursive: true });
  await fs.mkdir(remoteDir, { recursive: true });
  for (const id of deleted) {
    if (!THREAD_ID.test(id)) continue;
    await fs.rm(path.join(localDir, `${id}.json`), { force: true }).catch(() => undefined);
    await fs.rm(path.join(remoteDir, `${id}.json`), { force: true }).catch(() => undefined);
  }
  for (const chat of chats) {
    if (!THREAD_ID.test(chat.id)) continue;
    const local = path.join(localDir, `${chat.id}.json`);
    const remote = path.join(remoteDir, `${chat.id}.json`);
    const remoteWon = (chat.updatedAt ?? 0) > (previous.get(chat.id) ?? 0) && existsSync(remote);
    if (remoteWon) await copyIfDifferent(remote, local);
    else if (existsSync(local)) await copyIfDifferent(local, remote);
    else if (existsSync(remote)) await copyIfDifferent(remote, local);
  }
}

async function mergeMemory(slice: LibrarySlice, remoteOf: Map<string, string>) {
  const root = path.join(app.getPath("userData"), "memory");
  const synced = path.join(syncDir(), "memory");
  await mergeTrees(path.join(root, "global"), path.join(synced, "global"));
  await mergeTrees(path.join(root, "orgs"), path.join(synced, "orgs"));
  for (const project of slice.projects) {
    const remote = remoteOf.get(path.resolve(project.path).toLowerCase());
    const key = remote ? remoteKey(remote) : null;
    if (!key) continue;
    const dirs = memoryDirs(project.path);
    await mergeTrees(dirs.project, path.join(synced, "projects", key));
  }
}

async function mergeSettings(dir: string) {
  const file = path.join(dir, "settings.json");
  const synced = await readJson<{ savedAt?: number; prefs?: Record<string, unknown> }>(file, {});
  const localFile = path.join(app.getPath("userData"), "settings.json");
  let localMtime = 0;
  try {
    localMtime = (await fs.stat(localFile)).mtimeMs;
  } catch {
    localMtime = 0;
  }
  const local = await loadSettings();
  const prefs = portablePrefs(local as unknown as Record<string, unknown>);
  if ((synced.savedAt ?? 0) > localMtime && synced.prefs) {
    await patchSettings(portablePrefs(synced.prefs) as Partial<UiPrefs>);
    return;
  }
  if (JSON.stringify(synced.prefs ?? {}) === JSON.stringify(prefs)) return;
  await writeJsonAtomic(file, { savedAt: Date.now(), prefs });
}

async function writeSnapshot(dir: string, projects: SyncProject[], chats: SyncChat[], deleted: string[]) {
  await writeJsonAtomic(path.join(dir, "projects.json"), projects);
  await writeJsonAtomic(path.join(dir, "chats.json"), chats);
  await writeJsonAtomic(path.join(dir, "deleted.json"), deleted);
}

export function scheduleDeskSync() {
  void config().then((url) => {
    if (!url || applying || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, 4000);
  });
}

export function syncNow(): Promise<SyncView> {
  if (syncing) {
    queued = true;
    return syncing.then(() => syncNow());
  }
  const run = doSync().finally(() => {
    syncing = null;
  });
  syncing = run;
  return run.then((view) => {
    if (!queued) return view;
    queued = false;
    return syncNow();
  });
}

export async function syncStatus(): Promise<SyncView> {
  const url = await config();
  const checks = await readCheckouts();
  const projects = existsSync(syncDir()) ? await projectList(syncDir(), checks) : [];
  return { url, ok: lastOk, note: lastNote, projects };
}

export async function setSyncUrl(next: string): Promise<SyncView> {
  const trimmed = next.trim();
  if (trimmed && !allowedGitRemote(trimmed)) {
    return emptyView(urlCache, "Use an https or git@ address of an empty private repository.", false);
  }
  urlCache = trimmed;
  loaded = true;
  await writeJsonAtomic(configFile(), { url: trimmed });
  if (!trimmed) return emptyView("", "Sync is off.", true);
  return syncNow();
}

export async function cloneSyncedProject(remote: string, parent: string): Promise<{ ok: boolean; output: string; path?: string }> {
  if (!allowedGitRemote(remote)) return { ok: false, output: "That address is not a git remote." };
  const name = remote.replace(/\.git$/i, "").split(/[/:]/).pop() || "";
  if (!/^[\w.-]+$/.test(name)) return { ok: false, output: "Could not name the folder from that remote." };
  if (!parent || !existsSync(parent)) return { ok: false, output: "Pick a folder to clone into." };
  const dest = path.join(parent, name);
  if (existsSync(dest)) return { ok: false, output: `${dest} already exists.` };
  const cloned = await runGit(parent, ["clone", remote, name], 300_000);
  if (!cloned.ok) return cloned;
  const key = remoteKey(remote);
  if (key) {
    const checks = await readCheckouts();
    checks[key] = dest;
    await writeCheckouts(checks);
  }
  return { ok: true, output: cloned.output || `Cloned into ${dest}`, path: dest };
}
