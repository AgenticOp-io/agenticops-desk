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
  const added = await run("git", ["add", "-u"], cwd);
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

const shells = new Map<string, ChildProcess>();

export function openShell(cwd: string, onData: (chunk: string) => void): string {
  const id = path.resolve(cwd).toLowerCase();
  const live = shells.get(id);
  if (live && live.exitCode === null && !live.killed) return id;
  const exe = shellExe();
  const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NoExit"] : [];
  const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const push = (buf: Buffer) => onData(buf.toString("utf8"));
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("exit", (code) => {
    onData(`\n[shell closed${code === null ? "" : ` (${code})`}]\n`);
    if (shells.get(id) === child) shells.delete(id);
  });
  shells.set(id, child);
  onData(`Started ${path.basename(exe)} in ${cwd}\n`);
  return id;
}

export function writeShell(id: string, text: string) {
  const child = shells.get(id);
  if (!child?.stdin || child.exitCode !== null) return false;
  child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
  return true;
}

export function closeShell(id: string) {
  const child = shells.get(id);
  if (!child) return;
  shells.delete(id);
  child.kill();
}

export function closeAllShells() {
  for (const id of [...shells.keys()]) closeShell(id);
}

export async function checkForUpdate(): Promise<{ current: string; latest: string | null; url: string | null; note: string }> {
  const current = app.getVersion();
  const note =
    "Installers are not code-signed. A signed setup needs a certificate, which this project does not have.";
  try {
    const res = await fetch("https://api.github.com/repos/AgenticOp-io/claudedesk/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ClaudeDesk" },
    });
    if (!res.ok) return { current, latest: null, url: null, note: `No published release yet. ${note}` };
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    return { current, latest: data.tag_name ?? null, url: data.html_url ?? null, note };
  } catch {
    return { current, latest: null, url: null, note: `Could not reach GitHub. ${note}` };
  }
}
