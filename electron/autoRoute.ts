import type { BrowserWindow } from "electron";
import { changedFiles, chatState, listModels, send, setSendFilter } from "./claude";
import { autoOrder, autoStep, coolDownMs } from "./pureFeatures";
import { isLocalProvider, privacyMode } from "./privacy";
import { parseDirectModel } from "./providers";
import { loadSettings } from "./settings";

// The "Auto" model: one choice that uses every AI the user has enabled (or the ones they picked, in
// their order). A run goes to the first one that is not resting; when it fails because that AI can't
// take the job (rate limit, quota, key, outage, refusal), the same message goes to the next one.

export const AUTO = "auto";
// Claude Code with whatever model the user's Claude sign-in defaults to.
export const CLAUDE_DEFAULT = "default";

export type AutoPayload = {
  chatId: string;
  prompt: string;
  workspace: string;
  resume?: boolean;
  permissionMode?: string;
  history?: Array<{ role: string; text: string }>;
  images?: Array<{ mediaType: string; data: string; name?: string }>;
};

export type AutoStatus = {
  order: Array<{ value: string; label: string; restingUntil?: number; reason?: string }>;
  chats: Record<string, string>;
};

type Dispatch = (model: string, payload: AutoPayload) => void;

type Attempt = { payload: AutoPayload; queue: string[]; current: string; failed?: string; erred?: boolean };

const live = new Map<string, Attempt>();
// The AI that last finished a run for each chat, so the chat keeps its context there.
const sticky = new Map<string, string>();
const resting: Record<string, { until: number; reason: string }> = {};
let dispatch: Dispatch | null = null;

export function labelOf(model: string): string {
  if (model === CLAUDE_DEFAULT) return "Claude Code";
  const opt = listModels().find((m) => m.value === model);
  const direct = parseDirectModel(model);
  if (direct) return `${opt?.displayName ?? direct.model} (${opt?.group?.replace(/^Direct · /, "") ?? direct.provider})`;
  return `Claude Code · ${opt?.displayName ?? model}`;
}

// Everything Auto could use right now. Local-only privacy keeps it on this computer.
// Local models (Ollama) come first by default so most work stays off the cloud; the user's chosen
// order (settings.autoModels) still wins.
export function autoAvailable(): string[] {
  const enabled = listModels().filter((m) => m.value !== AUTO && !m.needsSetup && !m.pinned).map((m) => m.value);
  const local = enabled.filter((m) => {
    const d = parseDirectModel(m);
    return Boolean(d && isLocalProvider(d.provider));
  });
  // Local models first (Ollama is free), then Claude Code's default, then the rest. "default" is not in
  // listModels() output, so it is always included here explicitly.
  const rest = enabled.filter((m) => !local.includes(m) && m !== CLAUDE_DEFAULT);
  const all = [...new Set([...local, CLAUDE_DEFAULT, ...rest])];
  if (privacyMode() !== "local") return all;
  return all.filter((m) => {
    const d = parseDirectModel(m);
    return m === CLAUDE_DEFAULT || Boolean(d && isLocalProvider(d.provider));
  });
}

function restingUntil(): Record<string, number> {
  return Object.fromEntries(Object.entries(resting).map(([k, v]) => [k, v.until]));
}

async function currentOrder(chatId?: string): Promise<string[]> {
  const settings = await loadSettings();
  return autoOrder({
    chosen: settings.autoModels,
    available: autoAvailable(),
    sticky: chatId ? sticky.get(chatId) : undefined,
    restingUntil: restingUntil(),
    now: Date.now(),
  });
}

// For Settings: the order Auto would try right now, which AIs are resting and why, and each chat's pick.
export async function autoStatus(): Promise<AutoStatus> {
  const now = Date.now();
  const order = (await currentOrder()).map((value) => {
    const r = resting[value];
    return r && r.until > now
      ? { value, label: labelOf(value), restingUntil: r.until, reason: r.reason }
      : { value, label: labelOf(value) };
  });
  const chats: Record<string, string> = {};
  for (const [id, m] of sticky) chats[id] = labelOf(m);
  for (const [id, run] of live) chats[id] = labelOf(run.current);
  return { order, chats };
}

// Lets a resting AI (or all of them) be tried again at once, e.g. after topping up credit.
export function wakeAuto(model?: string) {
  if (model) delete resting[model];
  else for (const k of Object.keys(resting)) delete resting[k];
}

function announce(win: BrowserWindow | null, chatId: string, model: string) {
  send(win, { kind: "route", chatId, model, text: labelOf(model), running: true });
}

// When an AI fails partway through, the next one is told what may already have changed.
function handover(run: Attempt, failedLabel: string): AutoPayload {
  const files = changedFiles(run.payload.chatId);
  if (!files.length) return run.payload;
  const list = files.slice(0, 30).map((f) => `- ${f}`).join("\n");
  return {
    ...run.payload,
    prompt:
      `${run.payload.prompt}\n\n(AgenticOps Desk: ${failedLabel} started on this and stopped partway. It had already changed these ` +
      `files, so look at their current state before continuing, and don't redo finished work:\n${list})`,
  };
}

export function initAuto(fn: Dispatch) {
  dispatch = fn;
  setSendFilter((win, event) => {
    const chatId = event.chatId;
    const run = chatId ? live.get(chatId) : undefined;
    if (!run || !chatId) return false;
    const step = autoStep(run, event.kind, event.text);
    if (step === "swallow") return true;
    if (step === "pass") return false;
    if (step === "finish") {
      live.delete(chatId);
      if (!run.erred && !/^Stopped/.test(event.text ?? "")) sticky.set(chatId, run.current);
      return false;
    }
    // This AI couldn't take it: rest it, tell the user, and hand the same message to the next one.
    const failed = run.failed ?? "";
    const reason = failed.split("\n")[0].slice(0, 160);
    resting[run.current] = { until: Date.now() + coolDownMs(failed), reason };
    if (sticky.get(chatId) === run.current) sticky.delete(chatId);
    const failedLabel = labelOf(run.current);
    const next = run.queue.shift()!;
    send(win, {
      kind: "note",
      chatId,
      running: true,
      text: `Auto: ${failedLabel} couldn't take this (${reason}). Trying ${labelOf(next)}…`,
    });
    const payload = handover(run, failedLabel);
    run.current = next;
    run.failed = undefined;
    run.erred = false;
    announce(win, chatId, next);
    setTimeout(() => {
      // Stopped, or the chat was deleted, while this was being handed over.
      if (live.get(chatId) === run) dispatch?.(next, payload);
    }, 0);
    return true;
  });
}

export async function runAuto(win: BrowserWindow | null, payload: AutoPayload) {
  const chatId = payload.chatId;
  const running = live.get(chatId);
  // A message during a live run steers it, so it goes to whichever AI is doing the work.
  if (running && chatState(chatId).running) {
    dispatch?.(running.current, payload);
    return;
  }
  const order = await currentOrder(chatId);
  if (!order.length) {
    send(win, {
      kind: "error",
      chatId,
      running: false,
      text:
        privacyMode() === "local"
          ? "Auto has no AI it may use: Local only is on, and no Ollama model is set up on this computer."
          : "Auto has no AI to use. Pick some in Settings › Auto model, or add a provider key.",
    });
    send(win, { kind: "done", chatId, running: false, text: "Stopped." });
    return;
  }
  const [first, ...queue] = order;
  live.set(chatId, { payload, queue, current: first });
  announce(win, chatId, first);
  dispatch?.(first, payload);
}

// The user pressed Stop: no hand-over to the next AI.
export function cancelAuto(chatId?: string) {
  if (chatId) live.delete(chatId);
  else live.clear();
}

export function forgetAuto(chatId: string) {
  live.delete(chatId);
  sticky.delete(chatId);
}
