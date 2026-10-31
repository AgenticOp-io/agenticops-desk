import { query, type PermissionResult, type PermissionUpdate, type Query, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { permissionGate, rememberRisks, trustWorkspace } from "./allows";
import { prepareMemory } from "./memory";

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
  canAlways?: boolean;
  remember?: boolean;
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
export type RunPhase = "starting" | "thinking" | "tool" | "writing" | "pushing" | "approval";

type PendingApproval = {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  gate: "trust" | "risk" | "question";
  risks?: string[];
  settled?: boolean;
  resolve: (result: PermissionResult) => void;
};

type Session = {
  child: ChildProcess | null;
  abort?: AbortController;
  query?: Query;
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
  // Shell decisions already shown in the dialog, so a later canUseTool for the same call is not asked twice.
  decisions: Map<string, PermissionResult>;
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
      decisions: new Map(),
    };
    sessions.set(chatId, session);
  }
  return session;
}

function send(win: BrowserWindow | null, event: ClaudeEvent) {
  if (win && !win.isDestroyed()) win.webContents.send("claude:event", event);
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

function settleApproval(session: Session, requestId: string, result: PermissionResult): boolean {
  const pending = session.approvals.get(requestId);
  if (!pending || pending.settled) return false;
  pending.settled = true;
  session.approvals.delete(requestId);
  pending.resolve(result);
  return true;
}

function askPermission(
  win: BrowserWindow | null,
  chatId: string,
  session: Session,
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    decisionReason?: string;
    title?: string;
    description?: string;
    suppressAlwaysAllowRule?: boolean;
    requestId: string;
  },
): Promise<PermissionResult> {
  const requestId = options.requestId;
  const questions =
    toolName === "AskUserQuestion" && Array.isArray(input.questions) ? (input.questions as ApprovalQuestion[]) : undefined;
  const description = typeof input.description === "string" ? input.description : undefined;
  const gate = permissionGate(session.workspace, toolName, input);
  if (!gate.ask) return Promise.resolve({ behavior: "allow", updatedInput: input });
  const summary = gate.kind === "question" ? options.title || approvalSummary(toolName, input) : gate.summary;
  const reason =
    gate.kind === "question" ? options.decisionReason || options.description || description : gate.note;
  return new Promise((resolve) => {
    session.approvals.set(requestId, {
      toolName,
      input,
      suggestions: options.suggestions,
      gate: gate.kind,
      risks: gate.kind === "risk" ? gate.risks : undefined,
      resolve,
    });
    send(win, {
      kind: "approval",
      chatId,
      sessionId: session.claudeSession,
      running: true,
      phase: "approval",
      approval: {
        requestId,
        toolName,
        summary,
        detail: questions ? "" : approvalDetail(toolName, input),
        reason,
        questions,
        canAlways: gate.kind === "question" && !options.suppressAlwaysAllowRule && Boolean(options.suggestions?.length),
      },
    });
    sendPhase(win, chatId, session, "approval", `Needs permission: ${toolLabel(toolName, input)}`);
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    const deny = () => {
      if (!settleApproval(session, requestId, { behavior: "deny", message: "Stopped before approval." })) return;
      send(win, { kind: "approval_done", id: requestId, chatId, running: true });
    };
    if (options.signal.aborted) deny();
    else options.signal.addEventListener("abort", deny, { once: true });
  });
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
  if (decision.allow && pending.gate === "trust") trustWorkspace(session.workspace);
  if (decision.allow && pending.gate === "risk") rememberRisks(session.workspace, pending.risks ?? []);
  const result: PermissionResult = decision.allow
    ? {
        behavior: "allow",
        updatedInput: decision.answers ? { ...pending.input, answers: decision.answers } : pending.input,
        ...(decision.always && pending.suggestions?.length ? { updatedPermissions: pending.suggestions } : {}),
      }
    : { behavior: "deny", message: decision.message || "The user denied this in ClaudeDesk." };
  if (!settleApproval(session, requestId, result)) return false;
  send(win, { kind: "approval_done", id: requestId, chatId, running: true });
  if (win && !win.isDestroyed() && ![...sessions.values()].some((s) => s.approvals.size)) win.flashFrame(false);
  if (session.abort) sendPhase(win, chatId, session, "thinking", "Thinking…");
  return true;
}

function dropApprovals(win: BrowserWindow | null, chatId: string, session: Session) {
  for (const [id, pending] of session.approvals) {
    if (!pending.settled) {
      pending.settled = true;
      pending.resolve({ behavior: "deny", message: "Stopped before approval." });
    }
    send(win, { kind: "approval_done", id, chatId });
  }
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

function spawnHidden(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return spawn(cmd, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    signal,
  });
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
    if (type === "control_request") return;
    if (type === "system") {
      const subtype = String(msg.subtype ?? "");
      if (subtype === "init") {
        send(win, { kind: "status", text: "Claude Code started", sessionId, chatId, running: true, phase: "thinking" });
      } else if (subtype === "permission_denied") {
        const message = typeof msg.message === "string" ? msg.message : "Permission denied";
        if (!/denied this in ClaudeDesk|Stopped before approval/i.test(message)) {
          send(win, { kind: "error", text: message, sessionId, chatId, running: true });
        }
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
      if (!session.approvals.size) sendPhase(win, chatId, session, "thinking", "Thinking…");
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

function endRun(session: Session) {
  const child = session.child;
  const running = session.query;
  session.child = null;
  session.query = undefined;
  session.abort?.abort();
  session.abort = undefined;
  try {
    running?.close();
  } catch {
    /* already closed */
  }
  if (child) killTree(child);
}

export function stopClaude(win: BrowserWindow | null, chatId?: string) {
  if (chatId) {
    const session = sessions.get(chatId);
    if (!session?.child && !session?.query && !session?.abort) return;
    session.stopping = true;
    dropApprovals(win, chatId, session);
    endRun(session);
    patchStored(chatId, (s) => delete s.pending);
    send(win, { kind: "status", running: false, text: "Stopped.", chatId });
    return;
  }
  for (const id of [...sessions.keys()]) stopClaude(win, id);
}

// Called on quit: kill the CLIs but keep their pending marker so the next launch resumes them.
export function shutdownClaude() {
  shuttingDown = true;
  for (const session of sessions.values()) {
    session.stopping = true;
    for (const pending of session.approvals.values()) {
      if (pending.settled) continue;
      pending.settled = true;
      pending.resolve({ behavior: "deny", message: "ClaudeDesk is closing." });
    }
    session.approvals.clear();
    endRun(session);
  }
}

export function pendingRuns(): Array<{ chatId: string; workspace?: string }> {
  return Object.entries(loadStore())
    .filter(([id, s]) => s.pending && !sessions.get(id)?.query && !sessions.get(id)?.abort)
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

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk"]);

function chosenPermissionMode(raw?: string) {
  if (raw && PERMISSION_MODES.has(raw)) return raw as "default" | "acceptEdits" | "plan" | "auto" | "dontAsk";
  return "default" as const;
}

function gitBashPath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH ?? "",
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

// The Microsoft Store execution alias is a 0-byte stub. Claude's PowerShell parser launches
// it with a long EncodedCommand and Windows answers "The command line is too long."
// The real pwsh.exe inside WindowsApps accepts that command line.
function realStorePwsh(): string | undefined {
  const alias = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "pwsh.exe");
  if (!existsSync(alias)) return undefined;
  let out = "";
  try {
    out = execFileSync("fsutil", ["reparsepoint", "query", alias], { encoding: "utf8", windowsHide: true });
  } catch {
    return undefined;
  }
  const bytes: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const hexes = line.match(/^[0-9a-f]{4}:\s+((?:[0-9a-f]{2}\s+){1,16})/i)?.[1];
    if (!hexes) continue;
    for (const hex of hexes.trim().split(/\s+/)) bytes.push(Number.parseInt(hex, 16));
  }
  const text = Buffer.from(bytes).toString("utf16le");
  const found = text.match(/[A-Z]:\\Program Files\\WindowsApps\\Microsoft\.PowerShell_[^\u0000]+?\\pwsh\.exe/i);
  return found && existsSync(found[0]) ? found[0] : undefined;
}

function storePwshAliasOnly(): boolean {
  if (process.platform !== "win32") return false;
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const real = [
    path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
    path.join(os.homedir(), ".dotnet", "tools", "pwsh.exe"),
  ];
  if (real.some((p) => existsSync(p))) return false;
  return existsSync(path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "pwsh.exe"));
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
  if (session.child || session.query || session.abort) stopClaude(opts.win, chatId);

  // A later message in this chat continues the same Claude session, so "yes" still refers to the last turn.
  const resuming = Boolean(session.claudeSession);
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
  session.decisions = new Map();
  session.stderr = "";

  const mode = chosenPermissionMode(opts.permissionMode);
  if (!resuming) session.claudeSession = undefined;
  const bash = gitBashPath();
  const pwsh = realStorePwsh();
  const skipStorePwsh = !pwsh && storePwshAliasOnly() && Boolean(bash);

  patchStored(chatId, (s) => {
    s.workspace = cwd;
    if (!resuming) delete s.claudeSession;
    s.pending = { prompt: opts.prompt, permissionMode: mode, startedAt: Date.now(), started: false };
  });

  send(opts.win, {
    kind: "status",
    running: true,
    phase: "starting",
    text: "Starting…",
    sessionId: session.claudeSession,
    chatId,
  });

  const abort = new AbortController();
  session.abort = abort;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "ClaudeDesk",
    ...(bash ? { CLAUDE_CODE_GIT_BASH_PATH: bash } : {}),
    ...(pwsh ? { PATH: `${path.dirname(pwsh)};${process.env.PATH ?? ""}` } : {}),
  };
  const memory = prepareMemory(cwd);
  const q = query({
    prompt,
    options: {
      cwd,
      abortController: abort,
      resume: resuming ? session.claudeSession : undefined,
      permissionMode: mode,
      permissionPrompts: "host",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: memory.append, snapshot: false },
      ...(memory.directories.length ? { additionalDirectories: memory.directories } : {}),
      tools: { type: "preset", preset: "claude_code" },
      ...(skipStorePwsh ? { disallowedTools: ["PowerShell"] } : {}),
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|PowerShell",
            timeout: 3600,
            hooks: [
              async (input, _toolUseId, { signal }) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const toolInput =
                  input.tool_input && typeof input.tool_input === "object"
                    ? (input.tool_input as Record<string, unknown>)
                    : {};
                const requestId = input.tool_use_id || _toolUseId || `shell-${Date.now()}`;
                const result = await askPermission(opts.win, chatId, session, input.tool_name, toolInput, {
                  signal,
                  requestId,
                });
                session.decisions.set(requestId, result);
                if (result.behavior === "deny") {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: result.message,
                    },
                  };
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                    ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
                  },
                };
              },
            ],
          },
        ],
      },
      env,
      stderr: (data) => {
        session.stderr = `${session.stderr ?? ""}${data}`.slice(-4000);
      },
      spawnClaudeCodeProcess: (spec) => {
        const child = spawnHidden(spec.command, spec.args, spec.cwd ?? cwd, spec.env as NodeJS.ProcessEnv, spec.signal);
        child.stdin?.on("error", () => {});
        if (session.abort === abort) session.child = child;
        return child as unknown as SpawnedProcess;
      },
      canUseTool: (toolName, input, toolOpts) => {
        const prior = session.decisions.get(toolOpts.toolUseID) ?? session.decisions.get(toolOpts.requestId);
        if (prior) return Promise.resolve(prior);
        return askPermission(opts.win, chatId, session, toolName, input, toolOpts);
      },
    },
  });
  session.query = q;

  void (async () => {
    let failed = "";
    try {
      for await (const msg of q) {
        if (session.query !== q) return;
        parseStreamLine(JSON.stringify(msg), opts.win, chatId, session);
      }
    } catch (err) {
      if (session.query !== q) return;
      failed = err instanceof Error ? err.message : String(err);
      if (resuming && /no conversation found/i.test(`${failed}\n${session.stderr ?? ""}`)) {
        session.claudeSession = undefined;
        patchStored(chatId, (s) => delete s.claudeSession);
        failed = "The previous Claude Code session no longer exists. Send again to start a new one.";
      } else if (!session.stopping && !shuttingDown) {
        const tail = (session.stderr ?? "").trim().slice(-500);
        if (tail && !failed.includes(tail)) failed = `${failed}\n${tail}`;
      } else {
        failed = "";
      }
    } finally {
      if (session.query !== q) {
        if (session.stopping && !session.query) {
          session.stopping = false;
          send(opts.win, { kind: "done", running: false, sessionId: session.claudeSession, chatId, text: "Stopped." });
        }
        return;
      }
      session.query = undefined;
      session.abort = undefined;
      session.child = null;
      if (shuttingDown) return;
      dropApprovals(opts.win, chatId, session);
      if (failed) {
        send(opts.win, { kind: "error", text: failed, chatId, running: false });
      }
      patchStored(chatId, (s) => delete s.pending);
      send(opts.win, {
        kind: "done",
        running: false,
        sessionId: session.claudeSession,
        chatId,
        text: failed ? "Stopped." : "Done.",
      });
    }
  })();
}
