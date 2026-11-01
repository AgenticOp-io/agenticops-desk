import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import {
  askPermission,
  clearClaudeSession,
  dropApprovals,
  guidePrompt,
  type ImageAttachment,
  pruneChanges,
  realStorePwsh,
  restoreInput,
  secretFileMessage,
  send,
  sendChanges,
  explainWork,
  sendPhase,
  sessionFor,
  snapshotFile,
  stopClaude,
  type HistoryMsg,
  type UsageInfo,
  withHistory,
} from "./claude";
import { prepareMemory } from "./memory";
import { isLocalProvider, LOCAL_ONLY_MESSAGE, privacyMode, privateAppend, protecting, scrubOutgoing } from "./privacy";
import { PRESETS, providerBaseUrl, providerKey, type ProviderId } from "./providers";
import { commandTouchesSecretFile, isSecretFile } from "./redact";

// The Direct engine: ClaudeDesk's own agent loop, talking straight to a model API instead of Claude Code.
// It reuses the chat session for approvals, folder trust, change snapshots and stop handling.

type Neutral = { name: string; description: string; properties: Record<string, unknown>; required: string[] };

const WIN = process.platform === "win32";
// The shell tool runs PowerShell on Windows and the user's shell elsewhere; approvals use the matching tool name.
const SHELL_NAME = WIN ? "PowerShell" : "Bash";
const OS_NAME = WIN ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

const TOOLS: Neutral[] = [
  {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. Use offset/limit for large files.",
    properties: {
      path: { type: "string", description: "File path, relative to the project or absolute" },
      offset: { type: "integer", description: "First line to return (1-based)" },
      limit: { type: "integer", description: "Number of lines to return (default 2000)" },
    },
    required: ["path"],
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Read an existing file before overwriting it.",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true.",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  },
  {
    name: "list_files",
    description: "List files under a folder (recursive, skips node_modules and .git). Optional substring filter on the path.",
    properties: { path: { type: "string" }, filter: { type: "string" } },
    required: [],
  },
  {
    name: "search",
    description: "Search file contents with a regular expression. Returns path:line: text for each match.",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Folder to search (default: project root)" },
      file_filter: { type: "string", description: "Only files whose path contains this text, e.g. .ts" },
    },
    required: ["pattern"],
  },
  {
    name: "run_command",
    description:
      `Run a ${WIN ? "PowerShell" : "shell (bash)"} command in the project folder on ${OS_NAME} and return its output. Use for builds, tests, git and package managers.`,
    properties: {
      command: { type: "string" },
      timeout_seconds: { type: "integer", description: "Default 120, max 600" },
    },
    required: ["command"],
  },
  {
    name: "web_fetch",
    description: "Fetch a public http or https page and return its text (HTML tags stripped, length capped).",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  {
    name: "todo_write",
    description: "Replace the task list the user can see. Each item has content and status: pending, in_progress, or completed.",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string" } },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
];

const SKIP = new Set(["node_modules", ".git", "dist", "dist-electron", "release", ".vite", ".next", "target", "__pycache__"]);
const OUTPUT_LIMIT = 30_000;

type Ctx = {
  win: BrowserWindow | null;
  chatId: string;
  cwd: string;
  roots: string[];
  mode: string;
  signal: AbortSignal;
  session: ReturnType<typeof sessionFor>;
};

function clip(text: string, max = OUTPUT_LIMIT) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut)` : text;
}

function resolveIn(ctx: Ctx, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("path is required");
  const target = path.resolve(ctx.cwd, raw);
  const ok = ctx.roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!ok) throw new Error(`${target} is outside the project folder`);
  return target;
}

async function walk(dir: string, out: string[], max: number) {
  if (out.length >= max) return;
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, max);
    else out.push(full);
  }
}

function shellCommand(command: string): { exe: string; args: string[] } {
  if (!WIN) {
    const sh = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
    return { exe: sh, args: ["-lc", command] };
  }
  const store = realStorePwsh();
  const seven = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  const exe = store ?? (existsSync(seven) ? seven : "powershell.exe");
  return { exe, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
}

function runShell(ctx: Ctx, command: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve) => {
    const { exe, args } = shellCommand(command);
    const child = spawn(exe, args, {
      cwd: ctx.cwd,
      windowsHide: true,
      // Its own process group on macOS and Linux, so stopping it also stops whatever it started.
      detached: !WIN,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let out = "";
    const add = (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > OUTPUT_LIMIT * 2) out = out.slice(-OUTPUT_LIMIT * 2);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill());
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      out += `\n(stopped after ${timeoutSec}s)`;
      kill();
    }, timeoutSec * 1000);
    ctx.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Could not start ${SHELL_NAME}: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(clip(`${out.trim()}\n(exit code ${code ?? "?"})`));
    });
  });
}

// Shell and file changes go through the same gate as Claude Code: folder trust, risky commands, plan mode.
async function allowed(
  ctx: Ctx,
  toolName: string,
  input: Record<string, unknown>,
  id: string,
  readOnly = false,
): Promise<string | null> {
  const editing = toolName === "Edit" || toolName === "Write";
  if (ctx.mode === "plan" && !readOnly) return "Plan mode is on: describe the change instead of making it.";
  if (editing && ctx.mode === "acceptEdits") return null;
  const result = await askPermission(ctx.win, ctx.chatId, ctx.session, toolName, input, {
    signal: ctx.signal,
    requestId: id,
  });
  return result.behavior === "allow" ? null : result.message || "The user denied this.";
}

function str(v: unknown) {
  return typeof v === "string" ? v : undefined;
}

// Privacy Mode around every tool: real values go into the tool, placeholders come back out.
async function runPrivateTool(ctx: Ctx, name: string, input: Record<string, unknown>, id: string): Promise<{ text: string; error?: boolean }> {
  if (!protecting()) return runTool(ctx, name, input, id);
  // A fetched URL leaves this computer, so it keeps the placeholders.
  const real = name === "web_fetch" ? input : restoreInput(input);
  const file = name === "read_file" ? String(real.path ?? "") : name === "run_command" ? commandTouchesSecretFile(String(real.command ?? "")) : "";
  if (file && isSecretFile(file)) return { text: secretFileMessage(file), error: true };
  const r = await runTool(ctx, name, real, id);
  return { ...r, text: scrubOutgoing(r.text).text };
}

async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>, id: string): Promise<{ text: string; error?: boolean }> {
  try {
    if (name === "read_file") {
      const file = resolveIn(ctx, input.path);
      const st = await fs.stat(file);
      if (st.isDirectory()) return { text: `${file} is a folder; use list_files.`, error: true };
      if (st.size > 5_000_000) return { text: `${file} is too large to read (${st.size} bytes).`, error: true };
      const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
      const start = Math.max(1, Number(input.offset) || 1);
      const count = Math.min(5000, Math.max(1, Number(input.limit) || 2000));
      const slice = lines.slice(start - 1, start - 1 + count);
      const body = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join("\n");
      const more = lines.length > start - 1 + count ? `\n… ${lines.length - (start - 1 + count)} more lines` : "";
      return { text: clip(body + more) };
    }
    if (name === "write_file" || name === "edit_file") {
      const file = resolveIn(ctx, input.path);
      const tool = name === "write_file" ? "Write" : "Edit";
      const denied = await allowed(ctx, tool, { file_path: file, ...input }, id);
      if (denied) return { text: denied, error: true };
      snapshotFile(ctx.win, ctx.chatId, ctx.session, ctx.cwd, { file_path: file });
      if (name === "write_file") {
        const content = str(input.content);
        if (content === undefined) return { text: "content must be a string", error: true };
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
        return { text: `Wrote ${content.split("\n").length} lines to ${file}` };
      }
      const oldS = str(input.old_string);
      const newS = str(input.new_string);
      if (oldS === undefined || newS === undefined) return { text: "old_string and new_string must be strings", error: true };
      if (!existsSync(file)) return { text: `${file} does not exist; use write_file to create it.`, error: true };
      const text = readFileSync(file, "utf8");
      // Files on Windows are often CRLF; match the model's LF text against either.
      const crlf = text.includes("\r\n") && !oldS.includes("\r\n");
      const find = crlf ? oldS.replace(/\n/g, "\r\n") : oldS;
      const repl = crlf ? newS.replace(/\n/g, "\r\n") : newS;
      const hits = find ? text.split(find).length - 1 : 0;
      if (hits === 0) return { text: "old_string was not found. Read the file again and copy the text exactly.", error: true };
      if (hits > 1 && input.replace_all !== true) {
        return { text: `old_string appears ${hits} times; add more surrounding text or set replace_all.`, error: true };
      }
      writeFileSync(file, input.replace_all === true ? text.split(find).join(repl) : text.replace(find, () => repl), "utf8");
      return { text: `Edited ${file} (${input.replace_all === true ? hits : 1} replacement${hits > 1 && input.replace_all === true ? "s" : ""})` };
    }
    if (name === "list_files") {
      const dir = input.path ? resolveIn(ctx, input.path) : ctx.cwd;
      const files: string[] = [];
      await walk(dir, files, 3000);
      const filter = str(input.filter)?.toLowerCase();
      const list = files.map((f) => path.relative(ctx.cwd, f)).filter((f) => !filter || f.toLowerCase().includes(filter));
      return { text: clip(list.slice(0, 1000).join("\n") + (list.length > 1000 ? `\n… ${list.length - 1000} more` : "")) || "(no files)" };
    }
    if (name === "search") {
      const pattern = str(input.pattern);
      if (!pattern) return { text: "pattern is required", error: true };
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch (err) {
        return { text: `Invalid regular expression: ${(err as Error).message}`, error: true };
      }
      const dir = input.path ? resolveIn(ctx, input.path) : ctx.cwd;
      const filter = str(input.file_filter)?.toLowerCase();
      const files: string[] = [];
      await walk(dir, files, 5000);
      const hits: string[] = [];
      for (const f of files) {
        if (hits.length >= 300 || ctx.signal.aborted) break;
        if (filter && !f.toLowerCase().includes(filter)) continue;
        let text: string;
        try {
          const st = await fs.stat(f);
          if (st.size > 1_000_000) continue;
          const buf = await fs.readFile(f);
          if (buf.includes(0)) continue;
          text = buf.toString("utf8");
        } catch {
          continue;
        }
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 300 && re.test(line)) hits.push(`${path.relative(ctx.cwd, f)}:${i + 1}: ${line.trim().slice(0, 240)}`);
        });
      }
      return { text: hits.length ? hits.join("\n") : "No matches." };
    }
    if (name === "web_fetch") {
      const url = str(input.url);
      if (!url || !/^https?:\/\//i.test(url)) return { text: "url must start with http:// or https://", error: true };
      // Same gate as Claude Code's WebFetch: an untrusted folder asks first. Reading a page is allowed in plan mode.
      const denied = await allowed(ctx, "WebFetch", { url }, id, true);
      if (denied) return { text: denied, error: true };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const onAbort = () => ctrl.abort();
      ctx.signal.addEventListener("abort", onAbort);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        // Stop reading after 2 MB instead of pulling an arbitrarily large body into memory.
        const limit = 2_000_000;
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = res.body?.getReader();
        while (reader && size < limit) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          size += value.length;
        }
        await reader?.cancel().catch(() => {});
        const raw = Buffer.concat(chunks).subarray(0, limit).toString("utf8");
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { text: clip(`${res.status} ${url}\n${text}`) };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    }
    if (name === "todo_write") {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const items = todos
        .map((row) => {
          const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
          const content = typeof item.content === "string" ? item.content : "";
          const status = typeof item.status === "string" ? item.status : "pending";
          return content ? { content, status } : null;
        })
        .filter((item): item is { content: string; status: string } => Boolean(item));
      send(ctx.win, { kind: "todos", chatId: ctx.chatId, todos: items, running: true });
      return { text: `Task list updated (${items.length})` };
    }
    if (name === "run_command") {
      const command = str(input.command);
      if (!command) return { text: "command is required", error: true };
      const denied = await allowed(ctx, SHELL_NAME, { command }, id);
      if (denied) return { text: denied, error: true };
      const timeout = Math.min(600, Math.max(5, Number(input.timeout_seconds) || 120));
      return { text: await runShell(ctx, command, timeout) };
    }
    return { text: `Unknown tool ${name}`, error: true };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), error: true };
  }
}

function systemPrompt(cwd: string, memory: string) {
  return [
    `You are a coding agent working in the user's project at ${cwd} on ${OS_NAME}.`,
    `Use the tools to read, search and edit files and to run ${WIN ? "PowerShell" : "shell"} commands. Read a file before you edit it.`,
    "Make focused changes that match the surrounding code. Run the project's tests or typecheck when they exist.",
    "When you finish, reply with a short summary of what you changed and anything left to do.",
    memory,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------- persistence: provider-native message history per chat ----------

type Saved = { provider: ProviderId; messages: unknown[] };

function savedFile(chatId: string) {
  return path.join(app.getPath("userData"), "direct", `${chatId.replace(/[^\w.-]+/g, "_")}.json`);
}

// Called when the user deletes a chat, so its direct-engine history goes with it.
export function deleteDirectHistory(chatId: string) {
  rmSync(savedFile(chatId), { force: true });
}

function loadSaved(chatId: string): Saved | null {
  try {
    const raw = JSON.parse(readFileSync(savedFile(chatId), "utf8")) as Saved;
    return raw && Array.isArray(raw.messages) ? raw : null;
  } catch {
    return null;
  }
}

function writeSaved(chatId: string, saved: Saved) {
  const file = savedFile(chatId);
  mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename, so a crash never leaves half a history file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved), "utf8");
  renameSync(tmp, file);
}

// ---------- pricing for the usage meter (USD per million tokens) ----------

const PRICES: Record<string, { input: number; output: number; read: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, read: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, read: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, read: 0.25 },
};

// Refusal fallbacks are opt-in; Claude API supports the "default" routing on these models.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

// ---------- Anthropic loop ----------

async function runAnthropic(ctx: Ctx, model: string, system: string, saved: Saved, prompt: string, images: ImageAttachment[]) {
  const client = new Anthropic({ apiKey: providerKey("anthropic") });
  const messages = saved.messages as Anthropic.Beta.BetaMessageParam[];
  messages.push({
    role: "user",
    content: [
      ...images.map((img) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data },
      })),
      { type: "text" as const, text: prompt },
    ],
  });
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    eager_input_streaming: true,
    input_schema: { type: "object", properties: t.properties, required: t.required },
  }));
  const price = PRICES[model];
  let cost = 0;
  let lastWasText = false;
  let jsonRetries = 0;

  for (let turn = 0; turn < 80 && !ctx.signal.aborted; turn++) {
    const guide = ctx.session.guide;
    if (guide) {
      ctx.session.guide = undefined;
      messages.push({ role: "user", content: guide });
    }
    sendPhase(ctx.win, ctx.chatId, ctx.session, "thinking", "Thinking…");
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        cache_control: { type: "ephemeral" },
        output_config: { effort: "high" },
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: ctx.signal },
    );
    stream.on("text", (delta) => {
      if (!lastWasText) {
        sendPhase(ctx.win, ctx.chatId, ctx.session, "writing", "Writing the reply…");
        lastWasText = true;
      }
      send(ctx.win, { kind: "line", text: delta, phase: "writing", chatId: ctx.chatId, running: true });
    });
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is worth re-issuing; API errors go to the user.
      if (ctx.signal.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }
    const u = message.usage;
    const fresh = u.input_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0;
    const wrote = u.cache_creation_input_tokens ?? 0;
    if (price) cost += (fresh * price.input + wrote * price.input * 1.25 + read * price.read + (u.output_tokens ?? 0) * price.output) / 1e6;
    sendUsage(ctx, { costUsd: cost, contextTokens: fresh + read + wrote, contextWindow: 1_000_000, model: message.model });

    if (message.stop_reason === "refusal") {
      messages.push({ role: "assistant", content: message.content });
      throw new Error("Claude declined this request.");
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      messages.push({ role: "assistant", content: message.content });
      return;
    }
    if (message.stop_reason === "max_tokens") throw new Error("The reply hit the length limit in the middle of a tool call.");
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>;
      const spec = TOOLS.find((t) => t.name === call.name);
      const missing = spec?.required.filter((k) => input[k] === undefined) ?? [];
      lastWasText = false;
      const step = explainWork(call.name, input);
      sendPhase(ctx.win, ctx.chatId, ctx.session, step.phase, step.text, true);
      const r = missing.length
        ? { text: `INVALID_JSON: missing ${missing.join(", ")}`, error: true }
        : await runPrivateTool(ctx, call.name, input, call.id);
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.text, ...(r.error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
}

// ---------- OpenAI-compatible loop (OpenAI, OpenRouter, Gemini, Ollama) ----------

async function runOpenAI(ctx: Ctx, provider: ProviderId, model: string, system: string, saved: Saved, prompt: string, images: ImageAttachment[]) {
  const client = new OpenAI({ apiKey: providerKey(provider) || "local", baseURL: providerBaseUrl(provider) });
  const messages = saved.messages as OpenAI.Chat.ChatCompletionMessageParam[];
  if (!messages.length || messages[0].role !== "system") messages.unshift({ role: "system", content: system });
  else messages[0] = { role: "system", content: system };
  messages.push({
    role: "user",
    content: images.length
      ? [
          ...images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          { type: "text" as const, text: prompt },
        ]
      : prompt,
  });
  const tools: OpenAI.Chat.ChatCompletionTool[] = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: { type: "object", properties: t.properties, required: t.required } },
  }));

  for (let turn = 0; turn < 80 && !ctx.signal.aborted; turn++) {
    const guide = ctx.session.guide;
    if (guide) {
      ctx.session.guide = undefined;
      messages.push({ role: "user", content: guide });
    }
    sendPhase(ctx.win, ctx.chatId, ctx.session, "thinking", "Thinking…");
    const stream = await client.chat.completions.create(
      { model, messages, tools, stream: true, stream_options: { include_usage: true } },
      { signal: ctx.signal },
    );
    let text = "";
    const calls: Array<{ id: string; name: string; args: string }> = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        if (!text) sendPhase(ctx.win, ctx.chatId, ctx.session, "writing", "Writing the reply…");
        text += delta.content;
        send(ctx.win, { kind: "line", text: delta.content, phase: "writing", chatId: ctx.chatId, running: true });
      }
      for (const tc of delta?.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (chunk.usage) {
        sendUsage(ctx, { costUsd: 0, contextTokens: chunk.usage.prompt_tokens ?? 0, contextWindow: 0, model });
      }
    }
    const live = calls.filter(Boolean);
    messages.push({
      role: "assistant",
      content: text || null,
      ...(live.length
        ? { tool_calls: live.map((c, i) => ({ id: c.id || `call_${turn}_${i}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } })) }
        : {}),
    });
    if (!live.length) return;
    for (const [i, c] of live.entries()) {
      const id = c.id || `call_${turn}_${i}`;
      let input: Record<string, unknown> = {};
      let bad = "";
      try {
        input = JSON.parse(c.args || "{}");
      } catch {
        bad = "INVALID_JSON: the tool arguments were not valid JSON.";
      }
      const step = explainWork(c.name, input);
      sendPhase(ctx.win, ctx.chatId, ctx.session, step.phase, step.text, true);
      const r = bad ? { text: bad } : await runPrivateTool(ctx, c.name, input, id);
      messages.push({ role: "tool", tool_call_id: id, content: r.text });
    }
    text = "";
  }
}

function sendUsage(ctx: Ctx, usage: UsageInfo) {
  send(ctx.win, { kind: "usage", usage, chatId: ctx.chatId, running: true });
}

// ---------- entry point ----------

export function runDirect(opts: {
  win: BrowserWindow | null;
  chatId: string;
  workspace: string;
  prompt: string;
  provider: ProviderId;
  model: string;
  permissionMode?: string;
  history?: HistoryMsg[];
  images?: ImageAttachment[];
}) {
  const { win, chatId } = opts;
  const session = sessionFor(chatId);
  if (privacyMode() === "local" && !isLocalProvider(opts.provider)) {
    send(win, { kind: "error", text: LOCAL_ONLY_MESSAGE, chatId, running: false });
    send(win, { kind: "done", text: "Stopped.", chatId, running: false });
    return;
  }
  if (session.engine === "direct" && session.abort && !session.query && !session.child && !session.stopping) {
    session.guide = [session.guide, guidePrompt(scrubOutgoing(opts.prompt).text)].filter(Boolean).join("\n\n");
    send(win, { kind: "status", running: true, phase: "thinking", text: "Following your instruction…", chatId });
    return;
  }
  if (session.child || session.query || session.abort) stopClaude(win, chatId);
  const preset = PRESETS[opts.provider];
  if (preset.needsKey && !providerKey(opts.provider)) {
    send(win, { kind: "error", text: `Add an API key for ${preset.label} in Settings first.`, chatId, running: false });
    send(win, { kind: "done", text: "Stopped.", chatId, running: false });
    return;
  }

  const cwd = opts.workspace;
  session.workspace = cwd;
  session.engine = "direct";
  session.stopping = false;
  // The next Claude Code message must not resume a session that missed this chat's direct turns.
  clearClaudeSession(chatId, session);
  const abort = new AbortController();
  session.abort = abort;
  const memory = prepareMemory(cwd);
  const system = systemPrompt(cwd, privateAppend(memory.append));
  const prior = loadSaved(chatId);
  // Same provider: continue its native history. Otherwise hand over the visible transcript as text.
  const sameProvider = prior?.provider === opts.provider;
  const saved: Saved = sameProvider ? prior! : { provider: opts.provider, messages: [] };
  const scrubbed = scrubOutgoing(sameProvider ? opts.prompt : withHistory(opts.prompt, opts.history));
  const prompt = scrubbed.text;
  const starting = scrubbed.hidden ? `Hid ${scrubbed.hidden} secret${scrubbed.hidden > 1 ? "s" : ""} before sending. Starting…` : "Starting…";
  send(win, { kind: "status", running: true, phase: "starting", text: starting, chatId });
  const ctx: Ctx = {
    win,
    chatId,
    cwd,
    roots: [cwd, ...memory.directories],
    mode: opts.permissionMode ?? "default",
    signal: abort.signal,
    session,
  };

  void (async () => {
    let failed = "";
    try {
      if (preset.kind === "anthropic") await runAnthropic(ctx, opts.model, system, saved, prompt, opts.images ?? []);
      else await runOpenAI(ctx, opts.provider, opts.model, system, saved, prompt, opts.images ?? []);
    } catch (err) {
      if (!abort.signal.aborted) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
          failed = `${preset.label} rejected the API key. Check it in Settings.`;
        } else if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
          failed = `${preset.label}: ${err.message}`;
        } else {
          failed = err instanceof Error ? err.message : String(err);
        }
      }
    } finally {
      try {
        writeSaved(chatId, saved);
      } catch (err) {
        console.error("ClaudeDesk could not save the direct chat", err);
      }
      const stopped = abort.signal.aborted;
      if (session.abort === abort) session.abort = undefined;
      session.stopping = false;
      dropApprovals(win, chatId, session);
      pruneChanges(session);
      sendChanges(win, chatId, session);
      if (failed) send(win, { kind: "error", text: failed, chatId, running: false });
      send(win, { kind: "done", running: false, chatId, text: stopped || failed ? "Stopped." : "Done." });
    }
  })();
}
