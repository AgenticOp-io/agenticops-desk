import { app } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CursorChat } from "./cursor";
import { run, runGit } from "./features";
import { writeJsonAtomic } from "./jsonStore";
import {
  exportLibrarySlice,
  fileNewChats,
  flushLibrary,
  importSyncedLibrary,
  importSyncedProjects,
  libraryPending,
  rememberProjectRemotes,
  type LibrarySlice,
} from "./library";
import { carryProjectMemory, memoryDirs } from "./memory";
import { applyCursorLink, cursorArchiveChats, writeCursorArchiveThreads } from "./cursorLink";
import {
  allowedGitRemote,
  cursorMode,
  mergeChats,
  matchSyncedProjects,
  mergeDeleted,
  mergeProjects,
  oneAtATime,
  portablePrefs,
  remoteKey,
  type CursorMode,
  type SyncChat,
  type SyncProject,
} from "./pureFeatures";
import { privacyVault } from "./privacy";
import { hideForSync, hideThreadForSync } from "./redact";
import { loadSettings, patchSettings, type UiPrefs } from "./settings";

// The desk's own copy of chats, memory and settings. Project source stays in each project's repo.
// shortcut: two computers editing the same chat at the same moment can conflict on that one file; the error is shown and nothing is force-pushed.
// A project travels by its permanent ID. Its folder is per computer, and its remotes are only a clue to which folder it is.

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const SYNC_REPO = "desk-sync";

export type SyncView = {
  url: string;
  ok: boolean;
  note: string;
  cursor: CursorMode;
  projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
};

let applying = false;
let queued: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;
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

function emptyView(url: string, note = lastNote, ok = lastOk, cursor: CursorMode = "off"): SyncView {
  return { url, ok, note, cursor, projects: [] };
}

async function modeNow(): Promise<CursorMode> {
  return cursorMode((await loadSettings()).cursorIntegration);
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
    return !!item && THREAD_ID.test(String(item.id)) && typeof item.name === "string" && Array.isArray(item.remotes);
  });
}

function asChats(value: unknown): SyncChat[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is SyncChat => {
    const item = row as SyncChat;
    return !!item && typeof item.id === "string" && typeof item.title === "string";
  });
}

function chatToSync(chat: CursorChat): SyncChat {
  return {
    id: chat.id,
    title: hideForSync(chat.title, privacyVault().pinnedValues()),
    updatedAt: chat.updatedAt ?? 0,
    lastUsedAt: chat.lastUsedAt,
    projectId: chat.projectId ?? null,
    projectMovedAt: chat.projectMovedAt,
    // A filed chat takes its project's name on each computer; only an unfiled one carries its own.
    projectName: chat.projectId ? "" : chat.projectName,
    slug: chat.slug,
    pinned: chat.pinned,
    mode: chat.mode,
    model: chat.model,
    parentId: chat.parentId,
    size: chat.size,
  };
}

function chatFromSync(chat: SyncChat): CursorChat {
  return {
    id: chat.id,
    slug: chat.slug || "",
    projectId: chat.projectId ?? undefined,
    projectMovedAt: chat.projectMovedAt,
    projectPath: null,
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

export async function remoteOfPath(dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const res = await runGit(dir, ["remote", "get-url", "origin"]);
  if (!res.ok) return null;
  const url = res.output.split("\n")[0]?.trim() ?? "";
  return remoteKey(url) ? url : null;
}

// Remembered while the folder exists: once it is moved or deleted, this is what can recognize it again.
export async function refreshProjectRemotes() {
  const { projects } = await exportLibrarySlice();
  const found: Array<{ id: string; remote: string }> = [];
  for (const project of projects) {
    const remote = await remoteOfPath(project.path);
    if (remote) found.push({ id: project.id, remote });
  }
  await rememberProjectRemotes(found);
}

async function copyIfDifferent(from: string, to: string) {
  const bytes = await fs.readFile(from).catch(() => null);
  if (bytes) await writeIfDifferent(bytes, to);
}

// A chat in the repository has its secrets hidden; the copy on this computer keeps them.
// Unchanged files are skipped, because hiding is too slow to repeat on all of them every few minutes.
const pushedAt = new Map<string, number>();
async function pushThread(local: string, remote: string) {
  const { mtimeMs } = await fs.stat(local);
  if (pushedAt.get(local) === mtimeMs && existsSync(remote)) return;
  const messages = JSON.parse(await fs.readFile(local, "utf8")) as unknown;
  await writeIfDifferent(Buffer.from(JSON.stringify(hideThreadForSync(messages, privacyVault().pinnedValues()))), remote);
  pushedAt.set(local, mtimeMs);
}

// Writes only when the bytes differ, so a sync does not dirty the repo forever.
async function writeIfDifferent(bytes: Buffer, to: string) {
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
  // Commits here are the app's own; git refuses to commit on a computer with no name set.
  await runGit(dir, ["config", "user.name", "AgenticOps Desk"]);
  await runGit(dir, ["config", "user.email", "desk@agenticop.io"]);
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) await fs.writeFile(ignore, "*.tmp\n", "utf8");
  const attrs = path.join(dir, ".gitattributes");
  if (!existsSync(attrs)) await fs.writeFile(attrs, "* -text\n", "utf8");
  // --prune: a repository emptied or recreated on GitHub must not leave an origin/main that pull then cannot find.
  const fetched = await runGit(dir, ["fetch", "--prune", "origin"], 120_000);
  const auth = /authentication failed|permission denied|could not read username|repository not found|access denied/i.test(fetched.output);
  if (!fetched.ok && auth) return fetched;
  const origin = await runGit(dir, ["rev-parse", "--verify", "origin/main"]);
  if (!origin.ok) {
    if (!fetched.ok && !/couldn't find remote ref|no refs in common|does not appear to be a git/i.test(fetched.output)) return fetched;
    // The repository is empty and this folder's history is not chats: keep it, but never publish it there.
    if (!(await isDeskRepo(dir)).ok) {
      await fs.rename(dir, `${dir}-old-${Date.now()}`);
      return ensureRepo(dir, remote);
    }
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
    return { ok: false, output: "That repository already holds something other than chats. Clear the address to have a new one created." };
  }
  return { ok: true, output: "" };
}

async function projectList(dir: string): Promise<SyncView["projects"]> {
  const projects = asProjects(await readJson(path.join(dir, "projects.json"), []));
  const local = new Map((await exportLibrarySlice()).projects.map((project) => [project.id, project.path]));
  return projects.map((project) => {
    const folder = local.get(project.id);
    return { id: project.id, remote: project.remotes.at(-1) ?? "", name: project.name, local: folder && existsSync(folder) ? folder : null };
  });
}

async function doSync(): Promise<SyncView> {
  const url = await config();
  applying = true;
  const dir = syncDir();
  try {
    if (libraryPending()) await flushLibrary();
    let settings = await loadSettings();
    let mode = cursorMode(settings.cursorIntegration);
    if (!url) {
      const link = await applyCursorLink({ mode, remote: "", syncDir: dir, restore: false, announce: false });
      return emptyView("", link || "Sync is off.", true, mode);
    }
    await applyCursorLink({ mode, remote: url, syncDir: dir, restore: false, announce: false });
    const ready = await ensureRepo(dir, url);
    if (!ready.ok) return await viewOf(url, false, ready.output);
    const desk = await isDeskRepo(dir);
    if (!desk.ok) return await viewOf(url, false, desk.output);

    await mergeSettings(dir);
    settings = await loadSettings();
    mode = cursorMode(settings.cursorIntegration);

    await refreshProjectRemotes();
    const incomingProjects = asProjects(await readJson(path.join(dir, "projects.json"), []));
    const incomingMerges = await readJson<Record<string, string>>(path.join(dir, "project-merges.json"), {});
    const matches = matchSyncedProjects((await exportLibrarySlice()).projects, incomingProjects);
    const carried = await importSyncedProjects(incomingProjects, { ...incomingMerges, ...matches });
    for (const pair of carried) await carryProjectMemory(pair.from, pair.to);

    const archived = mode === "off" ? [] : await cursorArchiveChats(dir);
    await fileNewChats(archived);
    const slice = await exportLibrarySlice();
    const localProjects: SyncProject[] = slice.projects.map(({ id, name, remotes }) => ({ id, name, remotes }));
    const incomingChats = asChats(await readJson(path.join(dir, "chats.json"), []));
    const incomingDeleted = await readJson<string[]>(path.join(dir, "deleted.json"), []);
    const projects = mergeProjects(incomingProjects.filter((project) => !slice.merged[project.id]), localProjects);
    const deleted = mergeDeleted(slice.deleted, Array.isArray(incomingDeleted) ? incomingDeleted : []);
    const previous = new Map(slice.chats.map((chat) => [chat.id, chat.updatedAt ?? 0]));
    const merged = mergeChats(
      slice.chats.map(chatToSync),
      [...incomingChats, ...archived.map(chatToSync)],
      deleted,
    );

    await importSyncedLibrary(merged.map(chatFromSync), deleted);
    if (mode !== "off") await writeCursorArchiveThreads(dir, new Set(deleted));
    await mergeThreadFiles(dir, merged, previous, new Set(deleted));
    await mergeMemory(slice);
    await writeSnapshot(dir, projects, merged, deleted, slice.merged);

    const status = await runGit(dir, ["status", "--porcelain"]);
    if (!status.ok) return await viewOf(url, false, status.output);
    // Commits with nothing new still go up: an earlier push failed, or the repository was emptied.
    const ahead = await runGit(dir, ["rev-list", "--count", "origin/main..HEAD"]);
    const changed = !!status.output || !ahead.ok || ahead.output !== "0";
    if (status.output) {
      const added = await runGit(dir, ["add", "-A"]);
      if (!added.ok) return await viewOf(url, false, added.output);
      const committed = await runGit(dir, ["commit", "-m", "Sync desk"]);
      if (!committed.ok && !/nothing to commit/i.test(committed.output)) return await viewOf(url, false, committed.output);
    }
    if (changed) {
      let pushed = await runGit(dir, ["push", "-u", "origin", "HEAD"], 120_000);
      if (!pushed.ok) {
        const pulled = await runGit(dir, ["pull", "--rebase", "--autostash", "origin", "main"], 120_000);
        // With no main to pull, the push's own error is the one that explains the failure.
        if (!pulled.ok) return await viewOf(url, false, /couldn't find remote ref/i.test(pulled.output) ? pushed.output : pulled.output);
        pushed = await runGit(dir, ["push", "-u", "origin", "HEAD"], 120_000);
        if (!pushed.ok) return await viewOf(url, false, pushed.output);
      }
    }
    const link = await applyCursorLink({
      mode,
      remote: url,
      syncDir: dir,
     
      restore: mode === "full",
      announce: false,
    });
    const note = changed ? "Synced." : "Already up to date.";
    return await viewOf(url, true, link ? `${note} ${link}` : note);
  } catch (err) {
    return await viewOf(url, false, err instanceof Error ? err.message : String(err));
  } finally {
    applying = false;
    // Something entered during that sync missed it.
    if (queued !== null) {
      const wait = queued;
      queued = null;
      scheduleDeskSync(wait);
    }
  }
}

async function viewOf(url: string, ok: boolean, note: string): Promise<SyncView> {
  lastOk = ok;
  lastNote = note;
  let projects: SyncView["projects"] = [];
  try {
    if (existsSync(syncDir())) projects = await projectList(syncDir());
  } catch {
    projects = [];
  }
  return { url, ok, note, cursor: await modeNow(), projects };
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
    else if (existsSync(local)) {
      // A thread that cannot be read as JSON stays out of the repository, where it could not be cleaned.
      await pushThread(local, remote).catch((err) => console.error(`AgenticOps Desk did not sync thread ${chat.id}`, err));
    }
    else if (existsSync(remote)) await copyIfDifferent(remote, local);
  }
}

async function mergeMemory(slice: LibrarySlice) {
  const root = path.join(app.getPath("userData"), "memory");
  const synced = path.join(syncDir(), "memory");
  await mergeTrees(path.join(root, "global"), path.join(synced, "global"));
  await mergeTrees(path.join(root, "orgs"), path.join(synced, "orgs"));
  for (const project of slice.projects) {
    if (!project.path || !existsSync(project.path)) continue;
    await mergeTrees(memoryDirs(project.path).project, path.join(synced, "projects", project.id));
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

async function writeSnapshot(dir: string, projects: SyncProject[], chats: SyncChat[], deleted: string[], projectMerges: Record<string, string>) {
  await writeJsonAtomic(path.join(dir, "project-merges.json"), projectMerges);
  // Sorted, so the files are identical whichever computer wrote them and nothing commits without a real change.
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  await writeJsonAtomic(path.join(dir, "projects.json"), [...projects].sort(byId));
  await writeJsonAtomic(path.join(dir, "chats.json"), [...chats].sort(byId));
  await writeJsonAtomic(path.join(dir, "deleted.json"), [...deleted].sort());
}

// A message commits as soon as it is entered. The short wait lets the chat row and its thread land in one commit.
// Saves while a reply streams wait longer: each commit stores the whole thread again, so the repository would balloon.
export const SYNC_WHILE_WORKING = 30_000;
export function scheduleDeskSync(wait = 500) {
  void config().then((url) => {
    if (!url) return;
    if (applying) {
      queued = queued === null ? wait : Math.min(queued, wait);
      return;
    }
    const at = Date.now() + wait;
    if (timer) {
      if (timerAt <= at) return;
      clearTimeout(timer);
    }
    timerAt = at;
    timer = setTimeout(() => {
      timer = null;
      void syncNow();
    }, wait);
  });
}

export const syncNow = oneAtATime(doSync);

export async function syncStatus(): Promise<SyncView> {
  const url = await config();
  const projects = existsSync(syncDir()) ? await projectList(syncDir()) : [];
  return { url, ok: lastOk, note: lastNote, cursor: await modeNow(), projects };
}

export async function setCursorIntegration(mode: string): Promise<SyncView> {
  const next = cursorMode(mode);
  await patchSettings({ cursorIntegration: next });
  const url = await config();
  await applyCursorLink({
    mode: next,
    remote: url,
    syncDir: syncDir(),
   
    restore: false,
    announce: false,
  });
  if (next !== "off" && url) {
    const view = await syncNow();
    const lead = next === "partial"
      ? "Finished Cursor chats are copied into the sync repository and shown here."
      : "Full copies those chats and adds missing ones to Cursor's list.";
    return { ...view, cursor: next, note: view.note ? `${lead} ${view.note}` : lead };
  }
  const status = await syncStatus();
  const note = next === "off" ? "Cursor is left alone." : "Turn on sync to archive Cursor chats.";
  return { ...status, ok: true, cursor: next, note };
}

export async function setSyncUrl(next: string): Promise<SyncView> {
  const trimmed = next.trim();
  const mode = await modeNow();
  if (trimmed && !allowedGitRemote(trimmed)) {
    return emptyView(urlCache, "Use an https or git@ address, or leave it empty to have a private repository created.", false, mode);
  }
  urlCache = trimmed;
  loaded = true;
  await writeJsonAtomic(configFile(), { url: trimmed });
  if (!trimmed) {
    const link = await applyCursorLink({ mode, remote: "", syncDir: syncDir(), restore: false, announce: false });
    return emptyView("", link || "Sync is off.", true, mode);
  }
  return syncNow();
}

// The address of a private repository this account can sync to, created if there is none yet.
async function findOrCreateRepo(): Promise<{ ok: boolean; output: string }> {
  const dir = syncDir();
  // One used before comes back, so turning sync off and on does not start a second repository.
  const earlier = await remoteOfPath(dir);
  if (earlier) {
    const listed = await runGit(dir, ["ls-remote", "origin"]);
    if (listed.ok && (!listed.output || (await isDeskRepo(dir)).ok)) return { ok: true, output: earlier };
  }
  const home = app.getPath("home");
  // Only a private one will do: chats must never land in a public repository that shares the name.
  const lookUp = () => run("gh", ["repo", "view", SYNC_REPO, "--json", "url,visibility", "--jq", 'select(.visibility == "PRIVATE") | .url'], home);
  let found = await lookUp();
  if (!found.ok) {
    const made = await run("gh", ["repo", "create", SYNC_REPO, "--private", "--description", "AgenticOps Desk sync: chats, memory and settings"], home);
    if (!made.ok) {
      return { ok: false, output: `Could not create a private repository. Install the GitHub CLI and run gh auth login, or paste an address in Settings. ${made.output}` };
    }
    found = await lookUp();
  }
  if (!found.ok || !found.output) return { ok: false, output: `Your GitHub account has a ${SYNC_REPO} repository that is not private. Make it private, or paste another address in Settings.` };
  // Signed in to gh does not always mean signed in to git.
  if (!(await runGit(home, ["ls-remote", found.output])).ok) await run("gh", ["auth", "setup-git"], home);
  return found;
}

export async function createSyncRepo(): Promise<SyncView> {
  const repo = await findOrCreateRepo();
  if (!repo.ok) return emptyView(urlCache, repo.output, false, await modeNow());
  return setSyncUrl(repo.output);
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
  return { ok: true, output: cloned.output || `Cloned into ${dest}`, path: dest };
}
