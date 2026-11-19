import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { recordActivity } from "./activityLog";
import { realStorePwsh } from "./claude";
import { quietThreads } from "./resourceGuard";
import { isNewerVersion, isReleaseTag, newestTag } from "./pureFeatures";

const DOCS = new Set(["CLAUDE.md", "AGENTS.md", ".mcp.json"]);

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = 60_000,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, windowsHide: true, timeout, maxBuffer: 2_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv } },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({ ok: !err, output: output || (err ? String(err.message) : "") });
      },
    );
  });
}

// Git never waits for a password prompt; a missing login comes back as an error instead of a hung window.
export function runGit(cwd: string, args: string[], timeout = 60_000) {
  return run("git", args, cwd, timeout);
}

function branchName(branch: string) {
  const name = branch.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) || name.includes("..") || name.endsWith("/")) return "";
  return name;
}

export function gitStatus(cwd: string) {
  return Promise.all([
    run("git", ["status", "-sb"], cwd),
    run("git", ["diff", "--stat"], cwd),
  ]).then(([status, diff]) => ({
    ok: status.ok,
    branch: status.output.split("\n")[0] ?? "",
    lines: status.output,
    diff: diff.output,
  }));
}

export async function gitCommit(cwd: string, message: string) {
  const text = message.trim();
  if (!text) return { ok: false, output: "Write a commit message first." };
  // Include new files too (-A); .gitignore still keeps build output and secrets out.
  const added = await run("git", ["add", "-A"], cwd);
  if (!added.ok) return gitActivity("commit", added);
  return gitActivity("commit", await run("git", ["commit", "-m", text], cwd));
}

function gitActivity(action: string, result: { ok: boolean; output: string }) {
  recordActivity({ kind: "git", action, outcome: result.ok ? "ok" : "failed", note: result.output.split("\n").slice(-2).join(" ").slice(-240) || undefined });
  return result;
}

export function gitFetch(cwd: string) {
  return runGit(cwd, ["fetch", "--prune"], 120_000).then((r) => gitActivity("fetch", r));
}

export function gitPull(cwd: string) {
  return runGit(cwd, ["pull", "--ff-only"], 120_000).then((r) => gitActivity("pull", r));
}

export function gitPush(cwd: string) {
  return runGit(cwd, ["push"], 120_000).then((r) => gitActivity("push", r));
}

export async function gitHistory(cwd: string) {
  const [branches, log] = await Promise.all([
    runGit(cwd, ["branch", "-vv"]),
    runGit(cwd, ["log", "-15", "--oneline", "--decorate"]),
  ]);
  return { ok: branches.ok || log.ok, output: [branches.output, log.output].filter(Boolean).join("\n\n") };
}

export function gitCheckout(cwd: string, branch: string) {
  const name = branchName(branch);
  if (!name) return Promise.resolve({ ok: false, output: "Branch name is not valid." });
  return runGit(cwd, ["checkout", name]).then((r) => gitActivity("checkout", r));
}

export function gitPullRequest(cwd: string, title: string, body: string) {
  const heading = title.trim();
  if (!heading) return Promise.resolve({ ok: false, output: "Write a pull request title first." });
  return run("gh", ["pr", "create", "--title", heading, "--body", body.trim() || heading], cwd).then((r) => gitActivity("pull-request", r));
}

export async function readProjectDoc(cwd: string, name: string) {
  if (!DOCS.has(name)) return "";
  try {
    return await fs.readFile(path.join(cwd, name), "utf8");
  } catch {
    return "";
  }
}

export async function writeProjectDoc(cwd: string, name: string, contents: string) {
  if (!DOCS.has(name)) return false;
  const target = path.join(cwd, name);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, target);
  return true;
}

function shellExe(): string {
  if (process.platform !== "win32") return process.env.SHELL || "/bin/bash";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const installed = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (existsSync(installed)) return installed;
  return realStorePwsh() || "powershell.exe";
}

type Shell = { child: ChildProcess; backlog: string; onData: (chunk: string) => void; usedAt: number };
const shells = new Map<string, Shell>();
const BACKLOG = 50_000;
// Shells stay alive while you switch folders; the least recently used ones close past this many.
const MAX_SHELLS = 3;

function shellId(cwd: string) {
  const resolved = path.resolve(cwd);
  // Windows and macOS paths are case-insensitive; Linux paths are not.
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

// Ends the shell and everything it started (a dev server, a test watcher).
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill();
  }
}

// Returns the shell id and what it printed so far, so reopening the tab shows the history.
export function openShell(cwd: string, onData: (chunk: string) => void): { id: string; backlog: string } {
  const id = shellId(cwd);
  const live = shells.get(id);
  if (live && live.child.exitCode === null && !live.child.killed) {
    live.onData = onData;
    live.usedAt = Date.now();
    return { id, backlog: live.backlog };
  }
  const exe = shellExe();
  const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NoExit"] : [];
  const child = spawn(exe, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...quietThreads() },
    // Its own process group on macOS and Linux, so Restart also stops what it started.
    detached: process.platform !== "win32",
  });
  const entry: Shell = { child, backlog: "", onData, usedAt: Date.now() };
  const push = (text: string) => {
    entry.backlog = (entry.backlog + text).slice(-BACKLOG);
    entry.onData(text);
  };
  child.stdout?.on("data", (buf: Buffer) => push(buf.toString("utf8")));
  child.stderr?.on("data", (buf: Buffer) => push(buf.toString("utf8")));
  child.on("error", (err) => push(`\n[could not start the shell: ${err.message}]\n`));
  child.on("exit", (code) => {
    push(`\n[shell closed${code === null ? "" : ` (${code})`}]\n`);
    if (shells.get(id) === entry) shells.delete(id);
  });
  shells.set(id, entry);
  push(`Started ${path.basename(exe)} in ${cwd}\n`);
  const extra = [...shells.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, Math.max(0, shells.size - MAX_SHELLS));
  for (const [oldId] of extra) closeShell(oldId);
  return { id, backlog: entry.backlog };
}

export function writeShell(id: string, text: string) {
  const entry = shells.get(id);
  if (!entry?.child.stdin || entry.child.exitCode !== null) return false;
  entry.usedAt = Date.now();
  entry.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
  return true;
}

export function closeShell(id: string) {
  const entry = shells.get(id);
  if (!entry) return;
  shells.delete(id);
  killTree(entry.child);
}

export function closeAllShells() {
  for (const id of [...shells.keys()]) closeShell(id);
}

const REPO = "AgenticOp-io/agenticops-desk";
const REPO_URL = `https://github.com/${REPO}.git`;

async function githubToken(): Promise<string> {
  const viaCli = await run("gh", ["auth", "token"], app.getPath("home"), 20_000);
  return viaCli.ok ? viaCli.output.trim() : "";
}

function authHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  return { Accept: accept, "User-Agent": "AgenticOps-Desk", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

// The token stays in the environment, not in the git arguments, so a failure message cannot repeat it.
async function tagsFromGit(token: string): Promise<string[] | null> {
  const listed = await run("git", ["ls-remote", "--tags", REPO_URL], app.getPath("home"), 30_000, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  });
  if (!listed.ok) return null;
  return listed.output.split(/\r?\n/).map((line) => line.split("\t")[1] ?? "").filter(Boolean);
}

async function releaseFor(token: string, tag: string): Promise<{ url: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: authHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as { html_url?: string; draft?: boolean };
    if (data.draft) return null;
    return { url: data.html_url || `https://github.com/${REPO}/releases/tag/${tag}` };
  } catch {
    return null;
  }
}

async function githubBytes(url: string, token: string): Promise<Buffer | null> {
  let next = url;
  for (let hop = 0; hop < 5; hop++) {
    const headers = authHeaders(next.startsWith("https://api.github.com/") ? token : "", "application/octet-stream");
    const res = await fetch(next, { headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      next = new URL(loc, next).href;
      continue;
    }
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

// Downloads named release files with the GitHub CLI sign-in. Returns null on success, or the reason it failed.
export async function downloadReleaseAssets(tag: string, dir: string, names: string[]): Promise<string | null> {
  const token = await githubToken();
  if (!token) return "sign-in";
  if (!isReleaseTag(tag)) return "tag";
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: authHeaders(token) });
    if (!res.ok) return res.status === 404 ? "not-ready" : "network";
    const data = (await res.json()) as { assets?: Array<{ name?: string; url?: string }> };
    for (const name of names) {
      const asset = data.assets?.find((item) => item.name === name && item.url);
      if (!asset?.url) return "missing";
      const bytes = await githubBytes(asset.url, token);
      if (!bytes) return "network";
      await fs.writeFile(path.join(dir, name), bytes);
    }
    return null;
  } catch {
    return "network";
  }
}

export async function checkForUpdate(): Promise<{ current: string; latest: string | null; url: string | null; note: string }> {
  const current = app.getVersion();
  const note = "Installers are not code-signed. A signed setup needs a certificate, which this project does not have.";
  const token = await githubToken();
  if (token) {
    const refs = await tagsFromGit(token);
    const latest = refs ? newestTag(refs, "v0.0.0") : null;
    if (latest && isNewerVersion(latest, current)) {
      const release = await releaseFor(token, latest);
      if (release) return { current, latest, url: release.url, note };
      return { current, latest: null, url: null, note: `${latest} is tagged and the beta build is not uploaded yet. ${note}` };
    }
    if (latest) return { current, latest: null, url: null, note: `You're on the latest release (${latest}). ${note}` };
  }
  // No git tag listing: ask the GitHub CLI for releases directly.
  const viaCli = await run("gh", ["api", `repos/${REPO}/releases?per_page=20`, "--jq", ".[] | select(.draft | not) | .tag_name"], app.getPath("home"));
  const latest = viaCli.ok ? newestTag(viaCli.output.split(/\r?\n/), "v0.0.0") : null;
  if (latest && isNewerVersion(latest, current)) return { current, latest, url: `https://github.com/${REPO}/releases/tag/${latest}`, note };
  if (viaCli.ok) return { current, latest: null, url: null, note: latest ? `You're on the latest release (${latest}). ${note}` : note };
  return {
    current,
    latest: null,
    url: null,
    note: `Could not check: the repository is private. Sign in with the GitHub CLI (gh auth login) to check for updates. ${note}`,
  };
}
