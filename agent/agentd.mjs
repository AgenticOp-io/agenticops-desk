#!/usr/bin/env node
// AgenticOps cloud agent. Runs on Windows, macOS or Linux with Node 18 or newer and git, no packages needed.
//   node agentd-NAME.mjs
// The superadmin adds the agent on the desk (Settings → Cloud agents), which saves this file with the agent's
// identity built in: its signing key and desk-signed certificate, the desk's certificate, the job channel repository
// and this agent's own Claude API key. Keep the file private, like an SSH key.
// The desk and this agent never connect. The desk writes signed jobs to the channel repository's agent-jobs branch;
// this agent checks it every 15 s with git fetch and pushes signed progress and results back. git on this machine must
// be able to push to the channel repository (and to the repositories jobs name). Model calls go straight to the
// Claude API with this agent's key.
import { spawn } from "node:child_process";
import { createPrivateKey, sign, verify, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const BUNDLE = null;

const HOME = process.env.AGENTICOPS_AGENT_HOME || path.join(os.homedir(), ".agenticops-agent");
if (!BUNDLE || !BUNDLE.channel) {
  console.error("This copy has no agent identity, or was made before agents used the job channel. On the superadmin desk, add the agent in Settings → Cloud agents and run the file it saves.");
  process.exit(2);
}
const cfg = BUNDLE;
const BRANCH = "agent-jobs";
const CHAN = path.join(HOME, "channel");
const MINE = path.join(CHAN, "agents", cfg.agentId);
const deskKey = new X509Certificate(cfg.deskCert).publicKey;
const myPub = new X509Certificate(cfg.cert).publicKey;
const myKey = createPrivateKey(cfg.signKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tests only: a faster check and a model address that answers nothing.
const POLL_MS = Number(process.env.AGENTICOPS_AGENT_POLL_MS) || 15_000;
const API = process.env.AGENTICOPS_AGENT_API || "https://api.anthropic.com";

// Every channel file is { data, sig }. Only the desk's signature makes a job; only ours makes a result we republish.
const seal = (data) => JSON.stringify({ data, sig: sign("sha256", Buffer.from(JSON.stringify(data)), myKey).toString("base64") });
function opened(text, key) {
  try {
    const f = JSON.parse(text);
    return f?.data && typeof f.sig === "string" && verify("sha256", Buffer.from(JSON.stringify(f.data)), key, Buffer.from(f.sig, "base64")) ? f.data : null;
  } catch {
    return null;
  }
}

// Killing only the parent leaves what it started running, so take the whole tree down.
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

// shell: a command string for the shell (the model's run_command); otherwise cmd + args run directly (git).
function run(cmd, args, cwd, job, timeoutMs = 5 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args ?? [], { cwd, shell: !args, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (job) job.child = child; // a cancel from the desk kills it
    let out = "";
    const add = (d) => (out += d.toString());
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const t = setTimeout(() => killTree(child), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      // Keep the head and tail of long output; it is resent on every later turn.
      if (out.length > 24_000) out = `${out.slice(0, 12_000)}\n…[${out.length - 24_000} characters cut]…\n${out.slice(-12_000)}`;
      resolve({ code, out });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: e.message });
    });
  });
}
const git = (args, cwd = CHAN, job) => run("git", args, cwd, job, 2 * 60_000);
async function must(args) {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.slice(-300)}`);
  return r;
}

// ---------- what this agent publishes: jobId → sealed result text (sealed once per change, so unchanged = no commit) ----------
const results = new Map();
let alive = { at: 0, text: "" };
let current = null; // the job running now, if any
function publish(job, status, result) {
  const data = { kind: "result", agentId: cfg.agentId, jobId: job.id, status, log: job.log.slice(-200), usage: job.usage, ...(result !== undefined ? { result: String(result).slice(0, 50_000) } : {}) };
  results.set(job.id, { data, text: seal(data) });
}

// One look at the channel: reset onto the desk's newest state, act on the jobs, write our folder again, push.
async function tick() {
  if (!fs.existsSync(path.join(CHAN, ".git"))) {
    fs.mkdirSync(CHAN, { recursive: true });
    await must(["init", "-q"]);
    await must(["remote", "add", "origin", cfg.channel]);
    await must(["config", "core.symlinks", "false"]);
  }
  const f = await git(["fetch", "-q", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  if (f.code !== 0) {
    if (/couldn't find remote ref/i.test(f.out)) return; // the desk hasn't opened the channel yet
    throw new Error(`git fetch failed: ${f.out.slice(-300)}`);
  }
  await must(["checkout", "-qf", "-B", BRANCH, `origin/${BRANCH}`]);
  await must(["clean", "-fdxq"]);

  const orders = new Map();
  const jobsDir = path.join(CHAN, "jobs", cfg.agentId);
  for (const n of fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : []) {
    const d = opened(fs.readFileSync(path.join(jobsDir, n), "utf8"), deskKey);
    if (d && d.agentId === cfg.agentId && `${d.id}.json` === n) orders.set(d.id, d);
  }
  // Results an earlier run of this agent pushed, so a restart neither repeats a job nor forgets a finished one.
  for (const n of fs.existsSync(MINE) ? fs.readdirSync(MINE) : []) {
    const id = n.replace(/\.json$/, "");
    if (n === "alive.json" || results.has(id)) continue;
    const text = fs.readFileSync(path.join(MINE, n), "utf8");
    const d = opened(text, myPub);
    if (d?.jobId === id) results.set(id, { data: d, text });
  }
  for (const id of results.keys()) if (!orders.has(id)) results.delete(id); // the desk is done with it
  for (const [id, o] of orders) {
    if (o.cancelled) {
      if (current?.id === id) {
        current.cancelled = true;
        current.abort.abort();
        if (current.child) killTree(current.child);
      }
      continue;
    }
    if (current?.id === id) continue;
    const r = results.get(id);
    if (r?.data.status === "running") publish({ id, log: r.data.log ?? [], usage: r.data.usage }, "failed", "The agent restarted during this job.");
    else if (!r && !current) void work(o);
  }

  // A heartbeat every 5 minutes; the desk counts the agent online while they keep coming.
  if (Date.now() - alive.at > 5 * 60_000) {
    alive.at = Date.now();
    alive.text = seal({ kind: "alive", agentId: cfg.agentId, at: alive.at, os: `${os.platform()} ${os.arch()}` });
  }
  fs.rmSync(MINE, { recursive: true, force: true });
  fs.mkdirSync(MINE, { recursive: true });
  fs.writeFileSync(path.join(MINE, "alive.json"), alive.text);
  for (const [id, r] of results) fs.writeFileSync(path.join(MINE, `${id}.json`), r.text);
  await must(["add", "-A"]);
  if ((await git(["diff", "--cached", "--quiet"])).code === 0) return;
  await must(["-c", "user.name=AgenticOps agent", "-c", "user.email=agent@localhost", "commit", "-qm", `Agent ${cfg.name}`]);
  const p = await git(["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`]);
  // Rejected = someone pushed first; the next tick resets onto theirs and writes the same files again.
  if (p.code !== 0 && !/rejected|fetch first|non-fast-forward/i.test(p.out)) throw new Error(`git push failed: ${p.out.slice(-300)}`);
}

// ---------- tools, all confined to the job folder ----------
function inside(root, p) {
  const full = path.resolve(root, String(p ?? "."));
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the job folder.");
  // Follow links through the nearest part of the path that exists, so a linked folder can't lead a new file outside.
  // lstat, not exists: a link to a missing target must count as present, or a write would follow it out.
  let base = full;
  while (!fs.lstatSync(base, { throwIfNoEntry: false }) && path.dirname(base) !== base) base = path.dirname(base);
  let real;
  try {
    real = path.join(fs.realpathSync(base), path.relative(base, full));
  } catch {
    throw new Error("Path is outside the job folder."); // a dangling link
  }
  const relReal = path.relative(fs.realpathSync(root), real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new Error("Path is outside the job folder.");
  return full;
}

function listFiles(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(root, p, out);
    else out.push(path.relative(root, p).replace(/\\/g, "/"));
    if (out.length >= 2000) break;
  }
  return out;
}

const TOOLS = [
  { name: "list_files", description: "List files in the job folder.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "read_file", description: "Read a text file in the job folder.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or replace a file in the job folder.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "run_command", description: "Run a shell command in the job folder. Returns exit code and output. Times out after 5 minutes.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

async function tool(root, name, input, job) {
  try {
    if (name === "list_files") return listFiles(root).join("\n") || "(empty)";
    if (name === "read_file") {
      const t = fs.readFileSync(inside(root, input.path), "utf8");
      return t.length > 100_000 ? `${t.slice(0, 100_000)}\n…[file cut at 100,000 characters]` : t;
    }
    if (name === "write_file") {
      const f = inside(root, input.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(input.content ?? ""));
      return `Wrote ${input.path}`;
    }
    if (name === "run_command") {
      const r = await run(String(input.command ?? ""), null, root, job);
      return `exit ${r.code}\n${r.out}`;
    }
    return `Unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

class Cancelled extends Error {}

// shortcut: raw fetch, not @anthropic-ai/sdk, because this file must run with no packages; no retries on 429/5xx.
async function model(job, system, messages) {
  const r = await fetch(`${API}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2026-10-21", "content-type": "application/json" },
    body: JSON.stringify({ model: job.model, max_tokens: 16000, system, tools: TOOLS, messages }),
    signal: job.abort.signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Model call failed (${r.status})`);
  const u = data.usage ?? {};
  job.usage.input += u.input_tokens ?? 0;
  job.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  job.usage.cacheRead += u.cache_read_input_tokens ?? 0;
  job.usage.output += u.output_tokens ?? 0;
  return data;
}

async function runJob(job) {
  const root = path.join(HOME, "jobs", job.id);
  fs.mkdirSync(root, { recursive: true });
  const log = (line) => {
    if (job.cancelled) throw new Cancelled();
    job.log.push(String(line).slice(0, 2000));
    publish(job, "running");
  };
  let branch = "";
  if (job.repo) {
    if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(job.repo)) throw new Error("Repository address has characters an agent won't pass on.");
    log(`Cloning ${job.repo}`);
    const c = await git(["clone", "--depth", "50", job.repo, "."], root, job);
    if (c.code !== 0) throw new Error(`git clone failed: ${c.out.slice(-1500)}`);
    branch = `agent/${job.id}`;
    await git(["checkout", "-b", branch], root);
  }
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const system = `You are a coding agent on the machine "${cfg.name || os.hostname()}" (${os.platform()}, commands run in ${shell}). Work only inside the job folder${job.repo ? `, a clone of ${job.repo} on branch ${branch}` : ""}. Finish the task, check your work by running it where you can, then reply with a short summary of what you did.`;
  const messages = [{ role: "user", content: job.prompt }];
  let last = "";
  for (let round = 0; round < 40; round++) {
    if (job.cancelled) throw new Cancelled();
    const r = await model(job, system, messages);
    if (job.cancelled) throw new Cancelled();
    // The whole content goes back, thinking blocks included, as the API expects.
    messages.push({ role: "assistant", content: r.content });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (text) {
      last = text;
      log(text.slice(0, 500));
    }
    if (r.stop_reason === "refusal") throw new Error("The model declined this job.");
    const uses = r.content.filter((c) => c.type === "tool_use");
    if (!uses.length) break;
    const out = [];
    for (const u of uses) {
      log(`${u.name} ${u.input?.path ?? u.input?.command ?? ""}`.trim().slice(0, 300));
      out.push({ type: "tool_result", tool_use_id: u.id, content: await tool(root, u.name, u.input ?? {}, job) });
    }
    messages.push({ role: "user", content: out });
  }
  if (job.repo) {
    await git(["add", "-A"], root);
    const commit = await git(["-c", "user.name=AgenticOps agent", "-c", "user.email=agent@localhost", "commit", "-m", `Agent job ${job.id}`], root);
    if (commit.code === 0) {
      const push = await git(["push", "-u", "origin", branch], root, job);
      last += push.code === 0 ? `\n\nPushed branch ${branch}.` : `\n\nCommitted on ${branch} but the push failed: ${push.out.slice(-500)}`;
    } else last += "\n\nNo file changes to commit.";
  }
  return last || "Finished.";
}

async function work(order) {
  const job = (current = { ...order, log: [], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, abort: new AbortController() });
  console.log(`Job ${job.id}: ${job.prompt.slice(0, 80)}`);
  publish(job, "running");
  try {
    const result = await runJob(job);
    publish(job, "done", result);
    console.log(`Job ${job.id} done.`);
  } catch (e) {
    if (e instanceof Cancelled || job.cancelled) console.log(`Job ${job.id} was cancelled.`);
    else {
      console.error(`Job ${job.id} failed: ${e.message}`);
      publish(job, "failed", e.message);
    }
  } finally {
    current = null;
  }
}

async function main() {
  console.log(`Cloud agent ${cfg.name}, watching ${cfg.channel} (${BRANCH}).`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error(`Job channel: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
