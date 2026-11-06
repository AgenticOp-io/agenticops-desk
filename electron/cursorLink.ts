import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { cursorHome, cursorUserDir, slugFromPath, type CursorChat } from "./cursor";
import { writeJsonAtomic } from "./jsonStore";
import { saveThread } from "./library";
import { allowedGitRemote, blankValue, cursorMode, cursorTranscript, type CursorMode } from "./pureFeatures";

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MAX_TRANSCRIPT = 8_000_000;
const MAX_RESTORE = 40;

export type CursorLinkInput = {
  mode: CursorMode;
  remote: string;
  syncDir: string;
  restore: boolean;
  announce: boolean;
};

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  close(): void;
};

function bundledPluginDir() {
  const packed = path.join(process.resourcesPath, "cursor-plugin");
  if (existsSync(path.join(packed, "scripts", "export-chat.mjs"))) return packed;
  return path.join(process.cwd(), "electron", "cursor-plugin");
}

async function installCursorPlugin() {
  const dest = path.join(cursorHome(), "plugins", "local", "cursor-sync");
  // A git checkout is the user's copy. The desk writes the preference file and leaves the checkout alone.
  if (existsSync(path.join(dest, ".git"))) return;
  const src = bundledPluginDir();
  if (!existsSync(path.join(src, "scripts", "export-chat.mjs"))) return;
  await fs.cp(src, dest, { recursive: true, force: true });
  if (process.platform === "win32") return;
  const hooksFile = path.join(dest, "hooks", "hooks.json");
  const raw = JSON.parse(await fs.readFile(hooksFile, "utf8")) as { hooks?: Record<string, Array<{ command?: string }>> };
  const command = 'node "$CURSOR_PLUGIN_ROOT/scripts/export-chat.mjs"';
  for (const name of ["stop", "sessionEnd"]) {
    for (const hook of raw.hooks?.[name] ?? []) hook.command = command;
  }
  await writeJsonAtomic(hooksFile, raw);
}

async function writeCursorConfig(input: CursorLinkInput) {
  const file = path.join(cursorHome(), "cursor-sync.json");
  // Off touches nothing unless the desk turned this on earlier. A config with no mode belongs to the standalone plugin.
  if (input.mode === "off") {
    const current = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as { mode?: unknown }).catch(() => null);
    if (!current?.mode || current.mode === "off") return;
  }
  const body: Record<string, string> = { mode: input.mode };
  if (input.mode !== "off" && allowedGitRemote(input.remote)) {
    body.remote = input.remote.trim();
    body.dir = input.syncDir;
  }
  await writeJsonAtomic(file, body);
}

function announce(mode: CursorMode) {
  if (mode === "off") return "Cursor is left alone.";
  if (mode === "partial") return "Finished Cursor chats are copied into the sync repository and shown here.";
  return "Full copies those chats and adds missing ones to Cursor's list. Quit Cursor first. A restored chat can open empty; the messages stay here.";
}

export async function cursorArchiveChats(dir: string): Promise<CursorChat[]> {
  const root = path.join(dir, "chats");
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const chats: CursorChat[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!CHAT_ID.test(id)) continue;
    const file = path.join(root, name);
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_TRANSCRIPT) continue;
    const side = await readSide(path.join(root, `${id}.json`));
    const when = Date.parse(side.at);
    const folder = side.workspace && existsSync(side.workspace) ? path.resolve(side.workspace) : "";
    let title = "Cursor chat";
    try {
      const text = await fs.readFile(file, "utf8");
      title = cursorTranscript(text).title;
    } catch {
      title = "Cursor chat";
    }
    chats.push({
      id,
      slug: folder ? slugFromPath(folder) : "cursor",
      projectPath: folder || null,
      projectName: folder ? path.basename(folder) : "Cursor",
      title,
      updatedAt: Number.isFinite(when) ? when : st.mtimeMs,
      size: st.size,
    });
  }
  return chats;
}

async function readSide(file: string): Promise<{ at: string; workspace: string }> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { at?: unknown; workspace?: unknown };
    return {
      at: typeof raw.at === "string" ? raw.at : "",
      workspace: typeof raw.workspace === "string" ? raw.workspace : "",
    };
  } catch {
    return { at: "", workspace: "" };
  }
}

export async function writeCursorArchiveThreads(dir: string, deleted: Set<string>) {
  const chats = await cursorArchiveChats(dir);
  const threads = path.join(app.getPath("userData"), "threads");
  for (const chat of chats) {
    if (deleted.has(chat.id)) continue;
    const local = path.join(threads, `${chat.id}.json`);
    if (existsSync(local)) continue;
    const file = path.join(dir, "chats", `${chat.id}.jsonl`);
    let text = "";
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = cursorTranscript(text);
    if (!parsed.messages.length) continue;
    await saveThread(chat.id, parsed.messages);
  }
}

export function cursorRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (running: boolean) => resolve(running);
    if (process.platform === "win32") {
      execFile("tasklist", ["/FI", "IMAGENAME eq Cursor.exe", "/NH"], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return done(true);
        done(/Cursor\.exe/i.test(String(stdout)));
      });
      return;
    }
    execFile("pgrep", ["-x", "Cursor"], { timeout: 8000 }, (err) => done(!err));
  });
}

function fileUriToPath(uri: string): string {
  try {
    const parsed = new URL(uri);
    let folder = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(folder)) folder = folder.slice(1);
    return path.normalize(folder);
  } catch {
    return "";
  }
}

function sameFolder(raw: string, folder: string) {
  try {
    const parsed = JSON.parse(raw) as { folder?: unknown; folders?: Array<{ path?: unknown }> };
    const want = path.resolve(folder).toLowerCase();
    const listed = [parsed.folder, ...(parsed.folders ?? []).map((item) => item?.path)];
    return listed.some((value) => {
      if (typeof value !== "string" || !value) return false;
      const asPath = value.startsWith("file:") ? fileUriToPath(value) : value;
      return !!asPath && path.resolve(asPath).toLowerCase() === want;
    });
  } catch {
    return false;
  }
}

async function workspaceIdFor(folder: string): Promise<string> {
  if (!folder) return "";
  const root = path.join(cursorUserDir(), "workspaceStorage");
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!/^[a-f0-9]{32}$/i.test(name)) continue;
    const raw = await fs.readFile(path.join(root, name, "workspace.json"), "utf8").catch(() => "");
    if (raw && sameFolder(raw, folder)) return name;
  }
  return "";
}

function fileUri(folder: string) {
  const resolved = path.resolve(folder);
  const url = pathToFileURL(resolved);
  const unix = resolved.replace(/\\/g, "/");
  return {
    $mid: 1,
    fsPath: resolved,
    _sep: process.platform === "win32" ? 1 : 0,
    external: url.href,
    path: /^[A-Za-z]:/.test(unix) ? `/${unix}` : unix,
    scheme: "file",
  };
}

function token(value: unknown) {
  return typeof value === "string" && /^[a-z]{2,16}$/.test(value) ? value : "";
}

function fillHeader(template: Record<string, unknown>, chat: CursorChat, workspaceId: string, folder: string) {
  const unified = token(template.unifiedMode) || "agent";
  const force = token(template.forceMode) || "agent";
  const location = template.agentLocation as { type?: unknown; status?: unknown } | undefined;
  const locationType = token(location?.type) || "local";
  const locationStatus = token(location?.status) || "active";
  const blank = blankValue(template) as Record<string, unknown>;
  const now = chat.updatedAt || Date.now();
  const uri = fileUri(folder);
  blank.composerId = chat.id;
  blank.name = chat.title.slice(0, 80);
  blank.subtitle = "";
  blank.createdAt = now;
  blank.lastUpdatedAt = now;
  blank.conversationCheckpointLastUpdatedAt = now;
  blank.unifiedMode = unified;
  blank.forceMode = force;
  blank.isArchived = false;
  blank.isDraft = false;
  blank.hasUnreadMessages = false;
  blank.contextUsagePercent = 0;
  blank.totalLinesAdded = 0;
  blank.totalLinesRemoved = 0;
  blank.filesChangedCount = 0;
  blank.numSubComposers = 0;
  blank.referencedPlans = [];
  blank.trackedGitRepos = [];
  blank.agentLocationHistory = [];
  blank.workspaceIdentifier = { id: workspaceId, uri };
  blank.agentLocation = { type: locationType, status: locationStatus, environment: { id: workspaceId, uri } };
  return blank;
}

async function copyTranscript(chat: CursorChat, dir: string, folder: string) {
  if (!folder) return;
  const source = path.join(dir, "chats", `${chat.id}.jsonl`);
  const dest = path.join(cursorHome(), "projects", slugFromPath(folder), "agent-transcripts", chat.id, `${chat.id}.jsonl`);
  if (path.resolve(source) === path.resolve(dest) || existsSync(dest) || !existsSync(source)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
}

// Cursor's bubble table has no index, so this never reads it. The list row is copied from a header Cursor already has.
async function restoreCursorList(dir: string): Promise<string> {
  if (await cursorRunning()) return "Quit Cursor, then choose Full again, to add chats to its list.";
  const chats = (await cursorArchiveChats(dir)).slice(0, MAX_RESTORE);
  if (!chats.length) return "";
  const dbFile = path.join(cursorUserDir(), "globalStorage", "state.vscdb");
  if (!existsSync(dbFile)) return "Cursor's chat list is not on this computer yet.";
  let db: SqliteDb | null = null;
  try {
    const sqlite = (await import("node:sqlite")) as { DatabaseSync: new (file: string) => SqliteDb };
    db = new sqlite.DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 4000");
    const templateRow = db.prepare("SELECT value FROM composerHeaders LIMIT 1").get() as { value?: string } | undefined;
    if (!templateRow?.value) return "Cursor has no chat to copy the list shape from.";
    const template = JSON.parse(templateRow.value) as Record<string, unknown>;
    let added = 0;
    for (const chat of chats) {
      // A chat whose folder is gone stays out of Cursor's list, so it is never filed under another project.
      const folder = chat.projectPath && existsSync(chat.projectPath) ? chat.projectPath : "";
      const workspaceId = await workspaceIdFor(folder);
      if (!workspaceId) continue;
      await copyTranscript(chat, dir, folder);
      const existing = db.prepare("SELECT composerId FROM composerHeaders WHERE composerId = ?").get(chat.id) as { composerId?: string } | undefined;
      if (existing?.composerId) continue;
      const now = Math.round(chat.updatedAt || Date.now());
      const value = JSON.stringify(fillHeader(template, chat, workspaceId, folder));
      db.prepare(
        "INSERT OR IGNORE INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, '')",
      ).run(chat.id, workspaceId, now, now, now, now, value);
      added += 1;
    }
    if (!added) return "";
    return `Added ${added} chat${added === 1 ? "" : "s"} to Cursor's list. If one opens empty, its messages are still in the desk.`;
  } catch (err) {
    return err instanceof Error ? err.message : "Cursor's chat list could not be updated.";
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

export async function applyCursorLink(input: CursorLinkInput): Promise<string> {
  const mode = cursorMode(input.mode);
  try {
    if (mode !== "off") await installCursorPlugin();
    await writeCursorConfig({ ...input, mode });
  } catch (err) {
    return err instanceof Error ? err.message : "Cursor integration could not be saved.";
  }
  if (mode !== "off" && !allowedGitRemote(input.remote)) {
    return input.announce ? "Save a private repository address to archive Cursor chats." : "";
  }
  const restored = mode === "full" && input.restore ? await restoreCursorList(input.syncDir) : "";
  if (!input.announce) return restored;
  return restored ? `${announce(mode)} ${restored}` : announce(mode);
}
