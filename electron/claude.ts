import type { McpServerConfig, ModelInfo, PermissionResult, PermissionUpdate, Query, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, Notification, shell } from "electron";
import { recordActivity } from "./activityLog";
import { permissionGate, rememberRisks, trustWorkspace } from "./allows";
import { askedForCredentials, credentialsIn, fillCredentials, grantCredentials } from "./credentials";
import type { PermissionGate } from "./gate";
import { ensureClaudeBinary, loadAgentSdk } from "./claudeBinary";
import { quietThreads } from "./resourceGuard";
import { prepareMemory } from "./memory";
import { capsulesBrief, chatSummary, ensureSummary, forgetCapsules, recordCapsule, refreshSummary } from "./capsules";
import { paidPacket } from "./gather";
import { imagesToText } from "./imageVision";
import { generateLocally } from "./localModel";
import { noteLearned } from "./modelLearn";
import {
  COMPACT_REREAD,
  contextTokens,
  modelTier,
  gateCommand,
  gatePassed,
  lastRepliesVerbatim,
  pinnedTables,
  latestContextTokens,
  percentUsed,
  RESUME_TTL_MS,
  sessionBrief,
  shouldHandOff,
  shrinkGatherResult,
  turnIsOver,
} from "./pureFeatures";
import { fiveHourWindow, recordPlan, recordUsage, type PlanLimits, type PlanWindow } from "./usageLog";
import { ordersPrompt, protectedBy, runChecks, runOrders } from "./orders";
import { recordOrigin } from "./provenance";
import { secondOpinion } from "./review";
import { loadSettings } from "./settings";
import { LOCAL_ONLY_MESSAGE, privacyMode, privacyVault, privateAppend, protecting, scrubOutgoing } from "./privacy";
import { directModelOptions, PRESETS } from "./providers";
import { commandTouchesSecretFile, isSecretFile, mapStrings, wrapCommand } from "./redact";
import { writeJsonAtomicSync } from "./jsonStore";
import { gitIdentityEnv, loadGitIdentity } from "./gitIdentity";

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
    | "done"
    | "changes"
    | "usage"
    | "models"
    | "todos"
    | "plan"
    | "note"
    // Auto picked an AI for this chat's run; text is its name, model its value.
    | "route";
  model?: string;
  // The chat's learned model pick. The menu follows it. Auto's route events leave the menu alone.
  learned?: boolean;
  files?: string[];
  todos?: Array<{ content: string; status: string }>;
  usage?: UsageInfo;
  models?: ModelOption[];
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

export type UsageInfo = {
  costUsd: number;
  contextTokens: number;
  contextWindow: number;
  model?: string;
  sessionPercent?: number | null;
  sessionResetsAt?: number | null;
};
export type ModelOption = {
  value: string;
  displayName: string;
  description?: string;
  group?: string;
  // Submenu inside the group, such as "Opus".
  family?: string;
  needsSetup?: "key" | "models";
  // A fixed model version. Auto skips these: they share the sign-in's limits with the default.
  pinned?: boolean;
};
export type ImageAttachment = { mediaType: string; data: string; name?: string };

// What the CLI is doing right now, so the UI can tell thinking apart from tool work and writing.
export type RunPhase = "starting" | "thinking" | "tool" | "writing" | "pushing" | "approval";

type PendingApproval = {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  gate: "trust" | "risk" | "question" | "login";
  risks?: string[];
  summary?: string;
  detail?: string;
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
  // Which engine owns this chat right now, so a message during a run guides that engine instead of the other.
  engine?: "claude" | "direct";
  // Open while a Claude Code run can still take another instruction.
  inbox?: Inbox;
  // Messages sent while the run was still starting (no inbox yet); sent right after the first turn.
  early?: { prompt: string; images?: ImageAttachment[] }[];
  // Background agents and shells still running in this Claude Code run.
  backgroundTasks?: number;
  // A steer waiting for the next Direct turn, applied before the following model call.
  guide?: string;
  // Aborts only the Direct HTTP call in flight, so a new command does not stop the whole run.
  steer?: AbortController;
  // Files Claude edited in this chat, keyed by lower-case path, with their contents before the first edit
  // (null when Claude created the file). Cleared when the user keeps or undoes them.
  changes: Map<string, { path: string; before: string | null }>;
  // Prompt tokens on the latest main-agent turn, i.e. how full the context is.
  lastContext?: number;
  // When that turn happened, so a later message can tell a warm session from a cold one.
  lastTurnAt?: number;
  // Cache-read tokens this CLI session has already re-sent. The next message hands off past the budget.
  reread?: number;
  // Last context window and model, so a plan-limit event can refresh the meter without a new run total.
  contextWindow?: number;
  // Dollars this run has reported, for the per-chat model lesson.
  spentUsd?: number;
  modelName?: string;
  // Per-model totals this run has already written to the usage log.
  loggedUsage?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }>;
  // The user's instruction for the current run (kept local), for the "why" trail on changed files.
  lastPrompt?: string;
  // Times a standing-order check has sent this run back to Claude.
  fixAttempts?: number;
  // This run's check commands by tool call id, the ones that passed, and the final reply: its capsule.
  gateCalls?: Map<string, string>;
  toolNames?: Map<string, string>; // tool_use id -> tool name, until its result is logged
  passedGates?: string[];
  finalText?: string;
  // Short names of tools this run already used, so a compact can continue without the tool log.
  trace?: string[];
};

// What survives a restart: the CLI session to resume, and any run that was cut off mid-flight.
type StoredSession = {
  claudeSession?: string;
  workspace?: string;
  // Prompt tokens on the latest main-agent turn, and when it happened. Kept so a restart still
  // hands off a full or cold session instead of resuming it.
  lastContext?: number;
  lastTurnAt?: number;
  reread?: number;
  pending?: { prompt: string; permissionMode?: string; startedAt: number; started: boolean };
};

const sessions = new Map<string, Session>();
const frozenMemory = new Map<string, ReturnType<typeof prepareMemory>>();
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
  try {
    writeJsonAtomicSync(storeFile(), loadStore());
  } catch (err) {
    console.error("AgenticOps Desk could not save Claude sessions", err);
  }
}

function patchStored(chatId: string, fn: (s: StoredSession) => void) {
  const all = loadStore();
  const cur = all[chatId] ?? {};
  fn(cur);
  all[chatId] = cur;
  persistStore();
}

// A Claude Code session imported from the terminal: the chat's next message resumes it in its own folder.
export function adoptClaudeSession(chatId: string, sessionId: string, workspace: string) {
  if (loadStore()[chatId]?.claudeSession || sessions.get(chatId)?.abort) return;
  patchStored(chatId, (s) => {
    s.claudeSession = sessionId;
    s.workspace = workspace;
  });
  const live = sessions.get(chatId);
  if (live) {
    live.claudeSession = sessionId;
    live.workspace = workspace;
  }
}

export function sessionFor(chatId: string): Session {
  let session = sessions.get(chatId);
  if (!session) {
    const stored = loadStore()[chatId];
    session = {
      child: null,
      claudeSession: stored?.claudeSession,
      workspace: stored?.workspace,
      lastContext: typeof stored?.lastContext === "number" ? stored.lastContext : undefined,
      lastTurnAt: typeof stored?.lastTurnAt === "number" ? stored.lastTurnAt : undefined,
      reread: typeof stored?.reread === "number" ? stored.reread : undefined,
      approvals: new Map(),
      decisions: new Map(),
      changes: new Map(),
    };
    sessions.set(chatId, session);
  }
  return session;
}

// A message during a run joins that run. It is not a new lesson about which model to use.
export function guidingRun(chatId: string): boolean {
  const s = sessions.get(chatId);
  if (!s || s.stopping) return false;
  if (s.engine === "claude" && s.inbox) return true;
  return s.engine === "direct" && Boolean(s.abort) && !s.query && !s.child;
}

let notificationClick: (() => void) | null = null;

// Clicking a "finished" or "needs you" notification brings the window back, even from the tray.
export function onNotificationClick(fn: () => void) {
  notificationClick = fn;
}

// Streamed text and thinking arrive a few characters at a time, and each event re-renders the chat.
// A chat's reply or thinking is combined and sent at most every 30 ms. Any other event sends what is
// waiting first, so order holds. Thinking is never joined onto the reply.
const TEXT_BATCH_MS = 30;
const pendingText = new Map<string, { win: BrowserWindow | null; event: ClaudeEvent; timer: ReturnType<typeof setTimeout> }>();

function flushText(chatId: string) {
  const waiting = pendingText.get(chatId);
  if (!waiting) return;
  clearTimeout(waiting.timer);
  pendingText.delete(chatId);
  deliver(waiting.win, waiting.event);
}

export function send(win: BrowserWindow | null, event: ClaudeEvent) {
  const chatId = event.chatId;
  if ((event.kind === "line" || event.kind === "thinking") && chatId && event.text) {
    const waiting = pendingText.get(chatId);
    if (
      waiting &&
      waiting.win === win &&
      waiting.event.kind === event.kind &&
      waiting.event.phase === event.phase &&
      waiting.event.sessionId === event.sessionId
    ) {
      waiting.event.text = `${waiting.event.text ?? ""}${event.text}`;
      return;
    }
    if (waiting) flushText(chatId);
    pendingText.set(chatId, { win, event: { ...event }, timer: setTimeout(() => flushText(chatId), TEXT_BATCH_MS) });
    return;
  }
  if (chatId) flushText(chatId);
  if (sendFilter?.(win, event)) return;
  deliver(win, event);
}

// The Auto model watches a run's errors and end, so it can quietly hand a failed run to the next AI.
// Returning true swallows the event.
let sendFilter: ((win: BrowserWindow | null, event: ClaudeEvent) => boolean) | null = null;
export function setSendFilter(fn: typeof sendFilter) {
  sendFilter = fn;
}

// Main-process listeners (team.ts) see what the window sees, after the Auto model's filter.
const chatListeners = new Set<(event: ClaudeEvent) => void>();
export function onChatEvent(fn: (event: ClaudeEvent) => void) {
  chatListeners.add(fn);
  return () => chatListeners.delete(fn);
}

// Extra in-process tool servers for a chat's runs: the desk tools shared by every chat (ops), and a
// manager chat's desk tools (team.ts). All registered providers run and their tools merge into the run.
type ToolServers = { servers: Record<string, McpServerConfig>; allowed: string[] };
type ToolServerProvider = (chatId: string, signal: AbortSignal, cwd: string) => Promise<ToolServers | null>;
const toolServerProviders: ToolServerProvider[] = [];
export function setToolServers(fn: ToolServerProvider) {
  toolServerProviders.push(fn);
}

async function mergedToolServers(chatId: string, signal: AbortSignal, cwd: string): Promise<ToolServers | null> {
  const results = await Promise.all(toolServerProviders.map((fn) => fn(chatId, signal, cwd).catch(() => null)));
  const servers: Record<string, McpServerConfig> = {};
  const allowed: string[] = [];
  for (const r of results) {
    if (!r) continue;
    Object.assign(servers, r.servers);
    allowed.push(...r.allowed);
  }
  return Object.keys(servers).length ? { servers, allowed } : null;
}

export const lastAnswer = (chatId: string) => sessions.get(chatId)?.finalText ?? "";

function deliver(win: BrowserWindow | null, event: ClaudeEvent) {
  for (const fn of chatListeners) fn(event);
  if (win && !win.isDestroyed()) win.webContents.send("claude:event", event);
  if (!win || win.isDestroyed() || (win.isVisible() && win.isFocused())) return;
  if (event.kind !== "done" && event.kind !== "approval") return;
  // The user stopped it themselves; no need to tell them.
  if (event.kind === "done" && /^Stopped/.test(event.text ?? "")) return;
  if (!Notification.isSupported()) return;
  const body = event.kind === "approval" ? event.approval?.summary || "The agent needs you" : event.text || "Finished";
  const note = new Notification({ title: "AgenticOps Desk", body });
  note.on("click", () => notificationClick?.());
  note.show();
}

export function forgetSession(chatId: string) {
  clearClaudeSession(chatId, sessionFor(chatId));
  forgetCapsules(chatId);
}

function noteStructured(win: BrowserWindow | null, chatId: string, name: string, input: unknown) {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!rec) return;
  if (name === "TodoWrite" || name === "todo_write") {
    const todos = Array.isArray(rec.todos) ? rec.todos : [];
    const items = todos
      .map((row) => {
        const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
        const content = typeof item.content === "string" ? item.content : "";
        const status = typeof item.status === "string" ? item.status : "pending";
        return content ? { content, status } : null;
      })
      .filter((item): item is { content: string; status: string } => Boolean(item));
    if (items.length) send(win, { kind: "todos", chatId, todos: items, running: true });
  }
  if (name === "ExitPlanMode" && typeof rec.plan === "string" && rec.plan.trim()) {
    send(win, { kind: "plan", chatId, text: rec.plan, running: true });
  }
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

// Set by team.ts: a worker's trust and remembered risks are its manager's, so workers don't ask one by one.
let managerOf: (chatId: string) => string | undefined = () => undefined;
export function setManagerLookup(fn: (chatId: string) => string | undefined) {
  managerOf = fn;
}
// True for a manager with plan steps left, and for its workers: they act on the plan without asking the user.
let underPlan: (chatId: string) => boolean = () => false;
export function setPlanAuthority(fn: (chatId: string) => boolean) {
  underPlan = fn;
}
const managerWorkspace = (chatId: string) => {
  const m = managerOf(chatId);
  return m ? sessions.get(m)?.workspace : undefined;
};

export function askPermission(
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
    // Always asks, in any folder: nothing the folder's trust covers.
    login?: { summary: string; note: string };
  },
): Promise<PermissionResult> {
  const requestId = options.requestId;
  const questions =
    toolName === "AskUserQuestion" && Array.isArray(input.questions) ? (input.questions as ApprovalQuestion[]) : undefined;
  const description = typeof input.description === "string" ? input.description : undefined;
  let gate: PermissionGate = options.login ? { ask: true, kind: "login", ...options.login } : permissionGate(session.workspace, toolName, input);
  const parentWs = managerWorkspace(chatId);
  if (gate.ask && (gate.kind === "trust" || gate.kind === "risk") && parentWs && !permissionGate(parentWs, toolName, input).ask) gate = { ask: false };
  // Saved logins still ask: every use goes through approveLogins.
  if (gate.ask && gate.kind !== "login" && underPlan(chatId)) {
    if (toolName === "AskUserQuestion")
      return Promise.resolve({ behavior: "deny", message: "No one will answer: you are the authority on this plan. Decide yourself, following the plan, and continue." });
    gate = { ask: false };
  }
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
      summary,
      detail: questions ? "" : approvalDetail(toolName, input).slice(0, 600),
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
        canAlways:
          gate.kind === "trust" ||
          gate.kind === "risk" ||
          (gate.kind === "question" && !options.suppressAlwaysAllowRule && Boolean(options.suggestions?.length)),
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
  // Write trust only for the chat that asked. A worker still reads its manager's saved trust above.
  if (decision.allow && pending.gate === "trust") trustWorkspace(session.workspace, decision.always);
  if (decision.allow && pending.gate === "risk") rememberRisks(session.workspace, pending.risks ?? [], decision.always);
  const result: PermissionResult = decision.allow
    ? {
        behavior: "allow",
        updatedInput: decision.answers ? { ...pending.input, answers: decision.answers } : pending.input,
        ...(decision.always && pending.suggestions?.length ? { updatedPermissions: pending.suggestions } : {}),
      }
    : { behavior: "deny", message: decision.message || "The user denied this in AgenticOps Desk." };
  if (!settleApproval(session, requestId, result)) return false;
  send(win, { kind: "approval_done", id: requestId, chatId, running: true });
  recordActivity({
    kind: "approval",
    chatId,
    action: pending.toolName || "tool",
    outcome: decision.allow ? "ok" : "denied",
    note: (decision.allow ? "allowed" : "denied") + (pending.gate ? ` (${pending.gate})` : ""),
  });
  if (win && !win.isDestroyed() && ![...sessions.values()].some((s) => s.approvals.size)) win.flashFrame(false);
  if (session.abort) sendPhase(win, chatId, session, "thinking", "Thinking…");
  return true;
}

// Prompts a phone may answer: folder trust and risky commands only. Questions, plan approval and saved logins must be read at the desk.
export function phoneApprovals(chatIds: Set<string>) {
  const out: Array<{ chat: string; request: string; summary: string; detail: string }> = [];
  for (const [chat, s] of sessions)
    if (chatIds.has(chat))
      for (const [request, a] of s.approvals) if (!a.settled && (a.gate === "trust" || a.gate === "risk")) out.push({ chat, request, summary: a.summary ?? a.toolName, detail: a.detail ?? "" });
  return out;
}
export function answerPhoneApproval(win: BrowserWindow | null, chatId: string, requestId: string, allow: boolean) {
  const gate = sessions.get(chatId)?.approvals.get(requestId)?.gate;
  if (gate !== "trust" && gate !== "risk") return false;
  return answerApproval(win, chatId, requestId, { allow, message: "Denied from the phone." });
}

export function dropApprovals(win: BrowserWindow | null, chatId: string, session: Session) {
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

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A plain sentence for the status line, the way Cursor names the current step.
export function explainWork(name: string, input: unknown): { phase: RunPhase; text: string } {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const file = typeof rec.file_path === "string" ? rec.file_path : typeof rec.path === "string" ? rec.path : "";
  const dir = typeof rec.target_directory === "string" ? rec.target_directory : typeof rec.path === "string" ? rec.path : "";
  const pattern =
    typeof rec.pattern === "string" ? rec.pattern : typeof rec.query === "string" ? rec.query : typeof rec.regex === "string" ? rec.regex : "";
  const command = commandText(input);
  const pushed = pushActivity(command);
  if (pushed) return pushed;
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  if (key === "read" || key === "readfile") return { phase: "tool", text: file ? `Reading ${shortPath(file)}` : "Reading a file" };
  if (key === "edit" || key === "multiedit" || key === "notebookedit" || key === "editfile") {
    return { phase: "tool", text: file ? `Editing ${shortPath(file)}` : "Editing a file" };
  }
  if (key === "write" || key === "writefile") return { phase: "tool", text: file ? `Writing ${shortPath(file)}` : "Writing a file" };
  if (key === "grep" || key === "search") return { phase: "tool", text: pattern ? `Searching for ${clip(pattern, 48)}` : "Searching the project" };
  if (key === "glob" || key === "ls" || key === "listfiles") {
    return { phase: "tool", text: dir ? `Looking through ${shortPath(dir)}` : "Looking through the project" };
  }
  if (key === "bash" || key === "powershell" || key === "runcommand") {
    return { phase: "tool", text: command ? `Running ${clip(command, 72)}` : "Running a command" };
  }
  if (key === "webfetch") return { phase: "tool", text: "Fetching a web page" };
  if (key === "websearch") return { phase: "tool", text: pattern ? `Searching the web for ${clip(pattern, 48)}` : "Searching the web" };
  if (key === "todowrite") return { phase: "tool", text: "Updating the task list" };
  if (key === "task" || key === "agent") return { phase: "tool", text: "Starting an agent" };
  return { phase: "tool", text: file ? `${name} ${shortPath(file)}` : name };
}

// Claude Code for this machine. A source checkout uses the copy in node_modules. A packaged
// install downloads the matching build on first launch and checks it against npm's fingerprint.

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
    env: { ...env, ...quietThreads() },
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

export async function probeClaude(onStatus?: (text: string) => void): Promise<{ found: boolean; path: string; bundled: boolean }> {
  try {
    const managed = await ensureClaudeBinary(onStatus);
    if (managed) return { found: true, path: managed, bundled: true };
  } catch (err) {
    onStatus?.(err instanceof Error ? err.message : "Could not download the agent engine.");
  }
  const p = findClaudeCli();
  const js = findClaudeJs();
  return { found: existsSync(p) || Boolean(js), path: js ?? p, bundled: false };
}

// Forget the Claude Code session for a chat, so the next Claude Code message starts fresh with the transcript.
export function clearClaudeSession(chatId: string, session: Session) {
  session.claudeSession = undefined;
  session.lastContext = undefined;
  session.lastTurnAt = undefined;
  session.reread = undefined;
  patchStored(chatId, (s) => {
    delete s.claudeSession;
    delete s.lastContext;
    delete s.lastTurnAt;
    delete s.reread;
    delete s.pending;
  });
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
  return explainWork(name, input);
}

function describePartial(partial: string): { phase: RunPhase; text: string } | null {
  return pushActivity(partial);
}

export function sendPhase(
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
  const gate = gateCommand(name, input);
  if (gate && id) (session.gateCalls ??= new Map()).set(id, gate);
  // A check proves only the code it ran on; an edit after it needs a new one.
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) session.passedGates = [];
  if (id && session.announcedTools?.has(id)) return;
  if (id) {
    session.announcedTools ??= new Set();
    session.announcedTools.add(id);
    (session.toolNames ??= new Map()).set(id, name);
  }
  const activity = describeTool(name, input);
  const trace = (session.trace ??= []);
  trace.push(activity.text);
  if (trace.length > 40) trace.shift();
  if (session.block) session.block.label = activity.text;
  session.lastWasText = false;
  sendPhase(win, chatId, session, activity.phase, activity.text, true);
  noteStructured(win, chatId, name, input);
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
        send(win, { kind: "status", text: "Getting ready…", sessionId, chatId, running: true, phase: "thinking" });
      } else if (subtype === "permission_denied") {
        const message = typeof msg.message === "string" ? msg.message : "Permission denied";
        if (!/denied this in AgenticOps Desk|Stopped before approval/i.test(message)) {
          send(win, { kind: "error", text: message, sessionId, chatId, running: true });
        }
      } else if (subtype === "background_tasks_changed") {
        const count = Array.isArray(msg.tasks) ? msg.tasks.length : 0;
        session.backgroundTasks = count;
        if (count) {
          const text = `${count} background task${count === 1 ? "" : "s"} running`;
          send(win, { kind: "status", text, sessionId, chatId, running: true });
        }
      }
      return;
    }
    if (type === "assistant") {
      const usage = (msg.message as { usage?: Record<string, number> } | undefined)?.usage;
      if (usage && !msg.parent_tool_use_id) {
        const tokens = contextTokens(usage);
        // A limit error reports a synthetic turn with no tokens. Keep the last real size.
        if (tokens > 0) {
          const at = Date.now();
          session.lastTurnAt = at;
          if (tokens !== session.lastContext) session.lastContext = tokens;
          patchStored(chatId, (s) => {
            if (session.lastContext) s.lastContext = session.lastContext;
            s.lastTurnAt = at;
          });
        }
      }
      const content = (msg.message as {
        content?: Array<{ type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }>;
      } | undefined)?.content;
      // A subagent's text is for the main agent, which reports back; several at once would garble the reply.
      if (msg.parent_tool_use_id) {
        for (const b of content ?? []) {
          if (b.type === "tool_use" && b.name) announceTool(win, chatId, session, b.name, b.input, b.id);
        }
        return;
      }
      // Partials already delivered the thinking. This copy is only for a turn that did not stream.
      if (!session.streamedThinking) {
        for (const b of content ?? []) {
          if (b.type === "thinking" && b.thinking) {
            send(win, { kind: "thinking", text: b.thinking, phase: "thinking", sessionId, chatId, running: true });
          }
        }
      }
      const text = content
        ?.filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");
      if (text && !session.streamedText) {
        // Separate consecutive assistant messages that the renderer would otherwise glue together.
        const prefix = session.lastWasText ? "\n\n" : "";
        sendPhase(win, chatId, session, "writing", "Writing the reply…");
        send(win, { kind: "line", text: prefix + text, phase: "writing", sessionId, chatId, running: true });
        session.sawText = true;
        session.lastWasText = true;
      }
      for (const b of content ?? []) {
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
          session.block.label = "Thinking…";
          sendPhase(win, chatId, session, "thinking", "Thinking…");
        } else if (block?.type === "text") {
          session.block.label = "Writing…";
          sendPhase(win, chatId, session, "writing", "Writing the reply…");
        } else if (block?.type === "tool_use" && block.name) {
          session.block.label = block.name;
          sendPhase(win, chatId, session, "tool", block.name);
        }
        return;
      }
      if (ev?.type === "content_block_delta") {
        const delta = ev.delta;
        if (delta?.type === "thinking_delta" || delta?.thinking) {
          if (session.block?.label !== "Thinking…") {
            if (session.block) session.block.label = "Thinking…";
            sendPhase(win, chatId, session, "thinking", "Thinking…");
          }
          if (delta.thinking) {
            session.streamedThinking = true;
            send(win, { kind: "thinking", text: delta.thinking, phase: "thinking", sessionId, chatId, running: true });
          }
          return;
        }
        if ((delta?.type === "text_delta" || delta?.text) && delta?.text) {
          session.streamedText = true;
          session.sawText = true;
          session.lastWasText = true;
          if (session.block?.label !== "Writing…") {
            if (session.block) session.block.label = "Writing…";
            sendPhase(win, chatId, session, "writing", "Writing the reply…");
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
      const results = (msg.message as { content?: unknown } | undefined)?.content;
      for (const b of Array.isArray(results) ? results : []) {
        const r = b as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        const gate = r.type === "tool_result" && r.tool_use_id ? session.gateCalls?.get(r.tool_use_id) : undefined;
        if (gate && gatePassed(r)) (session.passedGates ??= []).push(gate);
        const tool = r.type === "tool_result" && r.tool_use_id ? session.toolNames?.get(r.tool_use_id) : undefined;
        if (tool) {
          session.toolNames!.delete(r.tool_use_id!);
          recordActivity({ kind: "tool", chatId, action: tool, outcome: r.is_error ? "failed" : "ok" });
        }
      }
      if (!session.approvals.size) sendPhase(win, chatId, session, "thinking", "Thinking…");
      return;
    }
    if (type === "result") {
      const result = typeof msg.result === "string" ? msg.result : "";
      const err = typeof msg.is_error === "boolean" && msg.is_error;
      if (result && !err) session.finalText = result;
      // The result repeats the final assistant text; only show it if nothing streamed.
      if (result && !err && !session.sawText) send(win, { kind: "line", text: result, sessionId, chatId, running: true });
      if (err && result) send(win, { kind: "error", text: result, sessionId, chatId, running: true });
      if (msg.subtype === "error_max_budget_usd") {
        const spent = typeof msg.total_cost_usd === "number" ? ` after $${msg.total_cost_usd.toFixed(2)}` : "";
        send(win, { kind: "note", text: `Stopped at the spending cap${spent}. Send a message to continue, or change the cap in Settings.`, sessionId, chatId, running: true });
      }
      const usage = runUsage(msg, session);
      if (usage) send(win, { kind: "usage", usage, chatId, running: true });
      logRunUsage(msg, session, chatId);
      return;
    }
    if (type === "rate_limit_event") {
      const info = msg.rate_limit_info as Record<string, unknown> | undefined;
      notePlanLimit(info);
      const id = typeof info?.rateLimitType === "string" ? info.rateLimitType : "";
      if (id === "five_hour") {
        const rejected = info?.status === "rejected";
        const percent = rejected ? 100 : percentUsed(info?.utilization as number | undefined, "fraction");
        const resetsAt = typeof info?.resetsAt === "number" ? info.resetsAt * 1000 : null;
        send(win, {
          kind: "usage",
          chatId,
          running: true,
          usage: {
            costUsd: 0,
            contextTokens: session.lastContext ?? 0,
            contextWindow: session.contextWindow ?? 0,
            ...(session.modelName ? { model: session.modelName } : {}),
            sessionPercent: percent,
            sessionResetsAt: resetsAt,
          },
        });
      }
      return;
    }
  } catch {
    send(win, { kind: "line", text: trimmed, chatId, running: true });
  }
}

type ModelUsageRow = {
  contextWindow?: number;
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

// A run's result repeats the totals so far, and a guided run can report more than once. Log only what is new.
function logRunUsage(msg: Record<string, unknown>, session: Session, chatId: string) {
  const seen = (session.loggedUsage ??= {});
  for (const [model, row] of Object.entries((msg.modelUsage ?? {}) as Record<string, ModelUsageRow>)) {
    const now = {
      input: row.inputTokens ?? 0,
      output: row.outputTokens ?? 0,
      cacheRead: row.cacheReadInputTokens ?? 0,
      cacheWrite: row.cacheCreationInputTokens ?? 0,
      costUsd: row.costUSD ?? 0,
    };
    const before = seen[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    const add = {
      input: Math.max(0, now.input - before.input),
      output: Math.max(0, now.output - before.output),
      cacheRead: Math.max(0, now.cacheRead - before.cacheRead),
      cacheWrite: Math.max(0, now.cacheWrite - before.cacheWrite),
      costUsd: Math.max(0, now.costUsd - before.costUsd),
    };
    seen[model] = now;
    if (add.cacheRead) session.reread = (session.reread ?? 0) + add.cacheRead;
    if (add.costUsd) session.spentUsd = (session.spentUsd ?? 0) + add.costUsd;
    if (add.input + add.output + add.cacheRead + add.cacheWrite > 0) recordUsage("claude-code", model, add);
  }
  if (session.reread) patchStored(chatId, (s) => {
    s.reread = session.reread;
  });
}

const PLAN_LABELS: Record<string, string> = {
  five_hour: "5-hour window",
  seven_day: "Weekly, all models",
  seven_day_opus: "Weekly, Opus",
  seven_day_sonnet: "Weekly, Sonnet",
  seven_day_oauth_apps: "Weekly, connected apps",
  seven_day_overage_included: "Weekly, included extra usage",
  overage: "Extra usage",
};

function notePlanLimit(info: Record<string, unknown> | undefined) {
  const id = typeof info?.rateLimitType === "string" ? info.rateLimitType : "";
  if (!id) return;
  const percent = percentUsed(info?.utilization as number | undefined, "fraction");
  const resetsAt = typeof info?.resetsAt === "number" ? info.resetsAt * 1000 : null;
  const rejected = info?.status === "rejected";
  recordPlan((plan) => {
    const others = plan.windows.filter((w) => w.id !== id);
    const prior = plan.windows.find((w) => w.id === id);
    const window = { id, label: PLAN_LABELS[id] ?? id, percent: rejected ? 100 : (percent ?? prior?.percent ?? null), resetsAt: resetsAt ?? prior?.resetsAt ?? null };
    return { ...plan, updatedAt: Date.now(), windows: [...others, window] };
  });
}

type UsageAnswer = {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
};

function planFromAnswer(answer: UsageAnswer): PlanLimits {
  const windows: PlanWindow[] = [];
  const limits = answer.rate_limits ?? {};
  for (const [id, value] of Object.entries(limits)) {
    if (id === "model_scoped" && Array.isArray(value)) {
      for (const row of value as Array<{ display_name?: string; utilization?: number | null; resets_at?: string | null }>) {
        const name = row.display_name ?? "model";
        windows.push({
          id: `model:${name}`,
          label: `Weekly, ${name}`,
          percent: percentUsed(row.utilization, "percent"),
          resetsAt: row.resets_at ? Date.parse(row.resets_at) : null,
        });
      }
      continue;
    }
    if (id === "extra_usage") {
      const extra = value as { is_enabled?: boolean; utilization?: number | null } | null;
      if (extra?.is_enabled) windows.push({ id, label: "Extra usage this month", percent: percentUsed(extra.utilization, "percent"), resetsAt: null });
      continue;
    }
    const row = value as { utilization?: number | null; resets_at?: string | null } | null;
    if (!row) continue;
    windows.push({ id, label: PLAN_LABELS[id] ?? id, percent: percentUsed(row.utilization, "percent"), resetsAt: row.resets_at ? Date.parse(row.resets_at) : null });
  }
  return {
    updatedAt: Date.now(),
    subscription: answer.subscription_type ?? null,
    windows,
    ...(answer.rate_limits_available === false ? { note: "Plan limits apply only to a Claude sign-in, not an API key." } : {}),
  };
}

type UsageQuery = Query & { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o?: { skipBehaviors?: boolean }) => Promise<UsageAnswer> };

// Asks the engine for the plan's limit windows. Uses a running chat if there is one; otherwise starts the engine
// without a prompt, which sends nothing to the model.
export async function refreshPlanLimits(): Promise<PlanLimits | null> {
  const ask = async (q: UsageQuery) => {
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== "function") throw new Error("This engine version does not report plan limits.");
    const answer = await Promise.race([
      fn.call(q, { skipBehaviors: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The engine did not answer in time.")), 20_000)),
    ]);
    return planFromAnswer(answer);
  };
  const live = [...sessions.values()].find((s) => s.query && s.engine === "claude")?.query;
  let plan: PlanLimits;
  if (live) plan = await ask(live as UsageQuery);
  else {
    const exe = await ensureClaudeBinary().catch(() => findClaudeJs() ?? findClaudeCli());
    const { query } = await loadAgentSdk();
    const abort = new AbortController();
    let stop = () => {};
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => {
        stop = resolve;
      });
    })();
    const q = query({
      prompt: idle,
      options: {
        cwd: os.homedir(),
        pathToClaudeCodeExecutable: exe,
        abortController: abort,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "AgenticOps-Desk" },
        spawnClaudeCodeProcess: (spec) =>
          spawnHidden(spec.command, spec.args, spec.cwd ?? os.homedir(), spec.env as NodeJS.ProcessEnv, spec.signal) as unknown as SpawnedProcess,
      },
    }) as UsageQuery;
    try {
      plan = await ask(q);
    } finally {
      stop();
      abort.abort();
      try {
        q.close();
      } catch {
        /* already closed */
      }
    }
  }
  recordPlan((prev) => {
    // The request leaves out windows the stream reported (Extra usage, for one). Keep those.
    const ids = new Set(plan.windows.map((w) => w.id));
    return { ...plan, windows: [...plan.windows, ...prev.windows.filter((w) => !ids.has(w.id))] };
  });
  return plan;
}

function runUsage(msg: Record<string, unknown>, session: Session): UsageInfo | null {
  const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
  const rows = Object.entries((msg.modelUsage ?? {}) as Record<string, ModelUsageRow>);
  if (!rows.length && !cost) return null;
  // The model that cost the most is the one doing the work; helper calls use cheaper models.
  const main = [...rows].sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0];
  const usage = (msg.usage ?? {}) as Record<string, number>;
  const fallback = contextTokens(usage);
  const contextWindow = main?.[1].contextWindow ?? Math.max(0, ...rows.map(([, r]) => r.contextWindow ?? 0));
  const allowance = fiveHourWindow();
  if (contextWindow) session.contextWindow = contextWindow;
  if (main?.[0]) session.modelName = main[0];
  return {
    costUsd: cost,
    contextTokens: session.lastContext ?? fallback,
    contextWindow,
    model: main?.[0],
    sessionPercent: allowance?.percent ?? null,
    sessionResetsAt: allowance?.resetsAt ?? null,
  };
}

const SNAPSHOT_LIMIT = 5_000_000;

// Called before Claude's file tools run: remember what the file looked like the first time this chat touches it.
export function snapshotFile(win: BrowserWindow | null, chatId: string, session: Session, cwd: string, input: unknown) {
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const raw = rec.file_path ?? rec.notebook_path;
  if (typeof raw !== "string" || !raw) return;
  const file = path.resolve(cwd, raw);
  const key = file.toLowerCase();
  recordOrigin(file, chatId, session.lastPrompt ?? "");
  if (session.changes.has(key)) return;
  let before: string | null = null;
  try {
    if (existsSync(file)) {
      if (statSync(file).size > SNAPSHOT_LIMIT) return;
      before = readFileSync(file, "utf8");
    }
  } catch {
    return;
  }
  session.changes.set(key, { path: file, before });
  sendChanges(win, chatId, session);
}

function readOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

// Drop files that ended up unchanged (a denied edit, or an edit Claude reverted itself).
export function pruneChanges(session: Session) {
  for (const [key, entry] of session.changes) {
    if (readOrNull(entry.path) === entry.before) session.changes.delete(key);
  }
}

export function sendChanges(win: BrowserWindow | null, chatId: string, session: Session) {
  send(win, { kind: "changes", chatId, files: [...session.changes.values()].map((c) => c.path) });
}

export function changedFiles(chatId: string): string[] {
  const session = sessions.get(chatId);
  if (!session) return [];
  if (!session.query) pruneChanges(session);
  return [...session.changes.values()].map((c) => c.path);
}

export function changeBase(chatId: string, filePath: string): string | null {
  return sessions.get(chatId)?.changes.get(path.resolve(filePath).toLowerCase())?.before ?? null;
}

function pick(session: Session, paths?: string[]) {
  const wanted = paths?.length ? new Set(paths.map((p) => path.resolve(p).toLowerCase())) : null;
  return [...session.changes.entries()].filter(([key]) => !wanted || wanted.has(key));
}

export function keepChanges(win: BrowserWindow | null, chatId: string, paths?: string[]): string[] {
  const session = sessions.get(chatId);
  if (!session) return [];
  for (const [key] of pick(session, paths)) session.changes.delete(key);
  sendChanges(win, chatId, session);
  return [...session.changes.values()].map((c) => c.path);
}

// Put files back the way they were before Claude touched them. Files Claude created go to the Recycle Bin.
export async function revertChanges(win: BrowserWindow | null, chatId: string, paths?: string[]): Promise<string[]> {
  const session = sessions.get(chatId);
  if (!session) return [];
  for (const [key, entry] of pick(session, paths)) {
    try {
      if (entry.before === null) {
        if (existsSync(entry.path)) await shell.trashItem(entry.path);
      } else {
        mkdirSync(path.dirname(entry.path), { recursive: true });
        writeFileSync(entry.path, entry.before, "utf8");
      }
      session.changes.delete(key);
    } catch (err) {
      console.error("AgenticOps Desk could not undo", entry.path, err);
    }
  }
  sendChanges(win, chatId, session);
  return [...session.changes.values()].map((c) => c.path);
}

let modelCache: ModelOption[] | null = null;
const FALLBACK_MODELS: ModelOption[] = [
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

const FAMILIES = ["Fable", "Opus", "Sonnet", "Haiku"];
function familyOf(m: ModelOption): string | undefined {
  const text = `${m.displayName} ${m.value}`.toLowerCase();
  return FAMILIES.find((f) => text.includes(f.toLowerCase()));
}

export function listModels(): ModelOption[] {
  const aliases = (modelCache ?? FALLBACK_MODELS).map((m) => ({
    ...m,
    displayName: FAMILIES.includes(m.displayName) ? `Latest ${m.displayName}` : m.displayName,
    group: "Claude Code",
  }));
  const versions = (PRESETS.anthropic.models ?? [])
    .filter((m) => !aliases.some((a) => a.value === m.id))
    .map((m) => ({ value: m.id, displayName: m.name, group: "Claude Code", pinned: true }));
  const claudeCode = [...aliases, ...versions].map((m) => ({ ...m, family: familyOf(m) }));
  const auto: ModelOption = {
    value: "auto",
    displayName: "Auto",
    description: "Uses your enabled AIs and moves to the next one on a rate limit, quota, key or outage error",
    group: "Auto",
  };
  const direct = directModelOptions().map((m) => (m.value.startsWith("direct:anthropic:") ? { ...m, family: familyOf(m) } : m));
  return [auto, ...claudeCode, ...direct];
}

function toOptions(list: ModelInfo[]): ModelOption[] {
  return list
    .filter((m) => m.value && m.value !== "default")
    .map((m) => ({ value: m.value, displayName: m.displayName || m.value, description: m.description }));
}

// One user turn with images. A string prompt cannot carry images, so the SDK gets a one-message stream.
function userTurn(text: string, images?: ImageAttachment[], priority?: "now"): SDKUserMessage {
  const blocks = [
    ...(images ?? []).map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.data },
    })),
    { type: "text" as const, text },
  ];
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: images?.length ? blocks : text },
    ...(priority ? { priority } : {}),
  };
}

// Stays open for the life of one Claude Code run so a later instruction can be written to the same process.
function openInbox(): { inbox: Inbox; stream: AsyncIterable<SDKUserMessage> } {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const stream = (async function* () {
    for (;;) {
      if (pending.length) {
        yield pending.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    stream,
    inbox: {
      push(msg) {
        if (closed) return false;
        pending.push(msg);
        const resume = wake;
        wake = null;
        resume?.();
        return true;
      },
      close() {
        if (closed) return;
        closed = true;
        const resume = wake;
        wake = null;
        resume?.();
      },
    },
  };
}

type Inbox = {
  push: (msg: SDKUserMessage) => boolean;
  close: () => void;
};

// Put real values back in place of {{SECRET_n}} placeholders, just before a tool runs on this computer.
export function restoreInput(input: Record<string, unknown>): Record<string, unknown> {
  const vault = privacyVault();
  return mapStrings(input, (s) => vault.restore(s));
}

// The one check before a command may use saved logins: Privacy Mode on, every name known, and the user has said yes
// to each in this chat. Returns a reason to refuse, or null. A prompt-injected command cannot get past the question.
export async function approveLogins(
  win: BrowserWindow | null,
  chatId: string,
  session: Session,
  toolName: "Bash" | "PowerShell",
  command: string,
  signal: AbortSignal,
  requestId: string,
): Promise<string | null> {
  const logins = credentialsIn(command, toolName);
  if (!logins) return null;
  if ("error" in logins) return logins.error;
  if (!protecting()) return "Saved logins need Privacy Mode, which hides a value if a command prints it. Ask the user to turn it on in Settings.";
  const asked = askedForCredentials(chatId, logins.names);
  if (!asked.length) return null;
  const result = await askPermission(win, chatId, session, toolName, { command }, {
    signal,
    requestId: `${requestId}-login`,
    login: {
      summary: `Use saved login${asked.length === 1 ? "" : "s"} ${asked.join(", ")}`,
      note: "The agent runs this command with the login but does not see its value. Allow covers this login for the rest of this chat. Check where the command sends it.",
    },
  });
  if (result.behavior === "deny") return result.message || "The user did not allow this login.";
  grantCredentials(chatId, asked);
  return null;
}

export function secretFileMessage(file: string) {
  return `Privacy Mode blocked this: ${file} is a key, certificate or credential file, so its contents must not be sent to the model. Ask the user to check it themselves, or work from a copy with the secret parts removed.`;
}

export function guidePrompt(text: string) {
  return `The user is guiding this run. Follow this instruction now, then continue the work already in progress. Do not start over and do not discard finished steps.\n\n${text}`;
}

function endRun(session: Session) {
  session.inbox?.close();
  session.inbox = undefined;
  session.early = undefined;
  session.guide = undefined;
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
      pending.resolve({ behavior: "deny", message: "AgenticOps Desk is closing." });
    }
    session.approvals.clear();
    endRun(session);
  }
}

// For the briefing and the watcher: is this chat working, and is it waiting on the user?
export function chatState(chatId: string) {
  const s = sessions.get(chatId);
  return { running: Boolean(s?.query || s?.abort), waiting: Boolean(s?.approvals.size) };
}

// The window asks when it loads: a run resumed at startup reported its status before anything was listening.
export function runningChats() {
  return [...sessions.entries()].filter(([, s]) => s.query || s.abort).map(([id]) => id);
}

export function liveRunCount() {
  let n = 0;
  for (const session of sessions.values()) {
    if (session.query || session.abort) n += 1;
  }
  return n;
}

export function pendingRuns(): Array<{ chatId: string; workspace?: string }> {
  return Object.entries(loadStore())
    .filter(([id, s]) => s.pending && !sessions.get(id)?.query && !sessions.get(id)?.abort)
    .map(([chatId, s]) => ({ chatId, workspace: s.workspace }));
}

export function resumePendingRun(win: BrowserWindow | null, chatId: string) {
  const stored = loadStore()[chatId];
  const pending = stored?.pending;
  if (!pending) return false;
  // Its folder is gone. Running it in whatever folder is open would edit the wrong project.
  if (!stored.workspace || !existsSync(stored.workspace)) {
    patchStored(chatId, (s) => delete s.pending);
    send(win, { kind: "error", text: `This run was cut off and its folder is gone: ${stored.workspace ?? "unknown"}. Send the message again after locating the folder.`, chatId, running: false });
    return false;
  }
  const cwd = stored.workspace;
  // Resuming a session whose cache has expired resends its whole history. Let the next message carry a brief instead.
  if (pending.started && stored.claudeSession && (rememberedSession(stored.claudeSession)?.idleMs ?? 0) > RESUME_TTL_MS) {
    patchStored(chatId, (s) => delete s.pending);
    send(win, {
      kind: "note",
      chatId,
      running: false,
      text: "This run was interrupted long enough ago that resuming it would resend the whole session. Send a message to continue from a short brief.",
    });
    return false;
  }
  // If the CLI never reported a session, the original prompt was never seen; send it again.
  const prompt =
    pending.started && stored.claudeSession
      ? "AgenticOps Desk was closed while you were working, which interrupted your previous run. Continue the task exactly where you left off; do not redo finished steps."
      : pending.prompt;
  runClaude({ win, chatId, workspace: cwd, prompt, resume: true, permissionMode: pending.permissionMode });
  return true;
}

export type HistoryMsg = { role: string; text: string };

const HISTORY_LIMIT = 60_000;

// Claude Code keeps the session log under ~/.claude/projects/<folder>/<id>.jsonl. The id is enough to find it.
function rememberedSession(sessionId: string): { tokens?: number; idleMs: number } | undefined {
  if (!/^[\da-f-]{36}$/i.test(sessionId)) return undefined;
  const root = path.join(os.homedir(), ".claude", "projects");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const file = path.join(root, name, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    try {
      return {
        tokens: latestContextTokens(readFileSync(file, "utf8")),
        idleMs: Math.max(0, Date.now() - statSync(file).mtimeMs),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// With no CLI session to resume (a Cursor chat, or one the CLI lost), hand Claude the visible transcript.
export function withHistory(prompt: string, history?: HistoryMsg[]): string {
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

// A resumed session would resend its tool history. Carry the brief instead: a few thousand tokens, not the whole log.
export function withBrief(prompt: string, history?: HistoryMsg[], verified = "", summary = ""): string {
  const verbatim = lastRepliesVerbatim(history);
  // A summary is a few hundred words and loses tables and plans; the newest replies always ride along unchanged.
  const brief = [summary || sessionBrief(history), summary ? verbatim : "", pinnedTables(history)].filter(Boolean).join("\n\n");
  if (!brief && !verified) return prompt;
  return [
    "This continues an earlier session. Its working context was not reloaded, so file contents and command output from it are not here.",
    ...(verified
      ? [
          "Work already verified in this chat (its checks passed and those files are unchanged since; trust it instead of re-checking):",
          "<verified>",
          verified,
          "</verified>",
        ]
      : []),
    ...(brief ? ["What was said:", "<session>", brief, "</session>"] : []),
    "Treat that as where the work stands. Open a file only to change it, or if the findings above are incomplete. Reply to the user's new message:",
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
export function realStorePwsh(): string | undefined {
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

async function continuationPacket(session: Session, request: string): Promise<string> {
  const files = [...session.changes.values()].map((c) => c.path).slice(0, 40);
  const steps = (session.trace ?? []).slice(-20).join("\n");
  const said = (session.finalText ?? "").replace(/\s+/g, " ").slice(0, 1_200);
  const local = await generateLocally(
    `Summarize this coding run so a fresh agent can continue it without the tool log. Under 150 words. Keep file paths, decisions, errors, and what is left.\n\nRequest:\n${request.slice(0, 1_200)}\n\nSteps:\n${steps || "(none)"}\n\nFiles changed:\n${files.join("\n") || "(none)"}\n\nReply so far:\n${said || "(none)"}`,
    250,
    12_000,
  );
  return [
    "This run was compacted so the earlier tool output is not sent again. Continue the same task. Open a file only to change it.",
    `Request:\n${request.slice(0, 1_500)}`,
    files.length ? `Files already changed:\n${files.join("\n")}` : "",
    steps ? `Steps already taken:\n${steps}` : "",
    local ? `Where the work stands:\n${local}` : said ? `Reply so far:\n${said}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type RunOptions = {
  win: BrowserWindow | null;
  chatId: string;
  workspace: string;
  prompt: string;
  resume?: boolean;
  permissionMode?: string;
  history?: HistoryMsg[];
  model?: string;
  images?: ImageAttachment[];
  // Set on runs the review loop starts: the user's original request and which fix round this is.
  reviewRequest?: string;
  reviewRound?: number;
};

export function runClaude(opts: RunOptions) {
  const chatId = opts.chatId;
  const session = sessionFor(chatId);
  if (privacyMode() === "local") {
    send(opts.win, { kind: "error", text: LOCAL_ONLY_MESSAGE, chatId, running: false });
    patchStored(chatId, (s) => delete s.pending);
    send(opts.win, { kind: "done", running: false, sessionId: session.claudeSession, chatId, text: "Stopped." });
    return;
  }
  // abort is set before inbox, so a message during start-up must queue, not stop the run that is starting.
  if (session.engine === "claude" && (session.inbox || session.abort) && !session.stopping) {
    void (async () => {
      const inbox = session.inbox;
      const seen = await imagesToText(scrubOutgoing(opts.prompt).text, opts.images).catch((err) => {
        send(opts.win, { kind: "error", text: `Could not send your instruction: ${err instanceof Error ? err.message : String(err)}`, chatId, running: true });
        return null;
      });
      if (!seen) return;
      if (inbox && session.inbox === inbox && !session.stopping && inbox.push(userTurn(guidePrompt(seen.prompt), seen.images, "now"))) {
        send(opts.win, {
          kind: "status",
          running: true,
          phase: "thinking",
          text: "Following your instruction…",
          sessionId: session.claudeSession,
          chatId,
        });
        return;
      }
      if (!session.stopping && !session.inbox && session.abort) {
        (session.early ??= []).push({ prompt: seen.prompt, images: seen.images });
        return;
      }
      runClaude({ ...opts, prompt: seen.prompt, images: seen.images });
    })();
    return;
  }
  if (session.child || session.query || session.abort) stopClaude(opts.win, chatId);
  session.lastPrompt = opts.prompt;
  session.fixAttempts = 0;

  // A CLI session lives under the folder it started in. A chat moved to another folder drops that session.
  // The follow-up still carries the summary, not the old transcript.
  if (session.claudeSession && session.workspace && path.resolve(session.workspace).toLowerCase() !== path.resolve(opts.workspace).toLowerCase()) {
    session.claudeSession = undefined;
    session.lastContext = undefined;
    session.lastTurnAt = undefined;
    session.reread = undefined;
  }
  // A follow-up carries a short summary. Resuming would send the earlier tokens again.
  const handOff = shouldHandOff(opts.history?.length ?? 0);
  if (handOff && session.claudeSession) {
    send(opts.win, {
      kind: "note",
      chatId,
      running: true,
      text: "This message continues from a short summary of the chat, so earlier tokens are not sent again. The agent reads again any file it needs.",
    });
    session.claudeSession = undefined;
    session.lastContext = undefined;
    session.lastTurnAt = undefined;
    session.reread = undefined;
  }
  // A message with no earlier turns, or a review round, continues the session it already has.
  const resuming = Boolean(session.claudeSession);
  const idleMin = session.lastTurnAt ? Math.round((Date.now() - session.lastTurnAt) / 60000) : -1;
  console.log(`[resume] chat=${chatId} handOff=${handOff} resuming=${resuming} idleMin=${idleMin} cold=${resuming && idleMin * 60000 > RESUME_TTL_MS}`);
  if (resuming && session.lastTurnAt && Date.now() - session.lastTurnAt > RESUME_TTL_MS) {
    frozenMemory.delete(`${chatId}\0${opts.workspace}`); // cache is cold anyway, so pick up new memories now
    send(opts.win, {
      kind: "note",
      chatId,
      running: true,
      text: "This chat has been idle long enough that its cache expired. Continuing it resends the whole session, which costs more than usual.",
    });
  }
  const cwd = opts.workspace;
  session.workspace = cwd;
  session.engine = "claude";
  session.stopping = false;
  session.sawText = false;
  session.lastWasText = false;
  session.streamedText = false;
  session.streamedThinking = false;
  session.block = undefined;
  session.announcedTools = new Set();
  session.decisions = new Map();
  session.stderr = "";
  session.backgroundTasks = 0;
  session.loggedUsage = {};
  session.gateCalls = new Map();
  session.passedGates = [];
  session.finalText = "";
  session.spentUsd = 0;

  const mode = chosenPermissionMode(opts.permissionMode);
  if (!resuming) {
    session.claudeSession = undefined;
    session.reread = 0;
  }
  const bash = gitBashPath();
  const pwsh = realStorePwsh();
  const skipStorePwsh = !pwsh && storePwshAliasOnly() && Boolean(bash);

  patchStored(chatId, (s) => {
    s.workspace = cwd;
    if (!resuming) {
      delete s.claudeSession;
      delete s.lastContext;
      delete s.lastTurnAt;
      delete s.reread;
    }
    s.pending = { prompt: opts.prompt, permissionMode: mode, startedAt: Date.now(), started: false };
  });

  const { inbox, stream } = openInbox();
  const begin = (text: string, hidden: number, images?: ImageAttachment[]) => {
    session.inbox = inbox;
    inbox.push(userTurn(text, images));
    for (const e of session.early ?? []) inbox.push(userTurn(guidePrompt(e.prompt), e.images, "now"));
    session.early = undefined;
    send(opts.win, {
      kind: "status",
      running: true,
      phase: "starting",
      text: hidden ? `Hid ${hidden} secret${hidden > 1 ? "s" : ""} before sending. Starting…` : "Starting…",
      sessionId: session.claudeSession,
      chatId,
    });
  };

  recordActivity({ kind: "run", chatId, title: opts.prompt.slice(0, 80), model: opts.model, action: "started", outcome: "started" });

  const abort = new AbortController();
  session.abort = abort;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "AgenticOps-Desk",
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    ...(bash ? { CLAUDE_CODE_GIT_BASH_PATH: bash } : {}),
    ...(pwsh ? { PATH: `${path.dirname(pwsh)};${process.env.PATH ?? ""}` } : {}),
  };
  void (async () => {
    let failed = "";
    let q: Query | undefined;
    try {
      // Inside the try: if these throw, the run still ends with an error and done instead of sticking as "running".
      // Frozen per chat: a changed memory index would rewrite the cached prompt prefix on every resume.
      const frozenKey = `${chatId}\0${cwd}`;
      await loadGitIdentity();
      Object.assign(env, gitIdentityEnv());
      const memory = frozenMemory.get(frozenKey) ?? prepareMemory(cwd);
      frozenMemory.set(frozenKey, memory);
      const orders = runOrders(cwd);
      const standing = ordersPrompt(orders);
      if (handOff && !chatSummary(chatId, opts.history)) {
        send(opts.win, {
          kind: "status",
          running: true,
          phase: "starting",
          text: "Summarizing this chat locally…",
          sessionId: session.claudeSession,
          chatId,
        });
      } else {
        send(opts.win, {
          kind: "status",
          running: true,
          phase: "starting",
          text: "Reading the project locally…",
          sessionId: session.claudeSession,
          chatId,
        });
      }
      const [seen, packet, summary] = await Promise.all([
        imagesToText(opts.prompt, opts.images),
        paidPacket(cwd, opts.prompt),
        handOff ? ensureSummary(chatId, opts.history, abort.signal).catch(() => "") : Promise.resolve(""),
      ]);
      if (session.abort !== abort) {
        inbox.close();
        return;
      }
      const shaped = packet ? `${packet}\n\n${seen.prompt}` : seen.prompt;
      const scrubbed = scrubOutgoing(
        resuming ? shaped : handOff ? withBrief(shaped, opts.history, capsulesBrief(chatId), summary) : withHistory(shaped, opts.history),
      );
      begin(scrubbed.text, scrubbed.hidden, seen.images);
      let exe: string;
      try {
        exe = await ensureClaudeBinary((text) => {
          send(opts.win, {
            kind: "status",
            running: true,
            phase: "starting",
            text,
            sessionId: session.claudeSession,
            chatId,
          });
        });
      } catch (err) {
        const js = findClaudeJs();
        const external = findClaudeCli();
        if (!js && !existsSync(external)) throw err;
        exe = js ?? external;
      }
      const { query } = await loadAgentSdk();
      const { runBudgetUsd } = await loadSettings();
      const extra = await mergedToolServers(chatId, abort.signal, cwd);
      if (session.abort !== abort) return;
      let turnStream = stream;
      let resumeId = resuming ? session.claudeSession : undefined;
      for (let compact = 0; compact < 2 && session.abort === abort; compact++) {
      q = query({
    prompt: turnStream,
    options: {
      cwd,
      ...(opts.model ? { model: opts.model, ...(modelTier(opts.model) < 2 ? { effort: "low" as const } : {}) } : { model: "sonnet", effort: "low" as const }),
      ...(runBudgetUsd > 0 ? { maxBudgetUsd: runBudgetUsd } : {}),
      pathToClaudeCodeExecutable: exe,
      abortController: abort,
      resume: resumeId,
      permissionMode: mode,
      permissionPrompts: "host",
      // Commits and PRs are the user's (login-desktop), so no agent co-author line.
      settings: { attribution: { commit: "", pr: "" } },
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: privateAppend([memory.append, standing].filter(Boolean).join("\n\n")), snapshot: false },
      ...(memory.directories.length ? { additionalDirectories: memory.directories } : {}),
      tools: { type: "preset", preset: "claude_code" },
      ...(skipStorePwsh ? { disallowedTools: ["PowerShell"] } : {}),
      ...(extra ? { mcpServers: extra.servers, allowedTools: extra.allowed } : {}),
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|PowerShell",
            timeout: 3600,
            hooks: [
              async (input, _toolUseId, { signal }) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const raw =
                  input.tool_input && typeof input.tool_input === "object"
                    ? (input.tool_input as Record<string, unknown>)
                    : {};
                const privacy = protecting();
                // The user approves the real command; Claude only ever saw the placeholders.
                const toolInput = privacy ? restoreInput(raw) : raw;
                const deny = (reason: string) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: reason,
                  },
                });
                const secretFile = privacy ? commandTouchesSecretFile(String(toolInput.command ?? "")) : null;
                if (secretFile) return deny(secretFileMessage(secretFile));
                const requestId = input.tool_use_id || _toolUseId || `shell-${Date.now()}`;
                const shell = input.tool_name === "Bash" ? "Bash" : "PowerShell";
                const refused = await approveLogins(opts.win, chatId, session, shell, String(toolInput.command ?? ""), signal, requestId);
                if (refused) return deny(refused);
                const result = await askPermission(opts.win, chatId, session, input.tool_name, toolInput, {
                  signal,
                  requestId,
                });
                if (result.behavior === "deny") {
                  session.decisions.set(requestId, result);
                  return deny(result.message);
                }
                let updated = result.updatedInput ?? (privacy ? toolInput : undefined);
                if (privacy && updated && typeof updated.command === "string") {
                  updated = { ...updated, command: wrapCommand(shell, fillCredentials(updated.command, shell)) };
                }
                session.decisions.set(requestId, updated ? { ...result, updatedInput: updated } : result);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                    ...(updated ? { updatedInput: updated } : {}),
                  },
                };
              },
            ],
          },
          {
            // Record each file before Claude's first edit so the user can review the diff and undo it.
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const target = (input.tool_input as Record<string, unknown> | undefined) ?? {};
                const blockedBy = protectedBy(cwd, String(target.file_path ?? target.notebook_path ?? ""), orders);
                if (blockedBy) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: `A standing order protects this path (${blockedBy}). Do not edit it; tell the user if the task needs it changed.`,
                    },
                  };
                }
                snapshotFile(opts.win, chatId, session, cwd, input.tool_input);
                if (!protecting() || !input.tool_input || typeof input.tool_input !== "object") return {};
                // Write the real values into the file. This does not approve the edit; the usual prompt still applies.
                const raw = input.tool_input as Record<string, unknown>;
                const restored = restoreInput(raw);
                if (JSON.stringify(restored) === JSON.stringify(raw)) return {};
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, updatedInput: restored } };
              },
            ],
          },
          {
            matcher: "Read|NotebookRead",
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse" || !protecting()) return {};
                const file = String((input.tool_input as Record<string, unknown> | undefined)?.file_path ?? "");
                if (!isSecretFile(file)) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: secretFileMessage(file),
                  },
                };
              },
            ],
          },
        ],
        // Standing-order checks: a run that changed files is not finished until they pass.
        // A failure goes back to Claude with the output, up to maxFixes times.
        Stop: [
          {
            timeout: 900,
            hooks: [
              async (input, _id, { signal }) => {
                if (input.hook_event_name !== "Stop" || !orders.checks.length) return {};
                pruneChanges(session);
                if (!session.changes.size) return {};
                const result = await runChecks(cwd, orders.checks, signal, (cmd) =>
                  sendPhase(opts.win, chatId, session, "tool", `Checking: ${cmd}`, true),
                );
                if (result.ok) {
                  sendPhase(opts.win, chatId, session, "tool", "Standing-order checks passed", true);
                  return {};
                }
                session.fixAttempts = (session.fixAttempts ?? 0) + 1;
                if (session.fixAttempts > orders.maxFixes) {
                  send(opts.win, {
                    kind: "error",
                    text: `Standing-order check still fails after ${orders.maxFixes} fix attempts: ${result.command}`,
                    chatId,
                    running: true,
                  });
                  return {};
                }
                sendPhase(opts.win, chatId, session, "tool", `Check failed, sending back to Claude: ${result.command}`, true);
                return {
                  decision: "block" as const,
                  reason:
                    `AgenticOps Desk standing order: \`${result.command}\` must pass before you finish, and it failed ` +
                    `(attempt ${session.fixAttempts} of ${orders.maxFixes}). Fix the cause, then finish. Output:\n` +
                    scrubOutgoing(result.output).text,
                };
              },
            ],
          },
        ],
        // Every tool result passes through here before Claude sees it.
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PostToolUse") return {};
                let output = input.tool_response;
                if (protecting()) {
                  const vault = privacyVault();
                  let changed = false;
                  const scrubbed = mapStrings(output, (s) => {
                    const r = vault.scrub(s);
                    if (r.text !== s) changed = true;
                    return r.text;
                  });
                  if (changed) output = scrubbed;
                }
                const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
                const shrunk = shrinkGatherResult(input.tool_name, text);
                if (!shrunk && output === input.tool_response) return {};
                return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: shrunk ?? output } };
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
      if (!modelCache) {
        void q
          .supportedModels()
          .then((list) => {
            const options = toOptions(list);
            if (!options.length) return;
            modelCache = options;
            send(opts.win, { kind: "models", chatId, models: listModels() });
          })
          .catch(() => {});
      }
      let grew = false;
      try {
        for await (const msg of q) {
          if (session.query !== q) return;
          parseStreamLine(JSON.stringify(msg), opts.win, chatId, session);
          if ((session.reread ?? 0) >= COMPACT_REREAD && compact === 0 && !session.stopping) {
            grew = true;
            try {
              q.close();
            } catch {
              /* already closed */
            }
            if (session.child) killTree(session.child);
            session.child = null;
            break;
          }
          // Keep the inbox open while background agents run, so a message then guides this run instead of stopping them.
          if (turnIsOver(msg, session.backgroundTasks ?? 0)) session.inbox?.close();
        }
      } catch (err) {
        if (!grew) throw err;
      }
      if (!grew) break;
      send(opts.win, {
        kind: "note",
        chatId,
        running: true,
        text: "This run was getting large, so it continues from a short packet. The earlier tool output is not sent again.",
      });
      session.inbox = undefined;
      const packet = await continuationPacket(session, opts.prompt);
      if (session.abort !== abort) return;
      session.reread = 0;
      session.loggedUsage = {};
      session.claudeSession = undefined;
      resumeId = undefined;
      const next = openInbox();
      turnStream = next.stream;
      session.inbox = next.inbox;
      next.inbox.push(userTurn(packet));
      }
    } catch (err) {
      // A newer run owns the session now (or this one was stopped): its state is not ours to touch.
      if (session.query !== q || session.abort !== abort) return;
      failed = err instanceof Error ? err.message : String(err);
      if (resuming && /no conversation found/i.test(`${failed}\n${session.stderr ?? ""}`)) {
        session.claudeSession = undefined;
        session.lastContext = undefined;
        session.lastTurnAt = undefined;
        session.reread = undefined;
        patchStored(chatId, (s) => {
          delete s.claudeSession;
          delete s.lastContext;
          delete s.lastTurnAt;
          delete s.reread;
        });
        failed = "The previous agent session no longer exists. Send again to start a new one.";
      } else if (!session.stopping && !shuttingDown) {
        const tail = (session.stderr ?? "").trim().slice(-500);
        if (tail && !failed.includes(tail)) failed = `${failed}\n${tail}`;
      } else {
        failed = "";
      }
    } finally {
      // A run that threw never got its result message, so its inbox is still open; the next message
      // must start a new run, not be "steered" into this dead one.
      // Only while this run still owns the session; a newer run's inbox must stay open.
      if (session.abort === abort) {
        if (session.inbox && session.inbox !== inbox) session.inbox.close();
        session.inbox = undefined;
      }
      inbox.close();
      if (!q || session.query !== q) {
        if (session.stopping && !session.query) {
          session.stopping = false;
          send(opts.win, { kind: "done", running: false, sessionId: session.claudeSession, chatId, text: "Stopped." });
        } else if (failed) {
          session.abort = undefined;
          const lost = session.early?.length ?? 0;
          session.early = undefined;
          if (lost) failed += `\n${lost} message${lost > 1 ? "s" : ""} sent while starting ${lost > 1 ? "were" : "was"} not delivered. Send ${lost > 1 ? "them" : "it"} again.`;
          send(opts.win, { kind: "error", text: failed, chatId, running: false });
          patchStored(chatId, (s) => delete s.pending);
          send(opts.win, { kind: "done", running: false, sessionId: session.claudeSession, chatId, text: "Stopped." });
        }
        return;
      }
      session.query = undefined;
      session.abort = undefined;
      session.child = null;
      if (shuttingDown) return;
      dropApprovals(opts.win, chatId, session);
      pruneChanges(session);
      sendChanges(opts.win, chatId, session);
      if (failed) {
        send(opts.win, { kind: "error", text: failed, chatId, running: false });
      }
      patchStored(chatId, (s) => delete s.pending);
      if (!failed && !session.stopping) {
        // Bookkeeping must never stop the "done" below from being sent.
        try {
          const capsule = recordCapsule(chatId, {
            request: opts.reviewRequest ?? opts.prompt,
            outcome: session.finalText ?? "",
            gates: session.passedGates ?? [],
            files: [...session.changes.values()].map((c) => c.path),
          });
          const turns = [...(opts.history ?? []), { role: "user", text: opts.prompt }, { role: "assistant", text: session.finalText ?? "" }];
          void Promise.resolve(refreshSummary(chatId, turns, capsule)).catch(() => {});
        } catch (err) {
          console.error("AgenticOps Desk could not record the run", err);
        }
      }
      send(opts.win, {
        kind: "done",
        running: false,
        sessionId: session.claudeSession,
        chatId,
        text: failed ? "Stopped." : "Done.",
      });
      recordActivity({
        kind: "run",
        chatId,
        title: opts.prompt.slice(0, 80),
        model: opts.model,
        action: failed ? "failed" : "done",
        outcome: failed ? "failed" : "ok",
        note: failed ? failed.slice(0, 240) : undefined,
      });
      if (!opts.reviewRound && !opts.resume) noteLearned(chatId, opts.prompt, opts.model || session.modelName || "", session.spentUsd ?? 0);
      if (!failed && !session.stopping) void reviewRun(opts, session, cwd).catch(() => {});
    }
  })();
}

const REVIEW_ROUNDS = 2;

// Second opinion: a model from another provider checks the finished change against the request.
// Concerns go back to the agent to fix, up to REVIEW_ROUNDS times, so two AIs settle it without the user.
async function reviewRun(opts: RunOptions, session: Session, cwd: string) {
  const { win, chatId } = opts;
  const request = opts.reviewRequest ?? opts.prompt;
  const round = opts.reviewRound ?? 0;
  if (privacyMode() === "local") return;
  const prefs = await loadSettings();
  const reviewer = prefs.reviewer || (prefs.localModelId ? `direct:ollama:${prefs.localModelId}` : "");
  if (!reviewer) return;
  if (!session.changes.size) return;
  const clean = (s: string | null) => (s === null || !protecting() ? s : scrubOutgoing(s).text);
  const files = [...session.changes.values()].map((c) => {
    let after: string | null = null;
    try {
      after = existsSync(c.path) ? readFileSync(c.path, "utf8") : null;
    } catch {
      after = null;
    }
    return { path: c.path, before: clean(c.before), after: clean(after) };
  });
  send(win, { kind: "status", running: false, text: "Getting a second opinion…", chatId });
  try {
    const r = await secondOpinion({ reviewer, request: scrubOutgoing(request).text, files, cwd });
    if (r) send(win, { kind: "note", chatId, running: false, text: `Second opinion · ${r.label}\n${r.text}` });
    send(win, { kind: "status", running: false, text: "Done.", chatId });
    // Only when the chat is still idle: a message the user sent meanwhile wins.
    const idle = !session.query && !session.abort && !session.child;
    if (r && /^concerns:/i.test(r.text) && round < REVIEW_ROUNDS && idle) {
      send(win, { kind: "note", chatId, running: false, text: `Sending the concerns back to the agent (round ${round + 1} of ${REVIEW_ROUNDS})…` });
      const files = [...session.changes.values()].map((c) => c.path);
      clearClaudeSession(chatId, session);
      runClaude({
        ...opts,
        history: undefined,
        images: undefined,
        reviewRequest: request,
        reviewRound: round + 1,
        prompt:
          `Another AI (${r.label}) reviewed your change against my request and raised these concerns. ` +
          `Fix the ones that are real problems. If one is wrong, say why in one line and leave it.\n\n${r.text}\n\n` +
          `Files already changed:\n${files.map((p) => `- ${p}`).join("\n")}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(win, { kind: "note", chatId, running: false, text: `Second opinion could not run: ${msg.slice(0, 300)}` });
  }
}
