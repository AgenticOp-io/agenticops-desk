import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { slugFromResolved } from "./pureFeatures";

export type CursorProject = {
  id?: string;
  name: string;
  path: string;
  slug: string;
  exists: boolean;
  chatCount: number;
  lastChatAt: number | null;
  lastUsedAt?: number;
};

export type CursorChat = {
  id: string;
  slug: string;
  projectPath: string | null;
  projectName: string;
  // The permanent project. Only an explicit move changes it; projectPath follows it.
  projectId?: string;
  projectMovedAt?: number;
  title: string;
  updatedAt: number;
  lastUsedAt?: number;
  size: number;
  pinned?: boolean;
  mode?: string;
  model?: string;
  parentId?: string;
  // Set when the user renames a chat, so a Cursor rescan never puts the old title back.
  titleLocked?: boolean;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

export type CursorChatDetail = CursorChat & {
  messages: ChatMessage[];
  files: string[];
};

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  ".vite",
  "out",
  "build",
  "coverage",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  ".cursor",
]);

export function cursorHome() {
  return path.join(os.homedir(), ".cursor");
}

export function cursorUserDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  }
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Cursor", "User");
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "Cursor", "User");
}

export function slugFromPath(abs: string): string {
  return slugFromResolved(path.resolve(abs));
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return path.normalize(p);
  } catch {
    return null;
  }
}

function skipProjectPath(p: string): boolean {
  const n = p.replace(/\//g, "\\").toLowerCase();
  if (n.includes("\\appdata\\local\\temp\\")) return true;
  if (n.includes("\\appdata\\roaming\\cursor\\backups\\")) return true;
  return false;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function foldersFromWorkspaceFile(file: string): Promise<string[]> {
  const raw = (await readJson(file)) as { folders?: Array<{ path?: string }> } | null;
  const dir = path.dirname(file);
  const out: string[] = [];
  for (const f of raw?.folders ?? []) {
    if (!f.path) continue;
    const abs = path.isAbsolute(f.path) ? f.path : path.resolve(dir, f.path);
    out.push(path.normalize(abs));
  }
  return out;
}

async function collectWorkspaceFolders(): Promise<string[]> {
  const root = path.join(cursorUserDir(), "workspaceStorage");
  const found = new Set<string>();
  let hashes: string[] = [];
  try {
    hashes = await fs.readdir(root);
  } catch {
    return [];
  }
  for (const hash of hashes) {
    const wsFile = path.join(root, hash, "workspace.json");
    if (!existsSync(wsFile)) continue;
    const j = (await readJson(wsFile)) as { folder?: string; workspace?: string } | null;
    if (j?.folder) {
      const p = fileUriToPath(j.folder);
      if (p) found.add(p);
    }
    if (j?.workspace) {
      const p = fileUriToPath(j.workspace);
      if (p && p.endsWith(".code-workspace") && existsSync(p)) {
        for (const f of await foldersFromWorkspaceFile(p)) found.add(f);
      } else if (p) found.add(p);
    }
  }
  return [...found];
}

async function listTranscripts(): Promise<Array<{ slug: string; id: string; file: string; mtime: number; size: number }>> {
  const root = path.join(cursorHome(), "projects");
  const out: Array<{ slug: string; id: string; file: string; mtime: number; size: number }> = [];
  let slugs: string[] = [];
  try {
    slugs = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    if (slug.startsWith(".")) continue;
    const tdir = path.join(root, slug, "agent-transcripts");
    if (!existsSync(tdir)) continue;
    let ids: string[] = [];
    try {
      ids = await fs.readdir(tdir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = path.join(tdir, id, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      const st = statSync(file);
      out.push({ slug, id, file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function titleFromUserText(text: string): string {
  const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  let t = (q?.[1] ?? text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 80) t = `${t.slice(0, 77)}…`;
  return t || "Untitled chat";
}

function displayText(text: string): string {
  const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (q?.[1]) return q[1].trim();
  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "")
    .replace(/<\/?user_query>/gi, "")
    .trim();
}

type ComposerHeader = {
  name?: string;
  subtitle?: string;
  lastUpdatedAt?: number;
  createdAt?: number;
  isDraft?: boolean;
  isProject?: boolean;
  workspaceIdentifier?: { id?: string; uri?: { fsPath?: string } };
};

type SqliteDb = {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
  close: () => void;
};
type SqliteModule = { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => SqliteDb };
type SqlRow = Record<string, unknown>;

function composerDbPath() {
  return path.join(cursorUserDir(), "globalStorage", "state.vscdb");
}

let importError: string | null = null;

export function cursorImportError() {
  return importError;
}

let sqliteModule: Promise<SqliteModule | null> | null = null;

// Electron's bundled Node may not ship node:sqlite; fall back to the system node in that case.
function inProcessSqlite(): Promise<SqliteModule | null> {
  sqliteModule ??= import("node:sqlite")
    .then((m) => m as unknown as SqliteModule)
    .catch((err) => {
      console.error("node:sqlite unavailable in this runtime, using system node", err);
      return null;
    });
  return sqliteModule;
}

const CHILD_QUERY = `
const { DatabaseSync } = require("node:sqlite");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const { file, sql, params } = JSON.parse(input);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(sql).all(...params).map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[k] = v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : v;
      return o;
    });
    process.stdout.write(JSON.stringify(rows));
  } finally {
    db.close();
  }
});
`;

function runNodeQuery(flags: string[], payload: string): Promise<SqlRow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [...flags, "-e", CHILD_QUERY], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code !== 0) return reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(" ") || `node exited ${code}`));
      try {
        resolve(JSON.parse(out) as SqlRow[]);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(payload);
  });
}

async function queryCursorDb(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
  const file = composerDbPath();
  if (!existsSync(file)) return [];
  const sqlite = await inProcessSqlite();
  if (sqlite) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all(...params) as SqlRow[];
    } finally {
      db.close();
    }
  }
  const payload = JSON.stringify({ file, sql, params });
  try {
    return await runNodeQuery([], payload);
  } catch (first) {
    // Node 22.5-22.12 keeps sqlite behind a flag.
    try {
      return await runNodeQuery(["--experimental-sqlite"], payload);
    } catch {
      throw first;
    }
  }
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function headerProject(header: ComposerHeader): { path: string | null; name: string; slug: string } {
  const fsPath = header.workspaceIdentifier?.uri?.fsPath;
  const id = header.workspaceIdentifier?.id ?? "";
  if (!fsPath || id === "empty-window") {
    return { path: null, name: "Agents", slug: "empty-window" };
  }
  const resolved = path.normalize(fsPath);
  return {
    path: resolved,
    name: path.basename(resolved) || resolved,
    slug: slugFromPath(resolved),
  };
}

async function listComposerChats(): Promise<CursorChat[]> {
  let rows: Array<{ composerId?: string; lastUpdatedAt?: number; value?: unknown }> = [];
  try {
    rows = (await queryCursorDb(
      `SELECT composerId, lastUpdatedAt, value
       FROM composerHeaders
       WHERE isSubagent = 0`,
    )) as Array<{ composerId?: string; lastUpdatedAt?: number; value?: unknown }>;
    const chats: CursorChat[] = [];
    for (const row of rows) {
      if (!row.composerId) continue;
      let header: ComposerHeader;
      try {
        header = JSON.parse(sqlText(row.value) || "{}") as ComposerHeader;
      } catch {
        continue;
      }
      if (header.isProject) continue;
      const title = (header.name || "").trim();
      if (header.isDraft && !title) continue;
      const proj = headerProject(header);
      const updatedAt = Number(header.lastUpdatedAt || row.lastUpdatedAt || header.createdAt || 0);
      chats.push({
        id: row.composerId,
        slug: proj.slug,
        projectPath: proj.path,
        projectName: proj.name,
        title: title || "Untitled chat",
        updatedAt,
        size: 0,
      });
    }
    return chats;
  } catch (err) {
    console.error("AgenticOps Desk could not read Cursor chats", err);
    return [];
  }
}

async function peekTitle(file: string): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(32_768, (await fh.stat()).size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const chunk = buf.slice(0, bytesRead).toString("utf8");
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as {
          role?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        const text = row.message?.content?.find((c) => c.type === "text")?.text;
        if (row.role === "user" && text) return titleFromUserText(text);
      } catch {
        continue;
      }
    }
  } finally {
    await fh.close();
  }
  return "Untitled chat";
}

export async function listCursorProjects(): Promise<CursorProject[]> {
  const folders = await collectWorkspaceFolders();
  const transcripts = await listTranscripts();
  const bySlug = new Map<string, typeof transcripts>();
  for (const t of transcripts) {
    const key = t.slug.toLowerCase();
    const list = bySlug.get(key) ?? [];
    list.push(t);
    bySlug.set(key, list);
  }

  const projects = new Map<string, CursorProject>();
  const add = (abs: string) => {
    const resolved = path.normalize(abs);
    if (skipProjectPath(resolved)) return;
    const key = resolved.toLowerCase();
    if (projects.has(key)) return;
    const slug = slugFromPath(resolved);
    const chats = bySlug.get(slug.toLowerCase()) ?? [];
    const last = chats.reduce((m, c) => Math.max(m, c.mtime), 0);
    projects.set(key, {
      name: path.basename(resolved) || resolved,
      path: resolved,
      slug,
      exists: existsSync(resolved),
      chatCount: chats.length,
      lastChatAt: last || null,
    });
  };

  for (const f of folders) add(f);
  try {
    for (const chat of await listComposerChats()) {
      if (chat.projectPath) add(chat.projectPath);
    }
  } catch {
    /* transcript projects still show */
  }

  for (const [slug, chats] of bySlug) {
    const already = [...projects.values()].some((p) => p.slug.toLowerCase() === slug.toLowerCase());
    if (already) continue;
    const last = chats.reduce((m, c) => Math.max(m, c.mtime), 0);
    projects.set(`slug:${slug}`, {
      name: slug === "empty-window" ? "No project" : slug.split("-").slice(-1)[0] || slug,
      path: "",
      slug,
      exists: false,
      chatCount: chats.length,
      lastChatAt: last || null,
    });
  }

  return [...projects.values()].sort((a, b) => {
    const ae = Number(a.exists);
    const be = Number(b.exists);
    if (ae !== be) return be - ae;
    return (b.lastChatAt ?? 0) - (a.lastChatAt ?? 0) || a.name.localeCompare(b.name);
  });
}

export async function listCursorChats(projectPath?: string): Promise<CursorChat[]> {
  const projects = await listCursorProjects();
  const bySlug = new Map(projects.filter((p) => p.slug).map((p) => [p.slug.toLowerCase(), p]));
  const transcripts = await listTranscripts();
  const wantSlug = projectPath ? slugFromPath(projectPath).toLowerCase() : null;
  const selected = transcripts.filter((t) => !wantSlug || t.slug.toLowerCase() === wantSlug);
  const rows = await Promise.all(
    selected.map(async (t) => {
      try {
        const proj = bySlug.get(t.slug.toLowerCase());
        return {
          id: t.id,
          slug: t.slug,
          projectPath: proj?.path || null,
          projectName: proj?.name || t.slug.split("-").slice(-1)[0] || t.slug,
          title: await peekTitle(t.file),
          updatedAt: t.mtime,
          size: t.size,
        } satisfies CursorChat;
      } catch {
        return {
          id: t.id,
          slug: t.slug,
          projectPath: null,
          projectName: t.slug.split("-").slice(-1)[0] || t.slug,
          title: "Untitled chat",
          updatedAt: t.mtime,
          size: t.size,
        } satisfies CursorChat;
      }
    }),
  );
  const byId = new Map<string, CursorChat>();
  for (const row of rows) byId.set(row.id, row);
  const wantPath = projectPath ? path.normalize(projectPath).toLowerCase() : null;
  for (const chat of await listComposerChats()) {
    if (wantSlug && chat.slug.toLowerCase() !== wantSlug) continue;
    if (wantPath && (chat.projectPath || "").toLowerCase() !== wantPath) continue;
    const prev = byId.get(chat.id);
    if (!prev) {
      byId.set(chat.id, chat);
      continue;
    }
    byId.set(chat.id, {
      ...prev,
      ...chat,
      slug: prev.slug || chat.slug,
      projectPath: chat.projectPath || prev.projectPath,
      projectName: chat.projectName || prev.projectName,
      title: chat.title !== "Untitled chat" ? chat.title : prev.title,
      updatedAt: Math.max(prev.updatedAt, chat.updatedAt),
      size: prev.size || chat.size,
    });
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function contentBlocks(row: {
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
}): Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> {
  return row.message?.content ?? [];
}

function collectFilesFromUnknown(value: unknown, into: Set<string>) {
  if (typeof value === "string") {
    if (/^[A-Za-z]:[\\/]/.test(value) && value.length < 400 && !value.includes("\n")) {
      into.add(path.normalize(value));
    }
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const key of ["path", "file_path", "target_directory", "rootPath"]) {
      collectFilesFromUnknown(rec[key], into);
    }
  }
}

export async function readCursorChat(slug: string, id: string): Promise<CursorChatDetail | null> {
  const file = path.join(cursorHome(), "projects", slug, "agent-transcripts", id, `${id}.jsonl`);
  if (!existsSync(file)) return readComposerBubbles(id, slug);
  const st = statSync(file);
  const projects = await listCursorProjects();
  const proj = projects.find((p) => p.slug.toLowerCase() === slug.toLowerCase());
  const messages: ChatMessage[] = [];
  const files = new Set<string>();
  let title = "Untitled chat";

  type Row = {
    role?: string;
    message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
  };
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }) });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Row;
    try {
      row = JSON.parse(trimmed) as Row;
    } catch {
      continue;
    }
    const blocks = contentBlocks(row);
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) texts.push(b.text);
      if (b.type === "tool_use") {
        collectFilesFromUnknown(b.input, files);
        if (b.name) {
          const p = b.input && typeof b.input.path === "string" ? String(b.input.path) : "";
          if (p) files.add(path.normalize(p));
        }
      }
    }
    const text = texts.map(displayText).filter(Boolean).join("\n").trim();
    if (row.role === "user" && text) {
      if (title === "Untitled chat") title = titleFromUserText(texts.join("\n"));
      messages.push({ role: "user", text: text.slice(0, 12_000) });
    } else if (row.role === "assistant" && text) {
      messages.push({ role: "assistant", text: text.slice(0, 12_000) });
    }
  }

  const existing = [...files].filter((p) => existsSync(p) && statSync(p).isFile()).slice(0, 60);
  const kept = trimMessages(messages);

  return {
    id,
    slug,
    projectPath: proj?.path || null,
    projectName: proj?.name || slug.split("-").slice(-1)[0] || slug,
    title,
    updatedAt: st.mtimeMs,
    size: st.size,
    messages: kept,
    files: existing,
  };
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 80) return messages;
  return [
    messages[0],
    { role: "system", text: `… ${messages.length - 79} earlier messages omitted …` },
    ...messages.slice(-78),
  ];
}

async function readComposerBubbles(id: string, slug: string): Promise<CursorChatDetail | null> {
  try {
    const head = (await queryCursorDb("SELECT value FROM cursorDiskKV WHERE key = ?", [`composerData:${id}`]))[0] as
      | { value?: unknown }
      | undefined;
    if (!head) return null;
    const data = JSON.parse(sqlText(head.value) || "{}") as ComposerHeader & {
      fullConversationHeadersOnly?: Array<{ bubbleId?: string; type?: number }>;
      subtitle?: string;
    };
    const headers = data.fullConversationHeadersOnly ?? [];
    const picked = headers.length > 120 ? [headers[0], ...headers.slice(-119)] : headers;
    const messages: ChatMessage[] = [];
    for (const item of picked) {
      if (!item?.bubbleId) continue;
      const row = (await queryCursorDb("SELECT value FROM cursorDiskKV WHERE key = ?", [`bubbleId:${id}:${item.bubbleId}`]))[0] as
        | { value?: unknown }
        | undefined;
      if (!row) continue;
      let body: { type?: number; text?: string };
      try {
        body = JSON.parse(sqlText(row.value) || "{}") as { type?: number; text?: string };
      } catch {
        continue;
      }
      const text = (body.text || "").trim();
      if (!text) continue;
      const role = body.type === 1 || item.type === 1 ? "user" : "assistant";
      messages.push({ role, text: text.slice(0, 12_000) });
    }
    if (!messages.length) return null;
    const proj = headerProject(data);
    return {
      id,
      slug: slug || proj.slug,
      projectPath: proj.path,
      projectName: proj.name,
      title: (data.name || "").trim() || titleFromUserText(messages.find((m) => m.role === "user")?.text || ""),
      updatedAt: Number(data.lastUpdatedAt || Date.now()),
      size: 0,
      messages: trimMessages(messages),
      files: [],
    };
  } catch (err) {
    console.error("AgenticOps Desk could not read a Cursor chat", err);
    return null;
  }
}

export async function searchWorkspaceFiles(root: string, query: string, limit = 80): Promise<Array<{ name: string; path: string; rel: string }>> {
  const q = query.trim().toLowerCase();
  const hits: Array<{ name: string; path: string; rel: string; score: number }> = [];
  const maxVisit = 10_000;
  let visited = 0;

  async function walk(dir: string) {
    if (hits.length >= limit || visited >= maxVisit) return;
    let ents: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (hits.length >= limit || visited >= maxVisit) return;
      if (e.name.startsWith(".") && e.name !== ".gitignore" && e.name !== ".env") {
        if (e.isDirectory()) continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        await walk(path.join(dir, e.name));
        continue;
      }
      visited++;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      const name = e.name.toLowerCase();
      const relL = rel.toLowerCase().replace(/\\/g, "/");
      if (!q) {
        hits.push({ name: e.name, path: full, rel, score: 1 });
        continue;
      }
      if (!name.includes(q) && !relL.includes(q)) continue;
      const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
      hits.push({ name: e.name, path: full, rel, score });
    }
  }

  if (!root || !existsSync(root)) return [];
  await walk(root);
  hits.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
  return hits.slice(0, limit).map(({ name, path: p, rel }) => ({ name, path: p, rel }));
}

function clip(text: string, n: number) {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const BRIEFING_LIMIT = 60_000;

// The briefing goes straight into the prompt. Nothing is written to the project folder, so chats never end up in a repo.
export async function catchupBriefing(
  workspaceDir: string,
  chat?: { slug: string; id: string } | null,
): Promise<{ title: string; prompt: string }> {
  const parts: string[] = [];
  let title = "folder progress";
  if (chat?.slug && chat.id) {
    const detail = await readCursorChat(chat.slug, chat.id);
    if (detail) {
      title = detail.title;
      parts.push(`## Chat: ${detail.title}`, ``);
      for (const m of detail.messages) {
        if (m.role === "system") continue;
        parts.push(`### ${m.role === "user" ? "User" : "Agent"}`, clip(m.text, 2000), ``);
      }
      if (detail.files.length) {
        parts.push(`## Files touched`, ...detail.files.map((f) => `- ${f}`), ``);
      }
    }
  } else {
    const chats = await listCursorChats(workspaceDir);
    title = `${chats.length} chats`;
    parts.push(`## Recent Cursor chats in this folder`, ``);
    for (const c of chats.slice(0, 25)) {
      parts.push(`- ${c.title} (${new Date(c.updatedAt).toISOString()})`);
    }
    parts.push(``);
  }

  let briefing = parts.join("\n");
  // Keep the end of a long chat: that is where the current state is.
  if (briefing.length > BRIEFING_LIMIT) briefing = `…${briefing.slice(-BRIEFING_LIMIT)}`;
  const prompt = [
    `The user is moving work from Cursor into Claude Code in ${workspaceDir}. Below is a briefing of the prior Cursor agent work; treat it as already-done context.`,
    `<briefing>`,
    briefing,
    `</briefing>`,
    `Catch up: recap what was done, the current state, and anything unfinished. Do not redo completed work. Then wait for my next instruction.`,
  ].join("\n\n");
  return { title, prompt };
}
