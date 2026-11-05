import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedRemote, cursorFile, idFromHook } from "./hook-input.mjs";

const cursorHome = path.join(os.homedir(), ".cursor");
const logFile = path.join(cursorHome, "cursor-sync.log");

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  return appendFile(logFile, text).catch(() => undefined);
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 2_000_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({ ok: !err, output: output || (err ? String(err.message) : "") });
      },
    );
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function findTranscript(id) {
  const root = path.join(cursorHome, "projects");
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return "";
  }
  for (const name of names) {
    const file = path.join(root, name, "agent-transcripts", id, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return "";
}

async function ensureCheckout(dir, remote) {
  await mkdir(path.dirname(dir), { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    if (existsSync(dir)) return { ok: false, output: `${dir} exists and is not a git checkout.` };
    const parent = path.dirname(dir);
    await mkdir(parent, { recursive: true });
    const cloned = await git(parent, ["clone", remote, path.basename(dir)]);
    if (!cloned.ok) {
      const empty = /empty repository|warning: You appear to have cloned an empty/i.test(cloned.output);
      if (!empty) return cloned;
      await mkdir(dir, { recursive: true });
      const init = await git(dir, ["init", "-b", "main"]);
      if (!init.ok) return cloned;
      const added = await git(dir, ["remote", "add", "origin", remote]);
      if (!added.ok) return added;
    }
  } else {
    await git(dir, ["remote", "set-url", "origin", remote]);
    const pulled = await git(dir, ["pull", "--rebase", "--autostash", "origin", "HEAD"]);
    if (!pulled.ok && !/couldn't find remote ref|no tracking information|no commits yet/i.test(pulled.output)) {
      return pulled;
    }
  }
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) await writeFile(ignore, "*.tmp\n", "utf8");
  const attrs = path.join(dir, ".gitattributes");
  if (!existsSync(attrs)) await writeFile(attrs, "* -text\n", "utf8");
  return { ok: true, output: "" };
}

async function main() {
  const input = await readStdin();
  const id = idFromHook(input);
  let config;
  try {
    config = JSON.parse(await readFile(path.join(cursorHome, "cursor-sync.json"), "utf8"));
  } catch {
    await log("no ~/.cursor/cursor-sync.json yet");
    process.stdout.write("{}\n");
    return;
  }
  // Missing mode keeps the standalone plugin archiving. The desk writes off, partial, or full.
  const mode = config.mode === "off" || config.mode === "partial" || config.mode === "full" ? config.mode : "partial";
  if (mode === "off") {
    await log("cursor sync is off");
    process.stdout.write("{}\n");
    return;
  }
  const remote = allowedRemote(config.remote);
  if (!remote) {
    await log("cursor-sync.json remote must be https, git@, or ssh");
    process.stdout.write("{}\n");
    return;
  }
  const hinted = cursorFile(cursorHome, input.transcript_path || input.agent_transcript_path || process.env.CURSOR_TRANSCRIPT_PATH);
  const source = hinted || (id ? await findTranscript(id) : "");
  if (!source) {
    await log(`no transcript for ${id || "this turn"}`);
    process.stdout.write("{}\n");
    return;
  }
  const chatId = id || path.basename(source, ".jsonl");
  if (!idFromHook({ conversation_id: chatId })) {
    await log("transcript name is not a chat id");
    process.stdout.write("{}\n");
    return;
  }
  const dir = path.resolve(config.dir || path.join(cursorHome, "cursor-sync-data"));
  const ready = await ensureCheckout(dir, remote);
  if (!ready.ok) {
    await log(ready.output);
    process.stdout.write("{}\n");
    return;
  }
  const destDir = path.join(dir, "chats");
  await mkdir(destDir, { recursive: true });
  const bytes = await readFile(source);
  await writeFile(path.join(destDir, `${chatId}.jsonl`), bytes);
  const workspace = typeof input.cwd === "string" ? input.cwd : "";
  await writeFile(
    path.join(destDir, `${chatId}.json`),
    JSON.stringify({ id: chatId, at: new Date().toISOString(), workspace, bytes: bytes.length }, null, 2),
  );
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.ok) {
    await log(status.output);
    process.stdout.write("{}\n");
    return;
  }
  if (!status.output) {
    process.stdout.write("{}\n");
    return;
  }
  const added = await git(dir, ["add", "--", `chats/${chatId}.jsonl`, `chats/${chatId}.json`]);
  if (!added.ok) {
    await log(added.output);
    process.stdout.write("{}\n");
    return;
  }
  const committed = await git(dir, ["commit", "-m", `Sync chat ${chatId}`]);
  if (!committed.ok && !/nothing to commit/i.test(committed.output)) {
    await log(committed.output);
    process.stdout.write("{}\n");
    return;
  }
  const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = branch.ok && branch.output && branch.output !== "HEAD" ? branch.output.split("\n")[0] : "main";
  const pushed = await git(dir, ["push", "-u", "origin", name]);
  await log(pushed.ok ? `pushed ${chatId}` : pushed.output);
  process.stdout.write("{}\n");
}

main().catch(async (err) => {
  await log(err instanceof Error ? err.message : String(err));
  process.stdout.write("{}\n");
});
