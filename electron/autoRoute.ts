import type { BrowserWindow } from "electron";
import { changedFiles, chatState, listModels, send, setSendFilter } from "./claude";
import { autoOrder, autoStep, isOwnedModel, restUntil } from "./pureFeatures";
import { isLocalProvider, privacyMode } from "./privacy";
import { parseDirectModel, providerBaseUrl, providerKey } from "./providers";
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

// Everything Auto could use right now. One signed-in agent, then each ready Direct model.
// Extra Claude Code models share that sign-in's limit, so they are not separate choices.
// Local-only privacy keeps it on this computer. The user's chosen order still wins.
export function autoAvailable(): string[] {
  const enabled = listModels().filter((m) => m.value !== AUTO && !m.needsSetup && !m.pinned && m.group !== "Claude Code").map((m) => m.value);
  const all = [...new Set([CLAUDE_DEFAULT, ...enabled])];
  if (privacyMode() !== "local") return all;
  return all.filter((m) => {
    const d = parseDirectModel(m);
    return Boolean(d && isLocalProvider(d.provider));
  });
}

function restingUntil(): Record<string, number> {
  return Object.fromEntries(Object.entries(resting).map(([k, v]) => [k, v.until]));
}

// Ollama, the user's GPU, and a service they added on this computer.
function modelOwned(model: string): boolean {
  if (isOwnedModel(model)) return true;
  const direct = parseDirectModel(model);
  return Boolean(direct && isLocalProvider(direct.provider));
}

// Prepaid providers that report a balance. Checked once per 5 minutes; a failed check counts as funded.
const unfunded = new Set<string>();
let probedAt = 0;
async function probeBalances() {
  if (Date.now() - probedAt < 300_000) return;
  probedAt = Date.now();
  const ask = async (id: "deepseek" | "openrouter", path: string, empty: (j: any) => boolean) => {
    const key = providerKey(id);
    if (!key) {
      unfunded.delete(id);
      return;
    }
    try {
      const r = await fetch(providerBaseUrl(id).replace(/\/+$/, "") + path, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4_000) });
      if (!r.ok) return;
      if (empty(await r.json())) unfunded.add(id);
      else unfunded.delete(id);
    } catch {
      /* unreachable: leave as it was */
    }
  };
  await Promise.all([
    ask("deepseek", "/user/balance", (j) => j?.is_available === false),
    ask("openrouter", "/key", (j) => j?.data?.limit_remaining != null && j.data.limit_remaining <= 0),
  ]);
}

async function currentOrder(chatId?: string): Promise<string[]> {
  const settings = await loadSettings();
  await probeBalances();
  const order = await orderNow(settings, chatId);
  const dry = (m: string) => unfunded.has(parseDirectModel(m)?.provider ?? "");
  // shortcut: unfunded providers go last, not removed; they may have been topped up since the 5-minute check.
  return [...order.filter((m) => !dry(m)), ...order.filter(dry)];
}

async function orderNow(settings: Awaited<ReturnType<typeof loadSettings>>, chatId?: string): Promise<string[]> {
  return autoOrder({
    chosen: settings.autoModels,
    available: autoAvailable(),
    sticky: chatId ? sticky.get(chatId) : undefined,
    restingUntil: restingUntil(),
    now: Date.now(),
    owned: modelOwned,
  });
}

// For Settings: the order Auto would try right now, which AIs are resting and why, and each chat's pick.
export async function autoStatus(): Promise<AutoStatus> {
  const now = Date.now();
  const available = autoAvailable();
  const trying = await currentOrder();
  const turnedOff = available.filter((value) => {
    const r = resting[value];
    return Boolean(r && r.until > now && !trying.includes(value));
  });
  const order = [...trying, ...turnedOff].map((value) => {
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

const NO_MODELS = "No AI models available.";

function announce(win: BrowserWindow | null, chatId: string, model: string) {
  send(win, { kind: "route", chatId, model, text: labelOf(model), running: true });
}

function reportNone(win: BrowserWindow | null, chatId: string) {
  send(win, { kind: "note", chatId, text: NO_MODELS, running: false });
  send(win, { kind: "route", chatId, model: AUTO, text: NO_MODELS, running: false });
  send(win, { kind: "done", chatId, running: false, text: "Stopped." });
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
    resting[run.current] = { until: restUntil(failed, Date.now()), reason };
    if (sticky.get(chatId) === run.current) sticky.delete(chatId);
    const failedLabel = labelOf(run.current);
    const next = run.queue.shift();
    if (!next) {
      live.delete(chatId);
      reportNone(win, chatId);
      return true;
    }
    const payload = handover(run, failedLabel);
    run.current = next;
    run.failed = undefined;
    run.erred = false;
    announce(win, chatId, next);
    setTimeout(() => {
      // Stopped, or the chat was deleted, while this was being handed over.
      if (live.get(chatId) !== run) return;
      try {
        dispatch?.(next, payload);
      } catch (err) {
        // Without this the chat would show "running" forever.
        live.delete(chatId);
        send(win, { kind: "route", chatId, model: next, text: `${labelOf(next)} did not start. See Settings › Auto model.`, running: false });
        send(win, { kind: "done", chatId, running: false, text: "Stopped." });
      }
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
  let order = await currentOrder(chatId);
  // A stale rest mark must not block the sign-in; try it once, a real limit error rests it again.
  if (!order.length && autoAvailable().includes(CLAUDE_DEFAULT)) {
    wakeAuto(CLAUDE_DEFAULT);
    order = [CLAUDE_DEFAULT];
  }
  if (!order.length) {
    reportNone(win, chatId);
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

// True while Auto is still working a chat, including the gap between one AI failing and the next starting.
export const autoLive = (chatId: string) => live.has(chatId);

export function forgetAuto(chatId: string) {
  live.delete(chatId);
  sticky.delete(chatId);
}
