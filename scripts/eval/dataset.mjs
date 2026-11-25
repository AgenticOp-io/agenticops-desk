// Training examples from git history, in the same edit-block format run.mjs asks for:
// user = commit subject + the touched files as they were; assistant = the commit's change as SEARCH/REPLACE blocks.
// node scripts/eval/dataset.mjs --repo <path> [--repo <path> ...] [--max-chars 28000] [--max-lines 300]
// Commits that are eval tasks are left out, so the score stays honest. Writes eval/train/sft.jsonl.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { args, EVAL_DIR, git, hunksToBlocks, isCode, SYSTEM } from "./lib.mjs";

if (process.argv[1]?.endsWith("dataset.mjs")) {
  const argv = process.argv.slice(2);
  const repos = argv.flatMap((v, i) => (argv[i - 1] === "--repo" ? [path.resolve(v)] : []));
  const a = args();
  const maxChars = Number(a["max-chars"] ?? 28_000); // about 8k tokens with the reply
  const maxLines = Number(a["max-lines"] ?? 300);
  const taskDir = path.join(EVAL_DIR, "tasks");
  const held = new Set(existsSync(taskDir) ? readdirSync(taskDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(path.join(taskDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).commit)) : []);
  const rows = [];
  for (const repo of repos) {
    let kept = 0;
    for (const line of git(repo, "log", "--no-merges", "--format=%H%x09%P%x09%s").trim().split("\n")) {
      const [commit, parent, subject] = line.split("\t");
      if (!parent || parent.includes(" ") || held.has(commit)) continue;
      const stat = git(repo, "diff", "--numstat", "--no-renames", "--diff-filter=AM", parent, commit).trim().split("\n").filter(Boolean).map((r) => r.split("\t"));
      const files = stat.filter(([, , f]) => isCode(f)).map(([add, del, f]) => ({ f, n: (Number(add) || 0) + (Number(del) || 0) }));
      if (!files.length || files.reduce((n, x) => n + x.n, 0) > maxLines) continue;
      let shown = "";
      let reply = "";
      for (const { f } of files) {
        let before = "";
        try {
          before = git(repo, "show", `${parent}:${f}`);
        } catch {
          /* a new file */
        }
        const after = before ? "" : git(repo, "show", `${commit}:${f}`);
        shown += `=== ${f} ===\n${before ? before.replace(/\r\n/g, "\n") : "(file does not exist yet)"}\n\n`;
        reply += (reply ? "\n" : "") + (before ? hunksToBlocks(f, git(repo, "diff", "-U3", parent, commit, "--", f).replace(/\r\n/g, "\n")) : `FILE: ${f}\n<<<<<<< SEARCH\n=======\n${after.replace(/\r\n/g, "\n").trimEnd()}\n>>>>>>> REPLACE`);
      }
      if (shown.length + reply.length > maxChars) continue;
      rows.push(JSON.stringify({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Task: ${subject}\n\nCode to change:\n\n${shown}` }, { role: "assistant", content: reply }] }));
      kept++;
    }
    console.log(`${path.basename(repo)}: ${kept} examples`);
  }
  mkdirSync(path.join(EVAL_DIR, "train"), { recursive: true });
  const out = path.join(EVAL_DIR, "train", "sft.jsonl");
  writeFileSync(out, rows.join("\n") + "\n");
  console.log(`${rows.length} examples (${held.size} eval commits held out) in ${out}`);
}
