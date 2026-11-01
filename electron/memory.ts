import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

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
// show up where the agent looks, instead of a private copy it never opens. Claude Code names the
// folder by turning every character that is not a letter or digit into "-" (so "." "_" and spaces too).
function encodeProjectPath(p: string) {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeProjectMemoryDir(workspace: string): string {
  const resolved = path.resolve(workspace);
  const projects = path.join(os.homedir(), ".claude", "projects");
  const driveLower = resolved.replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase());
  const names = [encodeProjectPath(driveLower), encodeProjectPath(resolved)];
  for (const name of names) {
    if (existsSync(path.join(projects, name))) return path.join(projects, name, "memory");
  }
  return path.join(projects, names[0], "memory");
}

export function memoryDirs(workspace: string) {
  const root = memoryRoot();
  return {
    root,
    global: path.join(root, "global"),
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

Two scopes, both plain markdown you read and write with your normal file tools:
- Global (applies everywhere): ${dirs.global}
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

## Project memory index
${readIndex(dirs.project) || "(empty)"}
`;
}

// Prepares both memory folders and returns the system-prompt addendum for this run.
export function prepareMemory(workspace: string): { append: string; directories: string[] } {
  const dirs = memoryDirs(workspace);
  try {
    ensureScope(dirs.global, "Global memory");
    ensureScope(dirs.project, "Project memory", `Project: ${workspace}\n\n`);
    return { append: instructions(dirs, workspace), directories: [dirs.global, dirs.project] };
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

export const REFLECT_PROMPT = `Before this session ends, review the conversation above for anything worth remembering long-term,
following the persistent memory instructions in your system prompt: corrections, preferences, confirmed
approaches, project decisions and their reasons, gotchas, useful references.

Save each one now (update existing memories rather than duplicating, fix any that proved wrong, keep the
MEMORY.md indexes in sync). Only touch files inside the memory folders. If nothing new is worth keeping,
change nothing. Reply with one short line saying what you saved.`;
