import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { realStorePwsh } from "./claude";

const DOCS = new Set(["CLAUDE.md", "AGENTS.md", ".mcp.json"]);

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !err, output: output || (err ? String(err.message) : "") });
    });
  });
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
  if (!added.ok) return added;
  return run("git", ["commit", "-m", text], cwd);
}

export function gitPullRequest(cwd: string, title: string, body: string) {
  const heading = title.trim();
  if (!heading) return Promise.resolve({ ok: false, output: "Write a pull request title first." });
  return run("gh", ["pr", "create", "--title", heading, "--body", body.trim() || heading], cwd);
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

const RELEASES = "repos/AgenticOp-io/claudedesk/releases/latest";

export async function checkForUpdate(): Promise<{ current: string; latest: string | null; url: string | null; note: string }> {
  const current = app.getVersion();
  const note =
    "Installers are not code-signed. A signed setup needs a certificate, which this project does not have.";
  try {
    const res = await fetch(`https://api.github.com/${RELEASES}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "AgenticOps-Desk" },
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string; html_url?: string };
      return { current, latest: data.tag_name ?? null, url: data.html_url ?? null, note };
    }
    if (res.status !== 404) return { current, latest: null, url: null, note: `GitHub answered ${res.status}. ${note}` };
  } catch {
    /* offline, or GitHub unreachable; try the CLI below */
  }
  // The repository is private, so an anonymous request gets 404. The GitHub CLI's sign-in can see it.
  const viaCli = await run("gh", ["api", RELEASES, "--jq", "[.tag_name, .html_url] | @tsv"], app.getPath("home"));
  if (viaCli.ok && viaCli.output) {
    const [tag, url] = viaCli.output.split("\t");
    return { current, latest: tag || null, url: url || null, note };
  }
  if (/not found|404/i.test(viaCli.output)) return { current, latest: null, url: null, note: `No published release yet. ${note}` };
  return {
    current,
    latest: null,
    url: null,
    note: `Could not check: the repository is private. Sign in with the GitHub CLI (gh auth login) to check for updates. ${note}`,
  };
}
