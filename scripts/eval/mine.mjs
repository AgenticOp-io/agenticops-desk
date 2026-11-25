// Build eval tasks from a repo's history.
// node scripts/eval/mine.mjs [--repo .] [--test "node --experimental-strip-types --test {files}"] [--max 300] [--max-lines 200]
// A commit becomes a task when it changes code and tests, and the changed tests fail on the parent but pass on it.
// Writes %APPDATA%/AgenticOps Desk/eval/tasks/<repo>.jsonl (one task per line). Re-running skips commits already checked.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { args, checkout, DEFAULT_TEST, drop, EVAL_DIR, git, isCode, isTest, runTests } from "./lib.mjs";

const a = args();
const repo = path.resolve(a.repo ?? ".");
const testCmd = a.test ?? DEFAULT_TEST;
const max = Number(a.max ?? 300);
const maxLines = Number(a["max-lines"] ?? 200);
const maxChars = Number(a["max-chars"] ?? 90_000); // the code a model is shown has to fit its context
// Named after the remote, so a worktree and its main checkout share one task file.
let remote = "";
try {
  remote = git(repo, "remote", "get-url", "origin").trim();
} catch {
  /* no remote */
}
const name = path.basename(remote || git(repo, "rev-parse", "--show-toplevel").trim()).replace(/\.git$/, "");
mkdirSync(path.join(EVAL_DIR, "tasks"), { recursive: true });
const out = path.join(EVAL_DIR, "tasks", `${name}.jsonl`);
const seenFile = `${out}.checked`;
const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, "utf8").split("\n").filter(Boolean) : []);
const have = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).commit) : [];
for (const c of have) seen.add(c);
let found = have.length;

const log = git(repo, "log", "--no-merges", "--format=%H%x09%P%x09%s").trim().split("\n");
for (const line of log) {
  if (found >= max) break;
  const [commit, parents, subject] = line.split("\t");
  if (!parents || parents.includes(" ") || seen.has(commit)) continue;
  const numstat = git(repo, "diff", "--numstat", "--no-renames", parents, commit).trim().split("\n").filter(Boolean);
  const files = numstat.map((r) => r.split("\t"));
  const tests = files.filter(([, , f]) => isTest(f)).map(([, , f]) => f);
  const src = files.filter(([, , f]) => isCode(f) && !isTest(f));
  const lines = src.reduce((n, [add, del]) => n + (Number(add) || 0) + (Number(del) || 0), 0);
  const mark = () => appendFileSync(seenFile, commit + "\n");
  if (!tests.length || !src.length || lines > maxLines) {
    mark();
    continue;
  }
  const dir = checkout(repo, parents);
  try {
    const shown = src.reduce((n, [, , f]) => n + (existsSync(path.join(dir, f)) ? statSync(path.join(dir, f)).size : 0), 0);
    const live = tests.filter((f) => git(repo, "ls-tree", "--name-only", commit, "--", f).trim());
    if (shown > maxChars || !live.length) continue;
    git(dir, "checkout", commit, "--", ...live);
    const before = runTests(dir, testCmd, live);
    if (before.ok) continue;
    git(dir, "checkout", commit, "--", ...src.map(([, , f]) => f).filter((f) => git(repo, "ls-tree", "--name-only", commit, "--", f).trim()));
    const after = runTests(dir, testCmd, live);
    if (!after.ok) continue;
    const task = { id: `${name}-${commit.slice(0, 8)}`, repo, commit, parent: parents, subject, tests: live, src: src.map(([, , f]) => f), lines, testCmd, failure: before.output };
    appendFileSync(out, JSON.stringify(task) + "\n");
    found++;
    console.log(`task ${task.id}: ${subject}`);
  } catch (err) {
    console.error(`skip ${commit.slice(0, 8)}: ${String(err.message ?? err).split("\n")[0]}`);
  } finally {
    drop(repo, dir);
    mark();
  }
}
console.log(`${found} tasks in ${out}`);
