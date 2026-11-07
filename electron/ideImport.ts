import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { adoptClaudeSession } from "./claude";
import type { CursorChat } from "./cursor";
import { loadThread, rememberChats, rememberProjects, saveThread } from "./library";
import { parseClaudeSession, parseCopilotSession, type ImportedChat } from "./pureFeatures";

// Chats from other tools, besides Cursor: Claude Code sessions typed in the terminal, and VS Code's chat sessions.
// Each becomes a chat in its project. Re-importing refreshes the list but never overwrites a chat continued here.
// shortcut: Windsurf keeps its history encrypted, so it isn't read.

export type ImportReport = { claudeCode: number; vscode: number };

async function files(dir: string, test: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const sub of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!sub.isDirectory()) continue;
    for (const name of await fs.readdir(path.join(dir, sub.name)).catch(() => [] as string[])) {
      if (test(name)) out.push(path.join(dir, sub.name, name));
    }
  }
  return out;
}

async function claudeCodeChats(): Promise<ImportedChat[]> {
  const found: ImportedChat[] = [];
  for (const file of await files(path.join(os.homedir(), ".claude", "projects"), (n) => n.endsWith(".jsonl"))) {
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.size > 50_000_000) continue;
    const chat = parseClaudeSession((await fs.readFile(file, "utf8")).split(/\r?\n/));
    if (chat) found.push(chat);
  }
  return found;
}

function vscodeStorage() {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? "", "Code", "User", "workspaceStorage");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  return path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage");
}

async function vscodeChats(): Promise<ImportedChat[]> {
  const found: ImportedChat[] = [];
  const root = vscodeStorage();
  for (const ws of await fs.readdir(root).catch(() => [] as string[])) {
    const sessions = path.join(root, ws, "chatSessions");
    if (!existsSync(sessions)) continue;
    let folder = "";
    try {
      const uri = (JSON.parse(await fs.readFile(path.join(root, ws, "workspace.json"), "utf8")) as { folder?: string }).folder;
      folder = uri?.startsWith("file:") ? fileURLToPath(uri) : "";
    } catch {
      continue;
    }
    if (!folder) continue;
    for (const name of await fs.readdir(sessions).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      try {
        const chat = parseCopilotSession(JSON.parse(await fs.readFile(path.join(sessions, name), "utf8")), folder, name.replace(/\.json$/, ""));
        if (chat) found.push(chat);
      } catch {
        /* a session being written right now */
      }
    }
  }
  return found;
}

// The slug stays empty: these chats aren't in Cursor's folders, so opening one reads only its saved thread.
async function file(prefix: string, chats: ImportedChat[]) {
  const rows: CursorChat[] = chats.map((c) => ({
    id: `${prefix}-${c.id}`,
    slug: "",
    projectPath: c.cwd,
    projectName: path.basename(c.cwd),
    title: c.title,
    updatedAt: c.updatedAt || Date.now(),
    size: c.messages.length,
  }));
  const folders = [...new Set(chats.map((c) => c.cwd))];
  await rememberProjects(
    folders.map((dir) => ({ name: path.basename(dir), path: dir, slug: "", exists: existsSync(dir), chatCount: 0, lastChatAt: null })),
  );
  await rememberChats(rows);
  for (const [i, c] of chats.entries()) {
    const id = rows[i].id;
    if (!(await loadThread(id))?.length) await saveThread(id, c.messages);
  }
}

export async function importOtherTools(): Promise<ImportReport> {
  const claude = await claudeCodeChats().catch(() => []);
  await file("claude", claude);
  for (const c of claude) adoptClaudeSession(`claude-${c.id}`, c.id, c.cwd);
  const vscode = await vscodeChats().catch(() => []);
  await file("vscode", vscode);
  const report = { claudeCode: claude.length, vscode: vscode.length };
  await fs.writeFile(path.join(app.getPath("userData"), "tools-import.json"), JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2), "utf8");
  return report;
}
