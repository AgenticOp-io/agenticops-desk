import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { recordActivity } from "./activityLog";
import { realStorePwsh } from "./claude";
import { quietThreads } from "./resourceGuard";
import { cliPromptEnv, commandDetachedForGui, isNewerVersion, isReleaseTag, newestTag, newPairCode, parsePorcelain, remoteWeb, sealPairing } from "./pureFeatures";

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
      { cwd, windowsHide: true, timeout, maxBuffer: 2_000_000, env: { ...process.env, ...cliPromptEnv(), ...extraEnv } },
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

// Source control for the Code window. Paths arrive from the window, so each must stay inside the repo.
function relPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || !paths.length) return null;
  const ok = paths.every((p) => typeof p === "string" && p && !path.isAbsolute(p) && !p.startsWith("-") && !p.split(/[\\/]/).includes(".."));
  // Status paths are relative to the repo root, which may sit above the open folder.
  return ok ? (paths as string[]).map((p) => `:(top)${p}`) : null;
}
const badPaths = { ok: false, output: "Those paths are not in this repository." };

// stdout only, untrimmed: run() appends stderr warnings (line endings) that would read as files.
function gitOut(cwd: string, args: string[]) {
  return new Promise<string | null>((resolve) =>
    execFile("git", args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 20_000_000, env: { ...process.env, ...cliPromptEnv() } }, (err, stdout) => resolve(err ? null : stdout)),
  );
}

export async function gitChanges(cwd: string) {
  const [status, remote, head, top] = await Promise.all([
    gitOut(cwd, ["status", "--porcelain=v1", "-b", "-z", "-uall"]),
    gitOut(cwd, ["remote", "get-url", "origin"]),
    gitOut(cwd, ["rev-parse", "HEAD"]),
    gitOut(cwd, ["rev-parse", "--show-toplevel"]),
  ]);
  if (status === null) return { ok: false, output: "", repo: false };
  return { ok: true, output: "", repo: true, ...parsePorcelain(status), head: head?.trim() ?? "", root: top?.trim() ?? "", remote: remote ? remoteWeb(remote) : null };
}

export function gitStage(cwd: string, paths: unknown) {
  const list = relPaths(paths);
  return list ? runGit(cwd, ["add", "-A", "--", ...list]) : Promise.resolve(badPaths);
}

export async function gitUnstage(cwd: string, paths: unknown) {
  const list = relPaths(paths);
  if (!list) return badPaths;
  const r = await runGit(cwd, ["reset", "-q", "HEAD", "--", ...list]);
  // No commits yet: there is no HEAD to reset to.
  return r.ok ? r : runGit(cwd, ["rm", "--cached", "-q", "-r", "--", ...list]);
}

// Throws away edits. The window asks first.
export async function gitDiscard(cwd: string, paths: unknown, untracked: unknown) {
  const list = relPaths(paths);
  if (!list) return badPaths;
  const r = untracked === true ? await runGit(cwd, ["clean", "-f", "-q", "--", ...list]) : await runGit(cwd, ["checkout", "-q", "HEAD", "--", ...list]);
  return gitActivity("discard", r);
}

// Settle a merge conflict by keeping our side or theirs for whole files, then stage the result.
export async function gitResolve(cwd: string, paths: unknown, side: unknown) {
  const list = relPaths(paths);
  if (!list || (side !== "ours" && side !== "theirs")) return badPaths;
  const r = await runGit(cwd, ["checkout", `--${side}`, "--", ...list]);
  return r.ok ? gitActivity("resolve", await runGit(cwd, ["add", "--", ...list])) : r;
}

// The file as committed at HEAD; empty for a new file.
export async function gitShowHead(cwd: string, file: unknown) {
  if (!relPaths([file])) return "";
  // Untrimmed, or a lost final newline would show as a change.
  return (await gitOut(cwd, ["show", `HEAD:${String(file).replace(/\\/g, "/")}`])) ?? "";
}

export async function gitBranches(cwd: string) {
  const out = await gitOut(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(upstream:short)%09%(HEAD)", "refs/heads", "refs/remotes"]);
  return (out ?? "")
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([ref]) => ref && !ref.endsWith("/HEAD"))
    .map(([ref, upstream = "", head = ""]) => ({ name: ref.replace(/^refs\/(heads|remotes)\//, ""), remote: ref.startsWith("refs/remotes/"), upstream, current: head === "*" }));
}

export async function gitLog(cwd: string) {
  const out = await gitOut(cwd, ["log", "-60", "--format=%H%x09%h%x09%an%x09%ar%x09%D%x09%s"]);
  return out
    ? out.split("\n").filter(Boolean).map((l) => { const [sha, short, author, when, refs, ...s] = l.split("\t"); return { sha, short, author, when, refs, subject: s.join("\t") }; })
    : [];
}

export async function gitCommitWith(cwd: string, message: string, opts: { all?: boolean; amend?: boolean }) {
  const text = message.trim();
  if (!text && !opts.amend) return { ok: false, output: "Write a commit message first." };
  if (opts.all) {
    const added = await run("git", ["add", "-A"], cwd);
    if (!added.ok) return gitActivity("commit", added);
  }
  const args = ["commit", ...(opts.amend ? ["--amend"] : []), ...(text ? ["-m", text] : ["--no-edit"])];
  return gitActivity("commit", await run("git", args, cwd));
}

// A branch with no upstream yet is published to origin.
export function gitPublish(cwd: string) {
  return runGit(cwd, ["push", "-u", "origin", "HEAD"], 120_000).then((r) => gitActivity("push", r));
}

export function gitNewBranch(cwd: string, branch: string) {
  const name = branchName(branch);
  if (!name) return Promise.resolve({ ok: false, output: "Branch name is not valid." });
  return runGit(cwd, ["checkout", "-b", name]).then((r) => gitActivity("branch", r));
}

// Pull and merge requests through the host's own CLI (gh, glab) when it is installed and signed in.
function cliJson<T>(cmd: string, args: string[], cwd: string) {
  return new Promise<{ rows: T[] | null; error: string }>((resolve) =>
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 20_000_000 }, (err, stdout, stderr) => {
      try {
        resolve(err ? { rows: null, error: (stderr || err.message).trim() } : { rows: JSON.parse(stdout) as T[], error: "" });
      } catch {
        resolve({ rows: null, error: "Could not read the list." });
      }
    }),
  );
}

export async function gitPullRequests(cwd: string, kind: string) {
  if (kind === "github") {
    type Row = { number: number; title: string; headRefName: string; author?: { login?: string }; url: string };
    const { rows, error } = await cliJson<Row>("gh", ["pr", "list", "--limit", "30", "--json", "number,title,headRefName,author,url"], cwd);
    return { ok: !!rows, output: error, prs: (rows ?? []).map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, author: p.author?.login ?? "", url: p.url })) };
  }
  if (kind === "gitlab") {
    type Row = { iid: number; title: string; source_branch: string; author?: { username?: string }; web_url: string };
    const { rows, error } = await cliJson<Row>("glab", ["mr", "list", "-F", "json"], cwd);
    return { ok: !!rows, output: error, prs: (rows ?? []).map((p) => ({ number: p.iid, title: p.title, branch: p.source_branch, author: p.author?.username ?? "", url: p.web_url })) };
  }
  if (kind === "azure") {
    type Row = { pullRequestId: number; title: string; sourceRefName: string; createdBy?: { uniqueName?: string }; repository?: { webUrl?: string } };
    const { rows, error } = await cliJson<Row>("az", ["repos", "pr", "list", "--output", "json"], cwd);
    return { ok: !!rows, output: error, prs: (rows ?? []).map((p) => ({ number: p.pullRequestId, title: p.title, branch: p.sourceRefName.replace(/^refs\/heads\//, ""), author: p.createdBy?.uniqueName ?? "", url: `${p.repository?.webUrl ?? ""}/pullrequest/${p.pullRequestId}` })) };
  }
  return { ok: false, output: "Bitbucket has no command-line tool for this; open the list on the web.", prs: [] };
}

export function gitPrCheckout(cwd: string, kind: string, num: unknown) {
  const n = Number(num);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve({ ok: false, output: "Not a pull request number." });
  const cmd = kind === "gitlab" ? ["glab", ["mr", "checkout", String(n)]] as const : kind === "azure" ? ["az", ["repos", "pr", "checkout", "--id", String(n)]] as const : ["gh", ["pr", "checkout", String(n)]] as const;
  return run(cmd[0], [...cmd[1]], cwd, 120_000).then((r) => gitActivity("pr-checkout", r));
}

// Your repositories on GitHub, for the clone picker.
export async function githubRepos() {
  const { rows } = await cliJson<{ nameWithOwner: string; url: string; description: string }>("gh", ["repo", "list", "--limit", "100", "--json", "nameWithOwner,url,description"], app.getPath("home"));
  return rows ?? [];
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
    env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", ...quietThreads() },
    // Its own process group on macOS and Linux, so Restart also stops what it started.
    detached: process.platform !== "win32",
  });
  const entry: Shell = { child, backlog: "", onData, usedAt: Date.now() };
  // One message per 50 ms, not one per chunk: a chatty command sent thousands a second and froze the window.
  let pending = "";
  let flush: ReturnType<typeof setTimeout> | null = null;
  const push = (text: string) => {
    entry.backlog = (entry.backlog + text).slice(-BACKLOG);
    pending = (pending + text).slice(-BACKLOG);
    flush ??= setTimeout(() => {
      flush = null;
      const out = pending;
      pending = "";
      entry.onData(out);
    }, 50);
  };
  child.stdout?.on("data", (buf: Buffer) => push(buf.toString("utf8")));
  child.stderr?.on("data", (buf: Buffer) => push(buf.toString("utf8")));
  child.on("error", (err) => push(`\n[could not start the shell: ${err.message}]\n`));
  child.on("exit", (code) => {
    push(`\n[shell closed${code === null ? "" : ` (${code})`}]\n`);
    if (shells.get(id) === entry) shells.delete(id);
  });
  shells.set(id, entry);
  // Backlog only: the tab gets it with the id, and a batched send would arrive after and print it twice.
  entry.backlog = `Started ${path.basename(exe)} in ${cwd}\n`;
  const extra = [...shells.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, Math.max(0, shells.size - MAX_SHELLS));
  for (const [oldId] of extra) closeShell(oldId);
  return { id, backlog: entry.backlog };
}

export function writeShell(id: string, text: string) {
  const entry = shells.get(id);
  if (!entry?.child.stdin || entry.child.exitCode !== null) return false;
  entry.usedAt = Date.now();
  // A local app typed here gets its own window. The shell returns instead of waiting on that window.
  const sent = commandDetachedForGui("PowerShell", text.trim()) ?? text;
  entry.child.stdin.write(sent.endsWith("\n") ? sent : `${sent}\n`);
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

// Pairs the phone app without an OAuth app: a QR code carrying this computer's GitHub CLI sign-in, which the phone scans.
// Only the image reaches the renderer, never the token text. The token is encrypted under a one-time code shown beside the QR (sealPairing).
export async function phonePairQr(): Promise<{ ok: boolean; image?: string; login?: string; code?: string; error?: string }> {
  const token = await githubToken();
  const me = token ? await run("gh", ["api", "user", "--jq", `.login + " " + (.id|tostring)`], app.getPath("home"), 20_000) : null;
  const [login, id] = me?.ok ? me.output.trim().split(" ") : [];
  if (!token || !login || !id) return { ok: false, error: "Sign in to GitHub on this computer first (Settings → Accounts)." };
  const QR = await import("qrcode");
  const code = newPairCode();
  // The phone's whole setup comes from here: the API key for its AI chat and a cloud-agent login, when the desk has them.
  const ai = (await import("./providers")).providerKey("anthropic");
  const login2 = await (await import("./pool")).phoneCloudLogin().catch(() => undefined);
  // The phone's client certificate and key go in as bare base64 DER (no PEM armour), to keep the QR small.
  const der = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");
  const cloud = login2 && { url: login2.url, token: login2.token, pin: login2.pin, key: der(login2.keyPem), cert: der(login2.certPem) };
  const sync = await import("./deskSync");
  // sign: the key the phone seals its inbox messages with; without it the desk runs nothing the phone sends.
  const sign = (await sync.phoneKey(true).catch((e: Error) => e)) as Buffer | Error;
  if (sign instanceof Error) return { ok: false, error: sign.message };
  const setup = { sign: sign!.toString("base64url"), ...(ai ? { ai } : {}), ...(cloud ? { cloud } : {}) };
  const image = await QR.toDataURL(sealPairing(login, id, token, code, await sync.phoneRepos(), setup), { errorCorrectionLevel: "L", margin: 2, width: 480 });
  return { ok: true, image, login, code };
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
