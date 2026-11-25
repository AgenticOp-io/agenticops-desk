#!/usr/bin/env node
// AgenticOps cloud agent. Runs on Windows, macOS or Linux with Node 18 or newer, no packages needed.
//   node agentd.mjs --desk https://DESK-ADDRESS:7377 --key DESK-KEY [--name build-box-1]
// First run prints a pairing code; the superadmin types it into the desk (Settings → Cloud agents).
// The agent then keeps an encrypted keepalive stream open to that desk (see wire.mjs), takes jobs and cancels
// over it, and sends every model call through the desk, which holds the API key and meters use.
// It talks HTTPS only, and trusts only the desk certificate built into this file when the desk served it.
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { agentSession, channel, fingerprint, newKeyPair, pairCode } from "./wire.mjs";
const DESK_CERT = null;

const HOME = process.env.AGENTICOPS_AGENT_HOME || path.join(os.homedir(), ".agenticops-agent");
const CONFIG = path.join(HOME, "config.json");
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};
if (arg("desk")) cfg.desk = arg("desk").replace(/\/+$/, "");
if (arg("name")) cfg.name = arg("name");
if (arg("key")) cfg.deskKey = arg("key");
if (DESK_CERT) cfg.deskCert = DESK_CERT;
if (!cfg.desk || !/^https:\/\//i.test(cfg.desk)) {
  console.error("Usage: node agentd.mjs --desk https://DESK-ADDRESS:7377 --key DESK-KEY [--name NAME]  (https only)");
  process.exit(2);
}
if (!cfg.deskCert) {
  console.error("This copy has no desk certificate. Download agentd.mjs from the desk with the command on its Cloud agents page.");
  process.exit(2);
}
const CERT_FP = new X509Certificate(cfg.deskCert).fingerprint256;
const saveCfg = () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTPS POST that accepts only the desk's own certificate (the hostname is not checked: the pin is stronger).
function post(p, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(cfg.desk + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ca: cfg.deskCert,
      checkServerIdentity: (_host, c) => (c.fingerprint256 === CERT_FP ? undefined : new Error("The desk's certificate is not the one this agent trusts.")),
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("error", reject);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

// Pairing and the session hello carry no secrets; still HTTPS like everything else.
const plain = post;

function removed() {
  console.error("The superadmin removed this agent. Run again to pair with a new code.");
  for (const k of ["keys", "agentId", "deskPub"]) delete cfg[k];
  saveCfg();
  process.exit(1);
}

// A fresh session every 30 minutes, or whenever the desk forgot it (restart). Shared by concurrent calls.
let session = null;
function getSession() {
  if (session && Date.now() - session.at < 30 * 60_000) return session.p;
  const s = { at: Date.now() };
  s.p = (async () => {
    const e = newKeyPair();
    const r = await plain("/agent/hello", { agentId: cfg.agentId, e: e.pub });
    if (r.status === 403) removed();
    if (r.status !== 200) throw new Error(r.data?.error || `hello failed (${r.status})`);
    const k = agentSession(cfg.keys.priv, e.priv, e.pub, cfg.deskPub, r.data.e);
    return { sid: r.data.sid, ch: channel(r.data.sid, k.up, k.down) };
  })();
  s.p.catch(() => session === s && (session = null));
  session = s;
  return s.p;
}

// Every call after pairing is sealed: the desk sees { p, b } and answers { status, data }, both encrypted.
async function call(p, b = {}, retry = true) {
  const sess = await getSession();
  const res = await post("/agent/s", sess.ch.seal({ p, b }));
  if (res.status === 401 && retry) {
    session = null;
    return call(p, b, false);
  }
  if (res.status !== 200) throw new Error(`Desk refused the message (${res.status}).`);
  return sess.ch.open(res.data);
}

async function pairUp() {
  if (!cfg.keys) {
    cfg.keys = newKeyPair();
    saveCfg();
  }
  if (!cfg.deskKey) console.warn("No --key given, so this agent will trust whichever desk answers first. Copy the full command from the desk to avoid that.");
  console.log(`\nPairing code: ${pairCode(cfg.keys.pub)}\nEnter it in AgenticOps Desk → Settings → Cloud agents on the superadmin desk (${cfg.desk}).\n`);
  for (;;) {
    try {
      const r = await plain("/agent/pair", { pub: cfg.keys.pub, name: cfg.name || os.hostname(), os: `${os.platform()} ${os.arch()}` });
      if (r.data?.status === "approved") {
        // Someone between us and the desk could answer with their own key; --key catches that.
        if (cfg.deskKey && fingerprint(r.data.desk) !== cfg.deskKey) throw new Error(`The desk's key is ${fingerprint(r.data.desk)}, not ${cfg.deskKey}. Something between this machine and the desk may be intercepting. Not pairing.`);
        Object.assign(cfg, { agentId: r.data.agentId, deskPub: r.data.desk, deskKey: fingerprint(r.data.desk) });
        saveCfg();
        console.log("Paired. Waiting for jobs.");
        return;
      }
      if (r.data?.status === "revoked") removed();
    } catch (e) {
      if (/intercepting/.test(e.message)) throw e;
      console.error(`Can't reach the desk yet: ${e.message}`);
    }
    await sleep(3000);
  }
}

// ---------- tools, all confined to the job folder ----------
function inside(root, p) {
  const full = path.resolve(root, String(p ?? "."));
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the job folder.");
  // Follow links that already exist, so a symlink cannot point the agent outside.
  let real = full;
  try {
    real = fs.realpathSync(full);
  } catch {}
  const relReal = path.relative(fs.realpathSync(root), real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new Error("Path is outside the job folder.");
  return full;
}

// Killing only the shell leaves what it started running, so take the whole tree down.
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

function run(cmd, cwd, job, timeoutMs = 5 * 60_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
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
      const r = await run(String(input.command ?? ""), root, job);
      return `exit ${r.code}\n${r.out}`;
    }
    return `Unknown tool ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

class Cancelled extends Error {}

async function runJob(job) {
  const root = path.join(HOME, "jobs", job.id);
  fs.mkdirSync(root, { recursive: true });
  const log = (line) => call("event", { jobId: job.id, log: line }).then((r) => { if (r.status === 409 || job.cancelled) throw new Cancelled(); });
  let branch = "";
  if (job.repo) {
    // The address goes into a shell line, so only plain URL characters pass (the desk checks the same).
    if (!/^(https:\/\/|git@|ssh:\/\/)[\w.@:/~+-]+$/.test(job.repo)) throw new Error("Repository address has characters an agent won't pass to a shell.");
    await log(`Cloning ${job.repo}`);
    const c = await run(`git clone --depth 50 "${job.repo}" .`, root, job);
    if (c.code !== 0) throw new Error(`git clone failed: ${c.out.slice(-1500)}`);
    branch = `agent/${job.id}`;
    await run(`git checkout -b ${branch}`, root);
  }
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const system = `You are a coding agent on the machine "${cfg.name || os.hostname()}" (${os.platform()}, commands run in ${shell}). Work only inside the job folder${job.repo ? `, a clone of ${job.repo} on branch ${branch}` : ""}. Finish the task, check your work by running it where you can, then reply with a short summary of what you did.`;
  const messages = [{ role: "user", content: job.prompt }];
  let last = "";
  for (let round = 0; round < 40; round++) {
    if (job.cancelled) throw new Cancelled();
    const r = await call("model", { jobId: job.id, system, tools: TOOLS, messages, max_tokens: 8000 });
    if (r.status === 409 || job.cancelled) throw new Cancelled();
    if (r.status !== 200) throw new Error(r.data?.error || `Model call failed (${r.status})`);
    const content = r.data.content.filter((c) => c.type === "text" || c.type === "tool_use");
    messages.push({ role: "assistant", content });
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (text) {
      last = text;
      await log(text.slice(0, 500));
    }
    const uses = content.filter((c) => c.type === "tool_use");
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      await log(`${u.name} ${u.input?.path ?? u.input?.command ?? ""}`.trim().slice(0, 300));
      results.push({ type: "tool_result", tool_use_id: u.id, content: await tool(root, u.name, u.input ?? {}, job) });
    }
    messages.push({ role: "user", content: results });
  }
  if (job.repo) {
    await run("git add -A", root);
    const commit = await run(`git -c user.name="AgenticOps agent" -c user.email="agent@localhost" commit -m "Agent job ${job.id}"`, root);
    if (commit.code === 0) {
      const push = await run(`git push -u origin ${branch}`, root);
      last += push.code === 0 ? `\n\nPushed branch ${branch}.` : `\n\nCommitted on ${branch} but the push failed: ${push.out.slice(-500)}`;
    } else last += "\n\nNo file changes to commit.";
  }
  return last || "Finished.";
}

let current = null; // the job running now, if any

async function work(job) {
  console.log(`Job ${job.id}: ${job.prompt.slice(0, 80)}`);
  try {
    const result = await runJob(job);
    await call("event", { jobId: job.id, done: true, result });
    console.log(`Job ${job.id} done.`);
  } catch (e) {
    if (e instanceof Cancelled || job.cancelled) console.log(`Job ${job.id} was cancelled.`);
    else {
      console.error(`Job ${job.id} failed: ${e.message}`);
      await call("event", { jobId: job.id, done: true, failed: true, result: e.message }).catch(() => {});
    }
  } finally {
    current = null;
  }
}

// The keepalive stream: always one call open to the desk, which answers within 25 s with a ping and anything
// it has for this agent (a job, a cancel), whether or not a job is running.
async function main() {
  if (!cfg.agentId) await pairUp();
  console.log(`Cloud agent ${cfg.name || os.hostname()} connected to ${cfg.desk} (desk key ${cfg.deskKey}).`);
  for (;;) {
    let r;
    try {
      r = await call("stream", { jobId: current?.id });
    } catch (e) {
      console.error(`Desk unreachable: ${e.message}. Retrying.`);
      session = null;
      await sleep(10_000);
      continue;
    }
    for (const m of r.data?.messages ?? []) {
      if (m.type === "job" && !current) void work((current = m.job));
      if (m.type === "cancel" && current?.id === m.jobId) {
        current.cancelled = true;
        if (current.child) killTree(current.child);
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});