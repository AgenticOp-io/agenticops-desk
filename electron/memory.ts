import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { claudeMemoryDir } from "./memoryPath";
import { ownerFromRemote } from "./pureFeatures";

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
    });
    owner = ownerFromRemote(url);
  } catch {
    owner = null;
  }
  ownerCache.set(key, owner);
  return owner;
}

export function memoryDirs(workspace: string) {
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
  return `# Persistent memory (ClaudeDesk)

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
    return {
      append: instructions(dirs, workspace),
      directories: [dirs.global, ...(dirs.org ? [dirs.org] : []), dirs.project],
    };
  } catch (err) {
    console.error("ClaudeDesk could not prepare memory", err);
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
    console.error("ClaudeDesk could not prepare memory", err);
    return [];
  }
}
