import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";

export type ApprovalQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

export type ApprovalRequest = {
  requestId: string;
  toolName: string;
  summary: string;
  detail: string;
  reason?: string;
  questions?: ApprovalQuestion[];
};

export type ApprovalDecision = {
  allow: boolean;
  always?: boolean;
  answers?: Record<string, string>;
  message?: string;
};

export type ClaudeEvent = {
  kind:
    | "status"
    | "line"
    | "thinking"
    | "tool"
    | "tool_result"
    | "approval"
    | "approval_done"
    | "error"
    | "done";
  text?: string;
  detail?: string;
  id?: string;
  isError?: boolean;
  approval?: ApprovalRequest;
  sessionId?: string;
  running?: boolean;
  phase?: RunPhase;
  chatId?: string;
};

// What the CLI is doing right now, so the UI can tell thinking apart from tool work and writing.
export type RunPhase = "starting" | "thinking" | "tool" | "writing" | "pushing";

type PendingApproval = { toolName: string; input: Record<string, unknown>; suggestions?: unknown[] };

type Session = {
  child: ChildProcess | null;
  claudeSession?: string;
  workspace?: string;
  stopping?: boolean;
  sawText?: boolean;
  lastWasText?: boolean;
  // Whether text arrived after the last tool call, i.e. Claude actually replied at the end.
  textSinceTool?: boolean;
  sawResult?: boolean;
  // With --include-partial-messages the text/thinking arrive as deltas and again in the full message.
  streamedText?: boolean;
  streamedThinking?: boolean;
  block?: { type?: string; name?: string; id?: string; partial: string; label?: string };
  announcedTools?: Set<string>;
  finished?: boolean;
  summary?: string;
  approvals: Map<string, PendingApproval>;
  stderr?: string;
  // A background run that saves memories from this chat; never shown in the chat itself.
  reflector?: ChildProcess;
};

// What survives a restart: the CLI session to resume, and any run that was cut off mid-flight.
type StoredSession = {
  claudeSession?: string;
  workspace?: string;
  pending?: { prompt: string; permissionMode?: string; startedAt: number; started: boolean };
  // Completed runs since Claude last reviewed this chat for things to remember.
  turnsSinceReflect?: number;
};

const sessions = new Map<string, Session>();
let store: Record<string, StoredSession> | null = null;
let shuttingDown = false;

function storeFile() {
  return path.join(app.getPath("userData"), "claude-sessions.json");
}

function loadStore(): Record<string, StoredSession> {
  if (store) return store;
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf8"));
    store = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    store = {};
  }
  return store!;
}

// Sync on purpose: this must land on disk even when the app is quitting.
function persistStore() {
  const file = storeFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(loadStore(), null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    console.error("ClaudeDesk could not save Claude sessions", err);
  }
}

function patchStored(chatId: string, fn: (s: StoredSession) => void) {
  const all = loadStore();
  const cur = all[chatId] ?? {};
  fn(cur);
  all[chatId] = cur;
  persistStore();
}

function sessionFor(chatId: string): Session {
  let session = sessions.get(chatId);
  if (!session) {
    const stored = loadStore()[chatId];
    session = {
      child: null,
      claudeSession: stored?.claudeSession,
      workspace: stored?.workspace,
      approvals: new Map(),
    };
    sessions.set(chatId, session);
  }
  return session;
}

function send(win: BrowserWindow | null, event: ClaudeEvent) {
  if (win && !win.isDestroyed()) win.webContents.send("claude:event", event);
}

// The CLI reads and writes one JSON object per line on stdin/stdout (the Agent SDK's control protocol).
function writeLine(session: Session, msg: unknown) {
  const stdin = session.child?.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
  stdin.write(`${JSON.stringify(msg)}\n`, "utf8");
  return true;
}

function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "PowerShell") return `Run ${toolName === "Bash" ? "a command" : "PowerShell"}`;
  if (toolName === "AskUserQuestion") return "Claude has a question";
  if (toolName === "ExitPlanMode") return "Approve the plan";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
    const file = input.file_path ?? input.notebook_path;
    return typeof file === "string" ? `${toolName} ${path.basename(file)}` : toolName;
  }
  if (toolName.startsWith("mcp__")) return `Use ${toolName.split("__").slice(1).join(" · ")}`;
  return `Use ${toolName}`;
}

function approvalDetail(toolName: string, input: Record<string, unknown>): string {
  const cmd = commandText(input);
  if (cmd) return cmd;
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") return input.plan;
  if (typeof input.file_path === "string") {
    if (typeof input.content === "string") return `${input.file_path}\n\n${input.content.slice(0, 4000)}`;
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      return `${input.file_path}\n\n- ${input.old_string.slice(0, 2000)}\n+ ${input.new_string.slice(0, 2000)}`;
    }
    return input.file_path;
  }
  return JSON.stringify(input, null, 2).slice(0, 6000);
}

function handleControlRequest(
  win: BrowserWindow | null,
  chatId: string,
  session: Session,
  requestId: string,
  request: Record<string, unknown>,
) {
  if (request.subtype !== "can_use_tool") {
    // Nothing else the CLI asks needs our input; answer so it never waits on us.
    writeLine(session, {
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: `Unsupported request ${String(request.subtype)}` },
    });
    return;
  }
  const toolName = String(request.tool_name ?? "tool");
  const input = (request.input && typeof request.input === "object" ? request.input : {}) as Record<string, unknown>;
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : undefined;
  session.approvals.set(requestId, { toolName, input, suggestions });
  const description = typeof input.description === "string" ? input.description : undefined;
  const reason = typeof request.decision_reason === "string" ? request.decision_reason : description;
  const questions = toolName === "AskUserQuestion" && Array.isArray(input.questions)
    ? (input.questions as ApprovalQuestion[])
    : undefined;
  send(win, {
    kind: "approval",
    chatId,
    sessionId: session.claudeSession,
    running: true,
    approval: {
      requestId,
      toolName,
      summary: approvalSummary(toolName, input),
      detail: questions ? "" : approvalDetail(toolName, input),
      reason,
      questions,
    },
  });
  sendPhase(win, chatId, session, "tool", `Waiting for approval: ${toolLabel(toolName, input)}`);
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
}

export function answerApproval(
  win: BrowserWindow | null,
  chatId: string,
  requestId: string,
  decision: ApprovalDecision,
) {
  const session = sessions.get(chatId);
  const pending = session?.approvals.get(requestId);
  if (!session || !pending) return false;
  session.approvals.delete(requestId);
  let response: Record<string, unknown>;
  if (decision.allow) {
    const updatedInput = decision.answers ? { ...pending.input, answers: decision.answers } : pending.input;
    response = { behavior: "allow", updatedInput };
    if (decision.always && pending.suggestions?.length) response.updatedPermissions = pending.suggestions;
  } else {
    response = { behavior: "deny", message: decision.message || "The user denied this in ClaudeDesk." };
  }
  writeLine(session, {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
  send(win, { kind: "approval_done", id: requestId, chatId, running: true });
  if (win && !win.isDestroyed() && ![...sessions.values()].some((s) => s.approvals.size)) win.flashFrame(false);
  return true;
}

function dropApprovals(win: BrowserWindow | null, chatId: string, session: Session) {
  for (const id of session.approvals.keys()) send(win, { kind: "approval_done", id, chatId });
  session.approvals.clear();
}

function toolLabel(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const rec = input as Record<string, unknown>;
  const bit =
    rec.path ??
    rec.file_path ??
    rec.target_directory ??
    rec.command ??
    rec.pattern ??
    rec.query ??
    rec.url;
  if (typeof bit === "string" && bit.trim()) {
    const clipped = bit.replace(/\s+/g, " ").slice(0, 90);
    return `${name} ${clipped}`;
  }
  return name;
}

export function findClaudeCli(): string {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.exe") : "",
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "claude.cmd") : "",
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "claude", "claude.exe"),
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "claude.cmd";
}

function findNode(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "node.exe") : "",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return existsSync("node.exe") ? "node.exe" : null;
}

function findClaudeJs(): string | null {
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code") : "",
    path.join(process.env.LOCALAPPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code"),
  ].filter(Boolean);
  for (const root of roots) {
    for (const name of ["cli.js", "cli.mjs", "dist/cli.js"]) {
      const p = path.join(root, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function quoteArg(s: string) {
  if (!/[ \t"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function spawnHidden(cmd: string, args: string[], cwd: string) {
  return spawn(cmd, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    windowsVerbatimArguments: cmd.toLowerCase().includes("cmd.exe"),
  });
}

function spawnClaude(claudeArgs: string[], cwd: string) {
  const cli = findClaudeCli();
  if (cli.toLowerCase().endsWith(".exe") && existsSync(cli)) {
    return spawnHidden(cli, claudeArgs, cwd);
  }
  const js = findClaudeJs();
  const node = findNode();
  if (js && node) return spawnHidden(node, [js, ...claudeArgs], cwd);
  const comspec = process.env.ComSpec || "cmd.exe";
  const inner = [quoteArg(cli), ...claudeArgs.map(quoteArg)].join(" ");
  return spawnHidden(comspec, ["/d", "/s", "/c", inner], cwd);
}

// child.kill() only ends the direct child; with a cmd.exe or node wrapper the CLI would keep running.
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      /* fall through */
    }
  }
  child.kill();
}

export function probeClaude(): { found: boolean; path: string } {
  const p = findClaudeCli();
  const js = findClaudeJs();
  return { found: existsSync(p) || Boolean(js) || p === "claude.cmd", path: js ?? p };
}

function commandText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const bit = rec.command ?? rec.cmd ?? rec.script;
  return typeof bit === "string" ? bit : "";
}

function pushActivity(blob: string): { phase: RunPhase; text: string } | null {
  if (!/\bgit\b(?:\s+\S+){0,6}?\s+push\b/i.test(blob)) return null;
  const toMain = /\b(main|master)\b/i.test(blob);
  return { phase: "pushing", text: toMain ? "Pushing to main…" : "Pushing…" };
}

function describeTool(name: string, input: unknown): { phase: RunPhase; text: string } {
  return pushActivity(`${commandText(input)} ${toolLabel(name, input)}`) ?? { phase: "tool", text: toolLabel(name, input) };
}

function describePartial(partial: string): { phase: RunPhase; text: string } | null {
  return pushActivity(partial);
}

function sendPhase(
  win: BrowserWindow | null,
  chatId: string,
  session: Session,
  phase: RunPhase,
  text: string,
  alsoTool = false,
) {
  send(win, { kind: "status", text, phase, sessionId: session.claudeSession, chatId, running: true });
  if (alsoTool) send(win, { kind: "tool", text, phase, sessionId: session.claudeSession, chatId, running: true });
}

function announceTool(
  win: BrowserWindow | null,
  chatId: string,
  session: Session,
  name: string,
  input: unknown,
  id?: string,
) {
  if (id && session.announcedTools?.has(id)) return;
  if (id) {
    session.announcedTools ??= new Set();
    session.announcedTools.add(id);
  }
  const activity = describeTool(name, input);
  if (session.block) session.block.label = activity.text;
  session.lastWasText = false;
  sendPhase(win, chatId, session, activity.phase, activity.text, true);
}

function parseStreamLine(line: string, win: BrowserWindow | null, chatId: string, session: Session) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(msg.type ?? "");
    if (typeof msg.session_id === "string" && msg.session_id !== session.claudeSession) {
      session.claudeSession = msg.session_id;
      patchStored(chatId, (s) => {
        s.claudeSession = msg.session_id as string;
        s.workspace = session.workspace;
        if (s.pending) s.pending.started = true;
      });
    }
    const sessionId = session.claudeSession;
    if (type === "control_request") {
      const requestId = String(msg.request_id ?? "");
      const request = (msg.request && typeof msg.request === "object" ? msg.request : {}) as Record<string, unknown>;
      if (requestId) handleControlRequest(win, chatId, session, requestId, request);
      return;
    }
    if (type === "system") {
      const subtype = String(msg.subtype ?? "");
      if (subtype === "init") {
        send(win, { kind: "status", text: "Claude Code started (hidden)", sessionId, chatId, running: true });
      }
      return;
    }
    if (type === "assistant") {
      const content = (msg.message as {
        content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown }>;
      } | undefined)?.content;
      const text = content
        ?.filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");
      if (text && !session.streamedText) {
        // Separate consecutive assistant messages that the renderer would otherwise glue together.
        const prefix = session.lastWasText ? "\n\n" : "";
        sendPhase(win, chatId, session, "writing", "Writing…");
        send(win, { kind: "line", text: prefix + text, phase: "writing", sessionId, chatId, running: true });
        session.sawText = true;
        session.lastWasText = true;
      }
      for (const b of content ?? []) {
        if (b.type === "thinking" && !session.streamedThinking) {
          sendPhase(win, chatId, session, "thinking", "Thinking…");
        }
        if (b.type === "tool_use" && b.name) announceTool(win, chatId, session, b.name, b.input, b.id);
      }
      session.streamedText = false;
      session.streamedThinking = false;
      session.block = undefined;
      return;
    }
    if (type === "stream_event") {
      const ev = msg.event as {
        type?: string;
        content_block?: { type?: string; name?: string; id?: string };
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
      } | undefined;
      if (ev?.type === "content_block_start") {
        const block = ev.content_block;
        session.block = { type: block?.type, name: block?.name, id: block?.id, partial: "" };
        if (block?.type === "thinking") {
          session.streamedThinking = true;
          session.block.label = "Thinking…";
          sendPhase(win, chatId, session, "thinking", "Thinking…");
        } else if (block?.type === "text") {
          session.block.label = "Writing…";
          sendPhase(win, chatId, session, "writing", "Writing…");
        } else if (block?.type === "tool_use" && block.name) {
          session.block.label = block.name;
          sendPhase(win, chatId, session, "tool", block.name);
        }
        return;
      }
      if (ev?.type === "content_block_delta") {
        const delta = ev.delta;
        if (delta?.type === "thinking_delta" || delta?.thinking) {
          session.streamedThinking = true;
          if (session.block?.label !== "Thinking…") {
            if (session.block) session.block.label = "Thinking…";
            sendPhase(win, chatId, session, "thinking", "Thinking…");
          }
          return;
        }
        if ((delta?.type === "text_delta" || delta?.text) && delta?.text) {
          session.streamedText = true;
          session.sawText = true;
          session.lastWasText = true;
          if (session.block?.label !== "Writing…") {
            if (session.block) session.block.label = "Writing…";
            sendPhase(win, chatId, session, "writing", "Writing…");
          }
          send(win, { kind: "line", text: delta.text, phase: "writing", sessionId, chatId, running: true });
          return;
        }
        if (delta?.type === "input_json_delta" && delta.partial_json && session.block) {
          session.block.partial += delta.partial_json;
          const hit = describePartial(session.block.partial);
          if (hit && hit.text !== session.block.label) {
            session.block.label = hit.text;
            if (session.block.id) {
              session.announcedTools ??= new Set();
              session.announcedTools.add(session.block.id);
            }
            sendPhase(win, chatId, session, hit.phase, hit.text, true);
          }
        }
        return;
      }
      if (ev?.type === "content_block_stop" && session.block?.type === "tool_use" && session.block.name) {
        let input: unknown;
        try {
          input = JSON.parse(session.block.partial);
        } catch {
          input = undefined;
        }
        announceTool(win, chatId, session, session.block.name, input, session.block.id);
        session.block = undefined;
      }
      return;
    }
    if (type === "user") {
      sendPhase(win, chatId, session, "thinking", "Thinking…");
      return;
    }
    if (type === "result") {
      const result = typeof msg.result === "string" ? msg.result : "";
      const err = typeof msg.is_error === "boolean" && msg.is_error;
      // The result repeats the final assistant text; only show it if nothing streamed.
      if (result && !err && !session.sawText) send(win, { kind: "line", text: result, sessionId, chatId, running: true });
      if (err && result) send(win, { kind: "error", text: result, sessionId, chatId, running: true });
      return;
    }
  } catch {
    send(win, { kind: "line", text: trimmed, chatId, running: true });
  }
}

export function stopClaude(win: BrowserWindow | null, chatId?: string) {
  if (chatId) {
    const session = sessions.get(chatId);
    if (!session?.child) return;
    const child = session.child;
    session.stopping = true;
    session.child = null;
    killTree(child);
    patchStored(chatId, (s) => delete s.pending);
    dropApprovals(win, chatId, session);
    send(win, { kind: "status", running: false, text: "Stopped.", chatId });
    return;
  }
  for (const id of [...sessions.keys()]) stopClaude(win, id);
}

// Called on quit: kill the CLIs but keep their pending marker so the next launch resumes them.
export function shutdownClaude() {
  shuttingDown = true;
  for (const session of sessions.values()) {
    const child = session.child;
    if (!child) continue;
    session.child = null;
    killTree(child);
  }
}

export function pendingRuns(): Array<{ chatId: string; workspace?: string }> {
  return Object.entries(loadStore())
    .filter(([id, s]) => s.pending && !sessions.get(id)?.child)
    .map(([chatId, s]) => ({ chatId, workspace: s.workspace }));
}

export function resumePendingRun(win: BrowserWindow | null, chatId: string, fallbackWorkspace: string) {
  const stored = loadStore()[chatId];
  const pending = stored?.pending;
  if (!pending) return false;
  const cwd = stored.workspace && existsSync(stored.workspace) ? stored.workspace : fallbackWorkspace;
  // If the CLI never reported a session, the original prompt was never seen; send it again.
  const prompt =
    pending.started && stored.claudeSession
      ? "ClaudeDesk was closed while you were working, which interrupted your previous run. Continue the task exactly where you left off; do not redo finished steps."
      : pending.prompt;
  runClaude({ win, chatId, workspace: cwd, prompt, resume: true, permissionMode: pending.permissionMode });
  return true;
}

export type HistoryMsg = { role: string; text: string };

const HISTORY_LIMIT = 60_000;

// With no CLI session to resume (a Cursor chat, or one the CLI lost), hand Claude the visible transcript.
function withHistory(prompt: string, history?: HistoryMsg[]): string {
  const turns = (history ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`);
  if (!turns.length) return prompt;
  let transcript = turns.join("\n\n");
  if (transcript.length > HISTORY_LIMIT) transcript = `…${transcript.slice(-HISTORY_LIMIT)}`;
  return [
    "This continues an earlier conversation in this chat. The transcript so far:",
    "<conversation>",
    transcript,
    "</conversation>",
    "Keep that conversation in mind and reply to the user's new message:",
    prompt,
  ].join("\n\n");
}

export function runClaude(opts: {
  win: BrowserWindow | null;
  chatId: string;
  workspace: string;
  prompt: string;
  resume?: boolean;
  permissionMode?: string;
  history?: HistoryMsg[];
}) {
  const chatId = opts.chatId;
  const session = sessionFor(chatId);
  if (session.child) stopClaude(opts.win, chatId);

  const resuming = Boolean(opts.resume && session.claudeSession);
  const prompt = resuming ? opts.prompt : withHistory(opts.prompt, opts.history);
  // A CLI session lives under the folder it started in, so resume it there.
  const cwd =
    resuming && session.workspace && existsSync(session.workspace) ? session.workspace : opts.workspace;
  session.workspace = cwd;
  session.stopping = false;
  session.sawText = false;
  session.lastWasText = false;
  session.streamedText = false;
  session.streamedThinking = false;
  session.block = undefined;
  session.announcedTools = new Set();
  session.stderr = "";

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? "acceptEdits",
  ];
  if (resuming) args.push("-r", session.claudeSession!);
  if (!resuming) session.claudeSession = undefined;

  patchStored(chatId, (s) => {
    s.workspace = cwd;
    if (!resuming) delete s.claudeSession;
    s.pending = { prompt: opts.prompt, permissionMode: opts.permissionMode, startedAt: Date.now(), started: false };
  });

  send(opts.win, {
    kind: "status",
    running: true,
    phase: "starting",
    text: resuming ? "Starting…" : "Starting…",
    sessionId: session.claudeSession,
    chatId,
  });

  const child = spawnClaude(args, cwd);
  session.child = child;
  // The prompt goes over stdin: no cmd.exe quoting, newlines survive, no command-line length limit.
  child.stdin?.on("error", () => {});
  child.stdin?.end(prompt, "utf8");

  let buf = "";
  const onChunk = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) parseStreamLine(line, opts.win, chatId, session);
  };

  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    session.stderr = `${session.stderr ?? ""}${text}`.slice(-4000);
    if (text.trim()) send(opts.win, { kind: "error", text, chatId, running: true });
  });
  child.on("error", (err) => {
    if (session.child !== child) return;
    send(opts.win, {
      kind: "error",
      text: `Could not start Claude Code CLI. Install with: npm i -g @anthropic-ai/claude-code\n${err.message}`,
      running: false,
      chatId,
    });
    session.child = null;
    patchStored(chatId, (s) => delete s.pending);
  });
  child.on("close", (code) => {
    // A newer run may already own this chat (or the user stopped this one); don't clobber it.
    if (session.child !== child) {
      if (session.stopping && !session.child) {
        session.stopping = false;
        send(opts.win, { kind: "done", running: false, sessionId: session.claudeSession, chatId, text: "Stopped." });
      }
      return;
    }
    if (buf.trim()) parseStreamLine(buf, opts.win, chatId, session);
    session.child = null;
    if (shuttingDown) return;
    if (resuming && code !== 0 && /no conversation found/i.test(session.stderr ?? "")) {
      session.claudeSession = undefined;
      patchStored(chatId, (s) => delete s.claudeSession);
      send(opts.win, {
        kind: "error",
        text: "The previous Claude Code session no longer exists. Send again to start a new one.",
        chatId,
        running: false,
      });
    }
    patchStored(chatId, (s) => delete s.pending);
    send(opts.win, {
      kind: "done",
      running: false,
      sessionId: session.claudeSession,
      chatId,
      text: code === 0 ? "Done." : `CLI exited ${code ?? "unknown"}`,
    });
  });
}
