// Score a model on the mined tasks: it sees the failing tests and the files the real fix touched, replies with
// search/replace edits, and gets up to --tries rounds of test output to fix its own mistakes.
// node scripts/eval/run.mjs --model qwen3-coder:30b [--provider ollama] [--base http://localhost:11435] [--tasks <file|dir>] [--limit 50] [--tries 3]
// node scripts/eval/run.mjs --provider anthropic --model claude-sonnet-5-5 --in-price 3 --out-price 15   (key from ANTHROPIC_API_KEY)
// Results: %APPDATA%/AgenticOps Desk/eval/results/<model>.jsonl; re-running skips tasks already scored.
// shortcut: the model is told which files to change (oracle files), so this scores fixing, not finding; add a search tool when local models pass most tasks.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, args, SYSTEM, checkout, drop, EVAL_DIR, git, parseEdits, runTests } from "./lib.mjs";

const a = args();
const model = a.model ?? "qwen3-coder:30b";
const provider = a.provider ?? "ollama";
const base = String(a.base ?? "http://localhost:11435").replace(/\/$/, "");
const tries = Number(a.tries ?? 3);
const limit = Number(a.limit ?? Infinity);
const numCtx = Number(a.ctx ?? 32768);
const price = { in: Number(a["in-price"] ?? 0), out: Number(a["out-price"] ?? 0) };



const show = (dir, f) => {
  const p = path.join(dir, f);
  const body = existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n").slice(0, 60_000) : "(file does not exist yet)";
  return `=== ${f} ===\n${body}`;
};

async function chat(messages) {
  if (provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const r = await new Anthropic().messages.create({ model, max_tokens: 16_000, system: SYSTEM, messages });
    return { text: r.content.filter((b) => b.type === "text").map((b) => b.text).join(""), input: r.usage.input_tokens, output: r.usage.output_tokens };
  }
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: SYSTEM }, ...messages], options: { num_ctx: numCtx, temperature: 0.2 } }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const r = await res.json();
  return { text: r.message?.content ?? "", input: r.prompt_eval_count ?? 0, output: r.eval_count ?? 0 };
}

async function solve(task) {
  const dir = checkout(task.repo, task.parent);
  const started = Date.now();
  let input = 0, output = 0;
  try {
    git(dir, "checkout", task.commit, "--", ...task.tests);
    const forbidden = new Set(task.tests.map((f) => f.replace(/\\/g, "/")));
    const messages = [{
      role: "user",
      content: [`Task: ${task.subject}`, `These tests fail:\n${task.failure}`, "Tests:", ...task.tests.map((f) => show(dir, f)), "Code to change:", ...task.src.map((f) => show(dir, f))].join("\n\n"),
    }];
    for (let round = 1; round <= tries; round++) {
      const r = await chat(messages);
      input += r.input;
      output += r.output;
      const edits = parseEdits(r.text);
      const problem = edits.length ? applyEdits(dir, edits, forbidden) : "No edit blocks found in your reply.";
      const result = problem ? { ok: false, output: problem } : runTests(dir, task.testCmd, task.tests);
      if (result.ok) return { pass: true, tries: round, input, output, seconds: (Date.now() - started) / 1000 };
      const touched = [...new Set(edits.map((e) => e.file))].filter((f) => !forbidden.has(f));
      messages.push({ role: "assistant", content: r.text });
      messages.push({ role: "user", content: [`Still failing:\n${result.output}`, ...touched.map((f) => show(dir, f))].join("\n\n") });
    }
    return { pass: false, tries, input, output, seconds: (Date.now() - started) / 1000 };
  } finally {
    drop(task.repo, dir);
  }
}

function loadTasks(where) {
  const files = statSync(where).isDirectory() ? readdirSync(where).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(where, f)) : [where];
  return files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

{
  const tasks = loadTasks(a.tasks ?? path.join(EVAL_DIR, "tasks"));
  mkdirSync(path.join(EVAL_DIR, "results"), { recursive: true });
  const out = path.join(EVAL_DIR, "results", `${model.replace(/[^\w.-]+/g, "_")}.jsonl`);
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  let ran = 0;
  for (const task of tasks) {
    if (ran >= limit || done.has(task.id)) continue;
    ran++;
    let row;
    try {
      row = await solve(task);
    } catch (err) {
      row = { pass: false, error: String(err.message ?? err).slice(0, 300) };
    }
    row = { id: task.id, model, provider, ...row, costUsd: ((row.input ?? 0) * price.in + (row.output ?? 0) * price.out) / 1e6 };
    appendFileSync(out, JSON.stringify(row) + "\n");
    console.log(`${row.pass ? "PASS" : "fail"} ${task.id} ${row.tries ?? "-"} tries ${Math.round(row.seconds ?? 0)}s${row.error ? " " + row.error : ""}`);
  }
  const all = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const passed = all.filter((r) => r.pass).length;
  console.log(`${model}: ${passed}/${all.length} passed (${Math.round((100 * passed) / Math.max(1, all.length))}%), $${all.reduce((n, r) => n + (r.costUsd ?? 0), 0).toFixed(2)}`);
}
