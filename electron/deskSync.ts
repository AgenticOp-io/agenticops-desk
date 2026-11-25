import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CursorChat } from "./cursor";
import { run, runGit } from "./features";
import { loadGitIdentity } from "./gitIdentity";
import { writeJsonAtomic } from "./jsonStore";
import {
  exportLibrarySlice,
  fileNewChats,
  flushLibrary,
  importSyncedLibrary,
  importSyncedProjects,
  libraryPending,
  locateProject,
  rememberProjectRemotes,
  type LibrarySlice,
} from "./library";
import { carryProjectMemory, memoryDirs } from "./memory";
import { applyCursorLink, cursorArchiveChats, writeCursorArchiveThreads } from "./cursorLink";
import {
  allowedGitRemote,
  asDeleted,
  cursorMode,
  mergeChats,
  matchLocalRepos,
  matchSyncedProjects,
  mergeDeleted,
  mergeProjects,
  mergeThreads,
  oneAtATime,
  parsePhoneMessage,
  portablePrefs,
  remoteKey,
  type CursorMode,
  type SyncChat,
  type SyncProject,
} from "./pureFeatures";
import { privacyVault } from "./privacy";
import { hideForSync, hideThreadForSync } from "./redact";
import { loadSettings, patchSettings, type UiPrefs } from "./settings";
import { canvasFile, deleteCanvas } from "./canvas";

// The desk's own copy of chats, memory and settings. Project source stays in each project's repo.
// Two computers changing the same chat merge by message. A push that loses the race takes the other commit and merges again.
// A project travels by its permanent ID. Its folder is per computer, and its remotes are only a clue to which folder it is.

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const SYNC_REPO = "desk-sync";
const CHAT_BRANCH = "desk-chats";

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
let scannedForRepos = false;
let linkNote = "";
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
    return !!item && THREAD_ID.test(String(item.id)) && typeof item.name === "string" && Array.isArray(item.remotes) && item.remotes.every((r) => typeof r === "string");
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
      if (entry.name === ".git" || entry.name === ".prompts" || entry.name.endsWith(".tmp") || entry.isSymbolicLink()) continue;
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

async function ensureRepo(dir: string, remote: string, branch = "main"): Promise<{ ok: boolean; output: string }> {
  await fs.mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    let init = await runGit(dir, ["init", "-b", branch]);
    if (!init.ok) {
      init = await runGit(dir, ["init"]);
      if (!init.ok) return init;
      await runGit(dir, ["checkout", "-b", branch]);
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
  // Commits here say which device made them (login-desktop); git refuses to commit on a computer with no name set.
  const who = await loadGitIdentity();
  await runGit(dir, ["config", "user.name", who.name]);
  await runGit(dir, ["config", "user.email", who.email]);
  // A link committed to the repository must stay a plain file: copied through, it would read or overwrite any file here.
  await runGit(dir, ["config", "core.symlinks", "false"]);
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) await fs.writeFile(ignore, "*.tmp\n", "utf8");
  const attrs = path.join(dir, ".gitattributes");
  if (!existsSync(attrs)) await fs.writeFile(attrs, "* -text\n", "utf8");
  // --prune: a repository emptied or recreated on GitHub must not leave an origin branch that pull then cannot find.
  const fetched = await runGit(dir, branch === "main" ? ["fetch", "--prune", "origin"] : ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120_000);
  const auth = /authentication failed|permission denied|could not read username|repository not found|access denied/i.test(fetched.output);
  if (!fetched.ok && auth) return fetched;
  const origin = await runGit(dir, ["rev-parse", "--verify", `origin/${branch}`]);
  if (!origin.ok) {
    if (!fetched.ok && !/couldn't find remote ref|no refs in common|does not appear to be a git/i.test(fetched.output)) return fetched;
    // The repository is empty and this folder's history is not chats: keep it, but never publish it there.
    if (!(await isDeskRepo(dir)).ok) {
      await fs.rename(dir, `${dir}-old-${Date.now()}`);
      return ensureRepo(dir, remote, branch);
    }
    return { ok: true, output: "" };
  }
  const head = await runGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return runGit(dir, ["reset", "--hard", `origin/${branch}`]);
  await abortStaleRebase(dir);
  const pulled = await runGit(dir, ["pull", "--rebase", "--autostash", "origin", branch], 120_000);
  if (pulled.ok || /already up to date/i.test(pulled.output)) return { ok: true, output: pulled.output };
  if (!fetched.ok) return pulled;
  return takeRemote(dir, branch);
}

// An older version could leave a rebase stopped on a conflict, and every sync after it failed.
async function abortStaleRebase(dir: string) {
  if (existsSync(path.join(dir, ".git", "rebase-merge")) || existsSync(path.join(dir, ".git", "rebase-apply"))) {
    await runGit(dir, ["rebase", "--abort"]);
  }
}

// This folder is a snapshot built from this computer's own library, threads and memory, which stay where they are.
// So a commit that conflicts with another computer's is dropped for theirs, and the next merge rebuilds it.
async function takeRemote(dir: string, branch = "main"): Promise<{ ok: boolean; output: string }> {
  await abortStaleRebase(dir);
  return runGit(dir, ["reset", "--hard", `origin/${branch}`]);
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

    // Reads what is in the folder, merges it with this computer's copy, writes it back and commits.
    // Returns whether there is anything to push, or the git error.
    const mergeAndCommit = async (): Promise<{ changed: boolean } | { error: string }> => {
      await mergeSettings(dir);
      settings = await loadSettings();
      mode = cursorMode(settings.cursorIntegration);

      await refreshProjectRemotes();
      const incomingProjects = asProjects(await readJson(path.join(dir, "projects.json"), []));
      const incomingMerges = await readJson<Record<string, string>>(path.join(dir, "project-merges.json"), {});
      const matches = matchSyncedProjects((await exportLibrarySlice()).projects, incomingProjects);
      const carried = await importSyncedProjects(incomingProjects, { ...incomingMerges, ...matches });
      for (const pair of carried) await carryProjectMemory(pair.from, pair.to);
      // Once each run: this looks through folders, and a sync happens every few minutes.
      if (!scannedForRepos) {
        scannedForRepos = true;
        linkNote = await linkLocalRepos();
      }

      const archived = mode === "off" ? [] : await cursorArchiveChats(dir);
      await fileNewChats(archived);
      const slice = await exportLibrarySlice();
      const localProjects: SyncProject[] = slice.projects.map(({ id, name, remotes }) => ({ id, name, remotes }));
      const incomingChats = asChats(await readJson(path.join(dir, "chats.json"), []));
      const incomingDeleted = asDeleted(await readJson(path.join(dir, "deleted.json"), []));
      const projects = mergeProjects(incomingProjects.filter((project) => !slice.merged[project.id]), localProjects);
      const deleted = mergeDeleted(slice.deleted, incomingDeleted);
      const previous = new Map(slice.chats.map((chat) => [chat.id, chat.updatedAt ?? 0]));
      const merged = mergeChats(
        slice.chats.map(chatToSync),
        [...incomingChats, ...archived.map(chatToSync)],
        deleted,
      );

      await importSyncedLibrary(merged.map(chatFromSync), deleted);
      if (mode !== "off") await writeCursorArchiveThreads(dir, new Set(Object.keys(deleted)));
      // A chat of a project with no git remote stays on this computer: the phone and other desks only see projects git holds.
      const offline = new Set(slice.projects.filter((p) => p.remotes.length === 0).map((p) => p.id));
      const theirIds = new Set(incomingChats.map((c) => c.id));
      const priv = await privateProjects(slice.projects);
      const shared = merged.filter((c) => !(c.projectId && (offline.has(c.projectId) || priv.has(c.projectId)) && !theirIds.has(c.id)));
      await mergeThreadFiles(dir, shared, previous, deleted);
      await mergeMemory(slice);
      await writeSnapshot(dir, projects, shared, deleted, slice.merged);

      const status = await runGit(dir, ["status", "--porcelain"]);
      if (!status.ok) return { error: status.output };
      // Commits with nothing new still go up: an earlier push failed, or the repository was emptied.
      const ahead = await runGit(dir, ["rev-list", "--count", "origin/main..HEAD"]);
      if (status.output) {
        const added = await runGit(dir, ["add", "-A"]);
        if (!added.ok) return { error: added.output };
        const committed = await runGit(dir, ["commit", "-m", "Sync desk"]);
        if (!committed.ok && !/nothing to commit/i.test(committed.output)) return { error: committed.output };
      }
      return { changed: !!status.output || !ahead.ok || ahead.output !== "0" };
    };

    let step = await mergeAndCommit();
    if ("error" in step) return await viewOf(url, false, step.error);
    const changed = step.changed;
    for (let attempt = 0; step.changed; attempt++) {
      const pushed = await runGit(dir, ["push", "-u", "origin", "HEAD"], 120_000);
      if (pushed.ok) break;
      // Another computer pushed first. Take its commit and merge again on top of it; nothing is force-pushed.
      const fetched = await runGit(dir, ["fetch", "origin"], 120_000);
      const theirs = fetched.ok && (await runGit(dir, ["rev-parse", "--verify", "origin/main"])).ok;
      if (!theirs || attempt >= 2) return await viewOf(url, false, pushed.output);
      const reset = await takeRemote(dir);
      if (!reset.ok) return await viewOf(url, false, reset.output);
      step = await mergeAndCommit();
      if ("error" in step) return await viewOf(url, false, step.error);
    }
    const branchNote = await syncProjectBranches();
    const link = await applyCursorLink({
      mode,
      remote: url,
      syncDir: dir,
      restore: mode === "full",
      announce: false,
    });
    const note = [changed ? "Synced." : "Already up to date.", linkNote, branchNote, link].filter(Boolean).join(" ");
    linkNote = "";
    return await viewOf(url, true, note);
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

// Only a GitHub repository the signed-in account can see as private holds its project's chats; anything else (public, other host,
// no gh, offline) keeps them in desk-sync. Cached for the run: it asks GitHub once per remote.
const privacyOf = new Map<string, boolean>();
async function repoIsPrivate(remote: string): Promise<boolean> {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote);
  if (!m) return false;
  const hit = privacyOf.get(remote);
  if (hit !== undefined) return hit;
  const res = await run("gh", ["api", `repos/${m[1]}/${m[2]}`, "--jq", ".private"], app.getPath("home"));
  if (!res.ok) return false;
  const priv = res.output.trim() === "true";
  privacyOf.set(remote, priv);
  return priv;
}

async function privateProjects(projects: Array<{ id: string; remotes: string[] }>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of projects) {
    const remote = p.remotes.at(-1);
    if (remote && allowedGitRemote(remote) && (await repoIsPrivate(remote))) out.add(p.id);
  }
  return out;
}

// Where a project's chats live: its own repo's desk-chats branch when private, else the shared desk-sync repo (null remote).
export async function chatRepoOf(projectId: string): Promise<{ remote: string; branch: string } | null> {
  const project = (await exportLibrarySlice()).projects.find((p) => p.id === projectId);
  const remote = project?.remotes.at(-1);
  return remote && allowedGitRemote(remote) && (await repoIsPrivate(remote)) ? { remote, branch: CHAT_BRANCH } : null;
}

// The GitHub repos of every project this desk works on (owner/name): the pairing QR hands them to the phone, which shows only these.
// The user can deselect a desk project's repo (off) or add one by hand (added); both live in phone-repos.json in userData.
const phoneChoiceFile = () => path.join(app.getPath("userData"), "phone-repos.json");
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
export async function phoneRepoList(): Promise<Array<{ repo: string; on: boolean; added: boolean }>> {
  const choice = await readJson<{ off?: string[]; added?: string[] }>(phoneChoiceFile(), {});
  const off = new Set(choice.off ?? []);
  const added = new Set((choice.added ?? []).filter((r) => REPO_NAME.test(r)));
  const all = new Set<string>();
  for (const p of (await exportLibrarySlice()).projects) {
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(p.remotes.at(-1) ?? "");
    if (m) all.add(`${m[1]}/${m[2]}`);
  }
  for (const r of added) all.add(r);
  return [...all].map((repo) => ({ repo, on: !off.has(repo), added: added.has(repo) }));
}
export async function setPhoneRepo(repo: string, action: "on" | "off" | "add" | "remove") {
  repo = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/(\.git)?\/?$/i, "");
  if (!REPO_NAME.test(repo)) return phoneRepoList();
  const choice = await readJson<{ off?: string[]; added?: string[] }>(phoneChoiceFile(), {});
  const off = new Set(choice.off ?? []);
  const added = new Set(choice.added ?? []);
  if (action === "add") { added.add(repo); off.delete(repo); }
  else if (action === "remove") { added.delete(repo); off.add(repo); } // off too, so a desk project's repo stays gone
  else if (action === "on") off.delete(repo);
  else off.add(repo);
  await writeJsonAtomic(phoneChoiceFile(), { off: [...off], added: [...added] });
  return phoneRepoList();
}
export async function phoneRepos(): Promise<string[]> {
  return (await phoneRepoList()).filter((r) => r.on).map((r) => r.repo).slice(0, 40);
}

// Job log: one line when a chat's run starts and one when it ends, kept in jobs/<computer>.jsonl on the project's desk-chats
// branch (one file per computer, so two computers never conflict). Lines wait in userData until the next branch sync.
const running = new Set<string>();
export function noteJobEvent(chatId: string | undefined, kind: string, isRunning: boolean | undefined) {
  if (!chatId) return;
  const ev = kind === "done" ? "end" : isRunning && !running.has(chatId) ? "start" : "";
  if (!ev) return;
  if (ev === "start") running.add(chatId);
  else running.delete(chatId);
  void (async () => {
    const chat = (await exportLibrarySlice()).chats.find((c) => c.id === chatId);
    if (!chat?.projectId || !THREAD_ID.test(chat.projectId)) return;
    const file = path.join(app.getPath("userData"), "project-sync", `${chat.projectId}.jobs.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ chat: chatId, ev, at: Date.now() })}\n`);
  })().catch(() => {});
}

const hostName = () => os.hostname().replace(/[^\w.-]/g, "_");

async function flushJobs(projectId: string, dir: string) {
  const pending = path.join(app.getPath("userData"), "project-sync", `${projectId}.jobs.jsonl`);
  const lines = await fs.readFile(pending, "utf8").catch(() => "");
  if (!lines) return;
  const host = hostName();
  await fs.mkdir(path.join(dir, "jobs"), { recursive: true });
  await fs.appendFile(path.join(dir, "jobs", `${host}.jsonl`), lines);
  await fs.rm(pending, { force: true });
}

// Phone messages: the phone app writes inbox/<id>.json to the desk-chats branch; the sync hands each to the window once
// (team:send for a chat, team:start for a new one) and deletes the file, so the sync commit takes it out of the inbox.
type PhoneOrder =
  | { channel: "team:send" | "team:start"; order: { id: string; text?: string; managerId?: string; title?: string; prompt?: string } }
  | { channel: "approve"; order: { id: string; request: string; allow: boolean } }
  | { channel: "stop"; order: { id: string } };
let phoneSink: ((o: PhoneOrder) => boolean) | null = null;
export function onPhoneMessage(cb: (o: PhoneOrder) => boolean) {
  phoneSink = cb;
}
// shortcut: in memory only; a push that fails right before the app quits delivers that message again on the next start.
const delivered = new Set<string>();
// Set by main.ts: the permission prompts a phone may answer, for these chats.
let approvalSource: (chatIds: Set<string>) => Array<{ chat: string; request: string; summary: string; detail: string }> = () => [];
export function setApprovalSource(fn: typeof approvalSource) {
  approvalSource = fn;
}
// approvals/<computer>.json: what each desk is waiting on, rewritten every sync; removed when nothing waits.
async function flushApprovals(dir: string, chatIds: Set<string>) {
  const file = path.join(dir, "approvals", `${hostName()}.json`);
  const list = approvalSource(chatIds);
  if (!list.length) return void (await fs.rm(file, { force: true }));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, list);
}
// A photo from the phone is saved next to the app's data, and the message names the file so the agent can read it.
async function savePhoto(id: string, image: string): Promise<string> {
  const file = path.join(app.getPath("userData"), "phone-photos", `${id}.jpg`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(image.slice("data:image/jpeg;base64,".length), "base64"));
  return file;
}
let myLogin: string | null = null;

// Only a file the signed-in GitHub account committed runs here. shortcut: the committer comes from the commit itself, so a
// collaborator who can push to this private repo could fake it; they can already change its code, so this is not a new hole.
async function committedByMe(dir: string, remote: string, file: string): Promise<boolean> {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote);
  if (!m) return false;
  if (myLogin === null) {
    const me = await run("gh", ["api", "user", "--jq", ".login"], app.getPath("home"));
    if (!me.ok) return false;
    myLogin = me.output.trim();
  }
  const sha = (await runGit(dir, ["log", "-1", "--format=%H", "--", file])).output.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const who = await run("gh", ["api", `repos/${m[1]}/${m[2]}/commits/${sha}`, "--jq", ".committer.login"], app.getPath("home"));
  return who.ok && who.output.trim() === myLogin;
}

async function takeInbox(dir: string, remote: string, known: CursorChat[]) {
  const inbox = path.join(dir, "inbox");
  const names = await fs.readdir(inbox).catch(() => [] as string[]);
  for (const name of names) {
    const id = /^([\w-]{1,80})\.json$/.exec(name)?.[1];
    if (!id) continue;
    const file = path.join(inbox, name);
    if (!delivered.has(id)) {
      const msg = parsePhoneMessage(await readJson(file, null));
      if (msg?.host && msg.host !== hostName()) continue; // meant for another computer
      const chat = msg?.chat ? known.find((c) => c.id === msg.chat) : undefined;
      // A chat not on this computer before this sync waits a round, so the window has it before the message arrives.
      if (msg?.chat && !chat) continue;
      if (!msg || !(await committedByMe(dir, remote, `inbox/${name}`))) {
        await fs.rm(file, { force: true });
        continue;
      }
      const template = [...known].sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? 0) - (a.lastUsedAt ?? a.updatedAt ?? 0))[0];
      if (!chat && !template) continue;
      const text = msg.image ? `${msg.text}

[Photo from the phone: ${await savePhoto(id, msg.image)}]` : msg.text;
      const order: PhoneOrder = msg.approve && chat
        ? { channel: "approve", order: { id: chat.id, ...msg.approve } }
        : msg.stop && chat
          ? { channel: "stop", order: { id: chat.id } }
          : chat
            ? { channel: "team:send", order: { id: chat.id, text } }
            : { channel: "team:start", order: { id: randomUUID(), managerId: template.id, title: msg.title || "From phone", prompt: text } };
      if (!phoneSink?.(order)) continue; // window closed: try again next sync
      delivered.add(id);
    }
    await fs.rm(file, { force: true });
  }
}

// Each private project keeps its chats on a desk-chats branch of its own repository: same merge as desk-sync, one project's chats only.
// The branch lives in a separate clone under userData, never in the project folder.
async function syncProjectBranches(): Promise<string> {
  const slice = await exportLibrarySlice();
  const priv = await privateProjects(slice.projects);
  const failed: string[] = [];
  for (const project of slice.projects) {
    if (!priv.has(project.id) || !THREAD_ID.test(project.id)) continue;
    const dir = path.join(app.getPath("userData"), "project-sync", project.id);
    const mine = (await exportLibrarySlice()).chats.filter((c) => c.projectId === project.id);
    const attempt = async (): Promise<string> => {
      const ready = await ensureRepo(dir, project.remotes.at(-1)!, CHAT_BRANCH);
      if (!ready.ok) return ready.output;
      const incoming = asChats(await readJson(path.join(dir, "chats.json"), [])).filter((c) => c.projectId === project.id);
      const deleted = asDeleted(await readJson(path.join(dir, "deleted.json"), []));
      const previous = new Map(mine.map((c) => [c.id, c.updatedAt ?? 0]));
      const merged = mergeChats(mine.map(chatToSync), incoming, deleted);
      await importSyncedLibrary(merged.map(chatFromSync), deleted);
      await mergeThreadFiles(dir, merged, previous, deleted);
      await writeJsonAtomic(path.join(dir, "chats.json"), [...merged].sort((a, b) => (a.id < b.id ? -1 : 1)));
      await writeJsonAtomic(path.join(dir, "deleted.json"), deleted);
      await flushJobs(project.id, dir);
      await takeInbox(dir, project.remotes.at(-1)!, mine);
      await flushApprovals(dir, new Set(mine.map((c) => c.id)));
      await runGit(dir, ["add", "-A"]);
      const committed = await runGit(dir, ["commit", "-m", "Sync chats"]);
      if (!committed.ok && !/nothing to commit/i.test(committed.output)) return committed.output;
      const pushed = await runGit(dir, ["push", "-u", "origin", `HEAD:${CHAT_BRANCH}`], 120_000);
      return pushed.ok ? "" : pushed.output;
    };
    let err = await attempt();
    // Another computer pushed first: take its commit and merge again on top of it.
    if (err && (await runGit(dir, ["fetch", "origin", `+refs/heads/${CHAT_BRANCH}:refs/remotes/origin/${CHAT_BRANCH}`])).ok) {
      await takeRemote(dir, CHAT_BRANCH);
      err = await attempt();
    }
    if (err) failed.push(`${project.name}: ${err.split("\n").pop()}`);
  }
  return failed.length ? `Chats not synced to their repository: ${failed.join("; ")}` : "";
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

async function mergeThreadFiles(dir: string, chats: SyncChat[], previous: Map<string, number>, deleted: Record<string, number>) {
  const localDir = path.join(app.getPath("userData"), "threads");
  const remoteDir = path.join(dir, "threads");
  await fs.mkdir(localDir, { recursive: true });
  await fs.mkdir(remoteDir, { recursive: true });
  for (const [id, at] of Object.entries(deleted)) {
    if (!THREAD_ID.test(id) || !(at > 0)) continue;
    // Only delete if the deletion is not older than the chat on this computer; a stale tombstone must not
    // wipe a thread that was updated after it.
    const local = path.join(localDir, `${id}.json`);
    if (at < (previous.get(id) ?? 0)) {
      delete deleted[id];
      continue;
    }
    await fs.rm(local, { force: true }).catch(() => undefined);
    await fs.rm(path.join(remoteDir, `${id}.json`), { force: true }).catch(() => undefined);
    await deleteCanvas(id);
    await fs.rm(path.join(dir, "canvas", `${id}.json`), { force: true }).catch(() => undefined);
  }
  for (const chat of chats) {
    if (!THREAD_ID.test(chat.id)) continue;
    const local = path.join(localDir, `${chat.id}.json`);
    const remote = path.join(remoteDir, `${chat.id}.json`);
    const remoteNewer = (chat.updatedAt ?? 0) > (previous.get(chat.id) ?? 0);
    if (existsSync(local) && existsSync(remote)) {
      await mergeOneThread(local, remote, remoteNewer).catch((err) => console.error(`AgenticOps Desk did not sync thread ${chat.id}`, err));
    } else if (existsSync(local)) {
      // A thread that cannot be read as JSON stays out of the repository, where it could not be cleaned.
      await pushThread(local, remote).catch((err) => console.error(`AgenticOps Desk did not sync thread ${chat.id}`, err));
    }
    else if (existsSync(remote)) await copyIfDifferent(remote, local);
    await syncCanvas(chat.id, dir, remoteNewer).catch((err) => console.error(`AgenticOps Desk did not sync canvas ${chat.id}`, err));
  }
}

// The Canvas document of a chat (canvas/<id>.json) is one whole file, not merged. A canvas edited on this
// computer since the last sync is pushed; otherwise the synced copy is taken. Remote file times are useless
// (a pull rewrites them), so the local edit is judged by the mtime this sync last saw.
async function syncCanvas(id: string, dir: string, remoteNewer: boolean) {
  const local = canvasFile(id);
  const remote = path.join(dir, "canvas", `${id}.json`);
  const hasLocal = existsSync(local);
  const seen = pushedAt.get(local);
  // First sync since start: no record, so fall back to which side's chat changed last.
  const localEdited = hasLocal && (seen === undefined ? !remoteNewer : (await fs.stat(local)).mtimeMs !== seen);
  if (existsSync(remote) && !localEdited) await copyIfDifferent(remote, local);
  else if (hasLocal) {
    const doc = JSON.parse(await fs.readFile(local, "utf8")) as unknown;
    await writeIfDifferent(Buffer.from(JSON.stringify(hideThreadForSync(doc, privacyVault().pinnedValues()))), remote);
  }
  if (existsSync(local)) pushedAt.set(local, (await fs.stat(local)).mtimeMs);
}

// Both copies exist: merge by message, so two computers adding to one chat both keep their turns.
async function mergeOneThread(local: string, remote: string, remoteNewer: boolean) {
  const { mtimeMs } = await fs.stat(local);
  if (pushedAt.get(local) === mtimeMs && !remoteNewer) return;
  const [localBytes, remoteBytes] = await Promise.all([fs.readFile(local), fs.readFile(remote)]);
  const mine = JSON.parse(localBytes.toString("utf8")) as unknown;
  const theirs = JSON.parse(remoteBytes.toString("utf8")) as unknown;
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return pushThread(local, remote);
  const pinned = privacyVault().pinnedValues();
  const merged = mergeThreads(mine, hideThreadForSync(mine, pinned), theirs, remoteNewer);
  if (merged !== mine) await writeIfDifferent(Buffer.from(JSON.stringify(merged, null, 0)), local);
  await writeIfDifferent(Buffer.from(JSON.stringify(hideThreadForSync(merged, pinned))), remote);
  pushedAt.set(local, (await fs.stat(local)).mtimeMs);
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

async function writeSnapshot(dir: string, projects: SyncProject[], chats: SyncChat[], deleted: Record<string, number>, projectMerges: Record<string, string>) {
  await writeJsonAtomic(path.join(dir, "project-merges.json"), projectMerges);
  // Sorted, so the files are identical whichever computer wrote them and nothing commits without a real change.
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  await writeJsonAtomic(path.join(dir, "projects.json"), [...projects].sort(byId));
  await writeJsonAtomic(path.join(dir, "chats.json"), [...chats].sort(byId));
  // Sorted by id so the file is stable across writers.
  await writeJsonAtomic(path.join(dir, "deleted.json"), Object.fromEntries(Object.entries(deleted).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

// Chats are not committed as each message lands. Changes share one commit, at most this often.
// Quit, startup, and Sync now still send immediately. A commit per message stored the whole thread again.
export const SYNC_BATCH_MS = 3 * 60_000;
export function scheduleDeskSync(wait = SYNC_BATCH_MS) {
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
  await letGitReach(trimmed);
  return syncNow();
}

// Signed in to gh does not always mean signed in to git, as on a computer set up moments ago.
async function letGitReach(url: string) {
  const home = app.getPath("home");
  if (/github\.com/i.test(url) && !(await runGit(home, ["ls-remote", url])).ok) await run("gh", ["auth", "setup-git"], home);
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
  // Searches the account and its organizations, so a second computer joins the repository the first one made instead
  // of splitting the chats across two. Private only: chats must never land in a public repository with the same name.
  const search = await run("gh", ["api", "user/repos", "--paginate", "--jq", `.[] | select(.private and (.name == "${SYNC_REPO}" or .name == "desksync")) | .html_url`], home, 120_000);
  let url = search.ok ? search.output.split("\n")[0]?.trim() ?? "" : "";
  if (!url) {
    const made = await run("gh", ["repo", "create", SYNC_REPO, "--private", "--description", "AgenticOps Desk sync: chats, memory and settings"], home);
    if (!made.ok) {
      return { ok: false, output: `Could not create a private repository. Install the GitHub CLI and run gh auth login, or paste an address in Settings. ${made.output}` };
    }
    url = made.output.split("\n").map((line) => line.trim()).find((line) => /^https:\/\//.test(line)) ?? "";
    if (!url) return { ok: false, output: `The repository was created, but GitHub did not say where. Paste its address in Settings. ${made.output}` };
  }
  await letGitReach(url);
  return { ok: true, output: url };
}

// Git repositories under a folder. Stops at each repository, and skips what cannot hold one or would take forever.
const SKIP_SCAN = new Set(["node_modules", "appdata", "library", "$recycle.bin", "windows", "program files", "program files (x86)"]);
async function findRepos(root: string, depth: number): Promise<Array<{ path: string; remote: string }>> {
  const out: Array<{ path: string; remote: string }> = [];
  let visited = 0;
  const walk = async (dir: string, left: number) => {
    // shortcut: gives up after 20000 folders, so a huge home folder cannot stall a sync; Find repos can aim at a smaller one.
    if (visited++ > 20_000) return;
    if (existsSync(path.join(dir, ".git"))) {
      const remote = await remoteOfPath(dir);
      if (remote) out.push({ path: dir, remote });
      return;
    }
    if (!left) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_SCAN.has(entry.name.toLowerCase())) await walk(path.join(dir, entry.name), left - 1);
    }
  };
  await walk(root, depth);
  return out;
}

async function foldersMissing() {
  return (await exportLibrarySlice()).projects.map((p) => ({ ...p, placed: Boolean(p.path) && existsSync(p.path) }));
}

// Points projects from other computers at the clones already here. Returns what it did, in words.
export async function linkLocalRepos(root?: string): Promise<string> {
  const projects = await foldersMissing();
  if (!projects.some((p) => !p.placed && p.remotes.length)) return "";
  const found = await findRepos(root ?? app.getPath("home"), root ? 4 : 3);
  const { links, unsure } = matchLocalRepos(projects, found);
  for (const link of links) {
    const carried = await locateProject(link.id, link.path);
    if (carried?.from && carried.to) await carryProjectMemory(carried.from, carried.to);
  }
  const parts = [
    links.length ? `Linked ${links.length} repositor${links.length === 1 ? "y" : "ies"} already on this computer.` : "",
    unsure.length ? `${unsure.length} matched more than one folder or project, so use Locate folder for those.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// Clones every project that has a remote and no folder here into one parent folder.
export async function cloneMissingRepos(parent: string): Promise<{ ok: boolean; output: string }> {
  const linked = await linkLocalRepos(parent);
  const seen = new Set<string>();
  const notes: string[] = linked ? [linked] : [];
  let cloned = 0;
  let shared = 0;
  const failed: string[] = [];
  for (const project of await foldersMissing()) {
    if (project.placed || !project.remotes.length) continue;
    const remote = project.remotes.at(-1)!;
    const key = remoteKey(remote) ?? remote;
    // Two projects on one repository need one clone between them; the other waits for Locate folder.
    if (seen.has(key)) {
      shared += 1;
      continue;
    }
    seen.add(key);
    const done = await cloneSyncedProject(remote, parent);
    if (!done.ok || !done.path) {
      failed.push(`${project.name}: ${done.output.split("\n").pop()}`);
      continue;
    }
    const carried = await locateProject(project.id, done.path);
    if (carried?.from && carried.to) await carryProjectMemory(carried.from, carried.to);
    cloned += 1;
  }
  if (cloned) notes.push(`Cloned ${cloned} repositor${cloned === 1 ? "y" : "ies"} into ${parent}.`);
  if (shared) notes.push(`${shared} shared a repository with another project, so use Locate folder for those.`);
  if (failed.length) notes.push(`Not cloned: ${failed.join("; ")}`);
  return { ok: !failed.length, output: notes.join(" ") || "Nothing to clone. Every project with a remote already has a folder here." };
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
