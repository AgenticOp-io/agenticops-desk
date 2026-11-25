import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { claudeMemoryDir } from "./memoryPath";
import { cliPromptEnv, ownerFromRemote } from "./pureFeatures";

// Claude's long-term memory: plain markdown files that outlive every chat, CLI session and app restart.
// global/ holds what applies everywhere (who the user is, how they like to work); projects/<slug>/ holds
// what only matters in one folder. Each scope has a MEMORY.md index that is put in front of Claude on
// every run; the topic files it points to are read on demand.

const INDEX = "MEMORY.md";
const INDEX_LIMIT = 12_000;

export function memoryRoot() {
  return path.join(app.getPath("userData"), "memory");
}

// Claude Code already reads ~/.claude/projects/<encoded-cwd>/memory. Use that folder so notes
// show up where the agent looks, instead of a private copy it never opens.
function claudeProjectMemoryDir(workspace: string): string {
  return claudeMemoryDir(workspace, os.homedir(), existsSync);
}

// The owner of the repo's origin remote ("AgenticOp-io" for github.com/AgenticOp-io/x), so projects
// from the same organization share a middle memory scope. Cached per folder; null without a remote.
const ownerCache = new Map<string, string | null>();
function orgOf(workspace: string): string | null {
  const key = path.resolve(workspace).toLowerCase();
  if (ownerCache.has(key)) return ownerCache.get(key)!;
  let owner: string | null = null;
  try {
    const url = execFileSync("git", ["-C", workspace, "remote", "get-url", "origin"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...cliPromptEnv() },
    });
    owner = ownerFromRemote(url);
  } catch {
    owner = null;
  }
  ownerCache.set(key, owner);
  return owner;
}

// A chat in its own worktree runs in a folder no other chat has used, so its project memory started empty.
// Map that folder back to the project folder the chat belongs to.
function projectFolder(workspace: string): string {
  try {
    const trees = JSON.parse(readFileSync(path.join(app.getPath("userData"), "worktrees.json"), "utf8")) as Record<string, { path: string; base: string; sub: string }>;
    const here = path.resolve(workspace).toLowerCase();
    for (const tree of Object.values(trees)) if (here === path.resolve(tree.path, tree.sub).toLowerCase()) return tree.base;
  } catch {
    // no worktrees.json: the folder is the project
  }
  return workspace;
}

export function memoryDirs(workspaceFolder: string) {
  const workspace = projectFolder(workspaceFolder);
  const root = memoryRoot();
  const org = orgOf(workspace);
  return {
    root,
    global: path.join(root, "global"),
    org: org ? path.join(root, "orgs", org) : null,
    orgName: org,
    project: claudeProjectMemoryDir(workspace),
  };
}

// A project's folder changed or two projects became one. Notes the new folder lacks come over; nothing is overwritten.
export async function carryProjectMemory(fromFolder: string, toFolder: string) {
  const from = claudeProjectMemoryDir(fromFolder);
  const to = claudeProjectMemoryDir(toFolder);
  if (from === to || !existsSync(from)) return;
  const index = path.join(to, INDEX);
  const before = existsSync(index) ? readFileSync(index, "utf8") : "";
  mkdirSync(to, { recursive: true });
  await fs.cp(from, to, { recursive: true, force: false });
  const pointers = (existsSync(path.join(from, INDEX)) ? readFileSync(path.join(from, INDEX), "utf8") : "").split(/\r?\n/).filter((line) => line.startsWith("- [") && !before.includes(line));
  if (before && pointers.length) writeFileSync(index, `${before.trimEnd()}\n${pointers.join("\n")}\n`);
}

// A search index of every past chat in this project and its worktrees: one line per transcript (date, first
// prompt, path), newest first. Rebuilt in the background on each run; the agent greps or reads it.
const CHAT_INDEX = "chats-index.md";
async function firstPrompt(file: string): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(65_536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const msg = JSON.parse(line)?.message;
        if (msg?.role !== "user") continue;
        const text = typeof msg.content === "string" ? msg.content : (msg.content ?? []).find((b: { type: string }) => b.type === "text")?.text;
        if (text && !text.startsWith("<")) return text.replace(/\s+/g, " ").trim().slice(0, 160);
      } catch {
        // cut-off last line of the 64 KB slice, or a non-JSON line
      }
    }
  } finally {
    await fh.close();
  }
  return "(no prompt found)";
}

async function writeChatIndex(workspace: string, memoryDir: string) {
  const folders = new Set([path.dirname(memoryDir)]);
  try {
    const trees = JSON.parse(readFileSync(path.join(app.getPath("userData"), "worktrees.json"), "utf8")) as Record<string, { path: string; base: string; sub: string }>;
    const base = path.resolve(workspace).toLowerCase();
    for (const t of Object.values(trees)) if (path.resolve(t.base).toLowerCase() === base) folders.add(path.dirname(claudeProjectMemoryDir(path.resolve(t.path, t.sub))));
  } catch {
    // no worktrees.json: only the project's own folder
  }
  const found: { file: string; time: number }[] = [];
  for (const dir of folders) {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) found.push({ file, time: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.time - a.time);
  // shortcut: newest 300 chats only, raise it if the index should reach further back
  const lines = await Promise.all(found.slice(0, 300).map(async (f) => `- ${new Date(f.time).toISOString().slice(0, 16)} ${await firstPrompt(f.file).catch(() => "(unreadable)")} — ${f.file}`));
  const text = `# Past chats (generated, newest first; do not edit)\n\nProject: ${workspace}\n\n${lines.join("\n")}\n`;
  const out = path.join(memoryDir, CHAT_INDEX);
  if ((await fs.readFile(out, "utf8").catch(() => "")) !== text) await fs.writeFile(out, text, "utf8");
  await writeTrainingSet(found.slice(0, 300).map((f) => f.file), path.join(memoryDir, TRAIN_SET)).catch(() => {});
}

// Fine-tuning data: prompt/response pairs (plain text only, no tool calls) from the same chats, one JSON per line.
// Stays in the project memory folder on this computer; never synced. Train from it yourself, elsewhere.
const TRAIN_SET = "chats-train.jsonl";
// shortcut: pattern-based redaction catches common key shapes only, review the file before training on it
const SECRET = /\b(?:sk-|ghp_|gho_|github_pat_|xox[bp]-|AKIA)[\w-]{8,}|\bBearer\s+[\w.~+/=-]{16,}|\{\{SECRET_\d+\}\}|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}/gi;
const textOf = (c: unknown): string => (typeof c === "string" ? c : ((c as { type: string; text?: string }[]) ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
async function writeTrainingSet(files: string[], out: string) {
  const rows: string[] = [];
  for (const file of files) {
    let prompt = "";
    let reply = "";
    const flush = () => {
      if (prompt && reply) rows.push(JSON.stringify({ messages: [{ role: "user", content: prompt.replace(SECRET, "[redacted]") }, { role: "assistant", content: reply.replace(SECRET, "[redacted]") }] }));
      reply = "";
    };
    for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
      let msg: { role?: string; content?: unknown } | undefined;
      try {
        msg = JSON.parse(line)?.message;
      } catch {
        continue;
      }
      const text = textOf(msg?.content).trim();
      if (!text || text.startsWith("<")) continue; // empty, tool-only, or injected system text
      if (msg?.role === "user") {
        flush();
        prompt = text;
      } else if (msg?.role === "assistant") reply += (reply ? "\n\n" : "") + text;
    }
    flush();
  }
  const body = rows.join("\n") + "\n";
  if ((await fs.readFile(out, "utf8").catch(() => "")) !== body) await fs.writeFile(out, body, "utf8");
}

function ensureScope(dir: string, title: string, extra = "") {
  mkdirSync(dir, { recursive: true });
  const index = path.join(dir, INDEX);
  if (!existsSync(index)) writeFileSync(index, `# ${title}\n\n${extra}`, "utf8");
}

function readIndex(dir: string) {
  try {
    const text = readFileSync(path.join(dir, INDEX), "utf8").trim();
    return text.length > INDEX_LIMIT ? `${text.slice(0, INDEX_LIMIT)}\n… (index truncated; tidy it up)` : text;
  } catch {
    return "";
  }
}

function instructions(dirs: ReturnType<typeof memoryDirs>, workspace: string) {
  return `# Persistent memory (AgenticOps Desk)

You have a long-term memory that survives across every chat, session and restart. Use it so you get better
at working with this user over time: you should never need to be told the same thing twice.

Scopes, all plain markdown you read and write with your normal file tools:
- Global (applies everywhere): ${dirs.global}${
    dirs.org
      ? `\n- Organization ${dirs.orgName} (every repo from this GitHub owner shares it: conventions, house style, shared gotchas): ${dirs.org}`
      : ""
  }
- This project (${workspace}): ${dirs.project}

Each scope has a ${INDEX} index (shown below) with one line per memory: \`- [Title](file.md) — hook\`.
Each memory is its own file with frontmatter:

\`\`\`markdown
---
name: short-kebab-slug
description: one line, used to judge relevance later
type: user | feedback | project | reference
---
The fact. For feedback/project add **Why:** and **How to apply:** lines.
\`\`\`

Types: user = who they are, their role, expertise, preferences. feedback = corrections and confirmed
approaches ("don't do X", "yes, keep doing Y"), with the reason. project = goals, decisions, constraints
and deadlines not visible in the code (write absolute dates). reference = where things live (URLs,
dashboards, tickets, commands).

When to write: as soon as you learn something durable. In particular whenever the user corrects you,
states a preference, approves a non-obvious approach, explains why something is the way it is, or you
discover a gotcha that cost you time. Do it in the same turn; don't wait to be asked. Pick the global
scope for things about the user or how they work, the project scope for things about this codebase.

How: check the index first and update an existing file instead of adding a duplicate; delete or fix
memories that turn out to be wrong or stale; add a line to the right ${INDEX} for every new file; keep
the index short (one line each, no content in it).

Don't store what the repo already records (code structure, git history, CLAUDE.md), secrets or
credentials, or things that only matter to the current conversation.

When to read: at the start of a task, scan the indexes below and open any memory that looks relevant.
Memories reflect what was true when written; if one names a file, function or flag, check it still
exists before relying on it.

Earlier chats: every past chat is a .jsonl transcript in a folder under ${path.join(os.homedir(), ".claude", "projects")}
(this project's, plus one per worktree). When the user refers to earlier work you don't have ("fix all", "that bug"),
grep those transcripts before asking. ${path.join(dirs.project, CHAT_INDEX)} lists every past chat of this project
(date, first prompt, transcript path): search it first. At the end of a chat, save any list of open work as a memory.

## Global memory index
${readIndex(dirs.global) || "(empty)"}

${dirs.org ? `## Organization (${dirs.orgName}) memory index\n${readIndex(dirs.org) || "(empty)"}\n\n` : ""}## Project memory index
${readIndex(dirs.project) || "(empty)"}
`;
}

// Prepares both memory folders and returns the system-prompt addendum for this run.
export function prepareMemory(workspace: string): { append: string; directories: string[] } {
  const dirs = memoryDirs(workspace);
  try {
    ensureScope(dirs.global, "Global memory");
    ensureScope(dirs.project, "Project memory", `Project: ${workspace}\n\n`);
    if (dirs.org) ensureScope(dirs.org, `Organization memory: ${dirs.orgName}`);
    void writeChatIndex(projectFolder(workspace), dirs.project).catch((err) => console.error("chat index failed", err));
    return {
      append: instructions(dirs, workspace),
      directories: [dirs.global, ...(dirs.org ? [dirs.org] : []), dirs.project],
    };
  } catch (err) {
    console.error("AgenticOps Desk could not prepare memory", err);
    return { append: "", directories: [] };
  }
}

// Writes the system-prompt addendum for one run and returns the CLI args that wire memory in.
export function memoryArgs(chatId: string, workspace: string): string[] {
  const prepared = prepareMemory(workspace);
  if (!prepared.append) return [];
  const dirs = memoryDirs(workspace);
  try {
    const promptDir = path.join(dirs.root, ".prompts");
    mkdirSync(promptDir, { recursive: true });
    const file = path.join(promptDir, `${chatId.replace(/[^\w.-]+/g, "_")}.md`);
    writeFileSync(file, prepared.append, "utf8");
    return ["--add-dir", dirs.project, "--append-system-prompt-file", file];
  } catch (err) {
    console.error("AgenticOps Desk could not prepare memory", err);
    return [];
  }
}
