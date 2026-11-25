// Shared by mine.mjs and run.mjs: tasks are old fixes from git history. The tests a fix added or changed
// must fail on the parent commit and pass on the fix; a model gets the parent and has to make them pass.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EVAL_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "AgenticOps Desk", "eval");
export const DEFAULT_TEST = "node --experimental-strip-types --test {files}";

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

export const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });

// A detached worktree at `rev`, sharing the repo's node_modules so tests can import its packages.
export function checkout(repo, rev) {
  mkdirSync(EVAL_DIR, { recursive: true });
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "desk-eval-")), "w");
  git(repo, "worktree", "add", "--detach", "--quiet", dir, rev);
  const made = [];
  const link = (rel) => {
    symlinkSync(path.join(repo, rel), path.join(dir, rel), "junction");
    made.push(path.join(dir, rel));
  };
  // Workspace packages git ignores (vendored or generated) exist only in the main checkout; borrow them.
  for (const ws of ["packages", "apps"]) {
    if (!existsSync(path.join(repo, ws)) || !existsSync(path.join(dir, ws))) continue;
    for (const e of readdirSync(path.join(repo, ws), { withFileTypes: true })) {
      if ((e.isDirectory() || e.isSymbolicLink()) && !existsSync(path.join(dir, ws, e.name))) link(path.join(ws, e.name));
    }
  }
  for (const rel of moduleDirs(repo)) if (existsSync(path.dirname(path.join(dir, rel))) && !existsSync(path.join(dir, rel))) link(rel);
  links.set(dir, made);
  return dir;
}
const links = new Map();

// node_modules at the root and one or two levels down (pnpm and npm workspaces keep one per package).
function moduleDirs(repo) {
  const found = [];
  const walk = (rel, depth) => {
    for (const e of readdirSync(path.join(repo, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = path.join(rel, e.name);
      if (e.name === "node_modules") found.push(sub);
      else if (depth < 2) walk(sub, depth + 1);
    }
  };
  walk("", 0);
  return found;
}

export function drop(repo, dir) {
  // Only the junctions checkout made go, before the worktree, so removal can never reach into the real repo.
  for (const p of links.get(dir) ?? []) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  links.delete(dir);
  try {
    git(repo, "worktree", "remove", "--force", dir);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(repo, "worktree", "prune");
  }
}

export function runTests(dir, cmd, files) {
  const line = cmd.replace("{files}", files.map((f) => JSON.stringify(f)).join(" "));
  const r = spawnSync(line, { cwd: dir, shell: true, encoding: "utf8", timeout: 180_000, maxBuffer: 32 << 20 });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output: output.slice(-4000) };
}

export const isTest = (f) => /(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|[\\/])test_[^\\/]+\.py$/.test(f);
export const isCode = (f) => /\.([cm]?[jt]sx?|py|go|rs|cs|java|kt)$/.test(f);

export function parseEdits(text) {
  const re = /FILE:\s*`?([^\n`]+?)`?\s*\n(?:```[^\n]*\n)?<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
  return [...text.replace(/<think>[\s\S]*?<\/think>/g, "").matchAll(re)].map((m) => ({ file: m[1].trim(), search: m[2], replace: m[3] }));
}

// Apply edits inside `dir`. Returns the error a model should see, or "" when every edit applied.
export function applyEdits(dir, edits, forbidden) {
  const errors = [];
  for (const e of edits) {
    const full = path.resolve(dir, e.file);
    const rel = path.relative(dir, full).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) errors.push(`${e.file}: outside the repo`);
    else if (forbidden.has(rel)) errors.push(`${e.file}: test files may not be changed`);
    else if (!e.search.trim()) {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, e.replace + "\n");
    } else if (!existsSync(full)) errors.push(`${e.file}: no such file`);
    else {
      const raw = readFileSync(full, "utf8");
      const crlf = raw.includes("\r\n");
      const text = raw.replace(/\r\n/g, "\n");
      const at = text.indexOf(e.search);
      if (at < 0) errors.push(`${e.file}: SEARCH text not found`);
      else if (text.indexOf(e.search, at + 1) >= 0) errors.push(`${e.file}: SEARCH text matches more than once`);
      else {
        const next = text.slice(0, at) + e.replace + text.slice(at + e.search.length);
        writeFileSync(full, crlf ? next.replace(/\n/g, "\r\n") : next);
      }
    }
  }
  return errors.join("\n");
}

export const SYSTEM = [
  "You fix bugs in a code repository so that failing tests pass. Do not change test files.",
  "Reply only with edit blocks, as many as needed:",
  "FILE: <path relative to the repo>",
  "<<<<<<< SEARCH",
  "<lines copied exactly from the current file>",
  "=======",
  "<replacement lines>",
  ">>>>>>> REPLACE",
  "SEARCH must match the file exactly and only once. An empty SEARCH writes the whole file (use it for new files).",
].join("\n");

// One SEARCH/REPLACE block per hunk: SEARCH = context + removed lines, REPLACE = context + added lines.
export function hunksToBlocks(file, diff) {
  const blocks = [];
  let cur = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      if (cur) blocks.push(cur);
      cur = { search: [], replace: [] };
    } else if (!cur || line.startsWith("\\")) continue;
    else if (line.startsWith("-")) cur.search.push(line.slice(1));
    else if (line.startsWith("+")) cur.replace.push(line.slice(1));
    else if (line.startsWith(" ") || line === "") {
      cur.search.push(line.slice(1));
      cur.replace.push(line.slice(1));
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => `FILE: ${file}\n<<<<<<< SEARCH\n${b.search.join("\n")}\n=======\n${b.replace.join("\n")}\n>>>>>>> REPLACE`).join("\n");
}
