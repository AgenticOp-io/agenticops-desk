import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { writeJsonAtomicSync } from "./jsonStore";
import { scrubOutgoing } from "./privacy";
import { capsuleBrief, makeCapsule, type Capsule } from "./pureFeatures";
import { loadSettings } from "./settings";
import { askDirect } from "./review";

// Verified run capsules per chat, in app data (never in the project). See Capsule in pureFeatures.ts.
const KEEP = 12;
const DIGEST_LIMIT = 5_000_000;

let cache: Record<string, Capsule[]> | null = null;

function file() {
  return path.join(app.getPath("userData"), "capsules.json");
}

function load(): Record<string, Capsule[]> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save() {
  try {
    writeJsonAtomicSync(file(), load(), false);
  } catch (err) {
    console.error("AgenticOps Desk could not save run capsules", err);
  }
}

export function digestFile(p: string): string | null {
  try {
    if (!existsSync(p) || statSync(p).size > DIGEST_LIMIT) return null;
    return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export function recordCapsule(chatId: string, run: { request: string; outcome: string; gates: string[]; files: string[] }): Capsule | null {
  const capsule = makeCapsule({
    at: Date.now(),
    request: run.request,
    outcome: run.outcome,
    gates: run.gates,
    files: run.files.map((p) => ({ path: p, digest: digestFile(p) })),
  });
  if (!capsule) return null;
  const all = load();
  all[chatId] = [...(all[chatId] ?? []), capsule].slice(-KEEP);
  save();
  return capsule;
}

// Chat summaries written by the Summaries model (Settings › Models), usually a local Ollama one, so a handoff
// carries a short summary instead of clipped turns. `turns` is how many turns it covers; a summary only stands in
// for a history of exactly that length, otherwise the plain brief is used.
type Summary = { text: string; turns: number };
let summaryCache: Record<string, Summary> | null = null;

function summaryFile() {
  return path.join(app.getPath("userData"), "chat-summaries.json");
}

function summaries(): Record<string, Summary> {
  if (summaryCache) return summaryCache;
  try {
    const raw = JSON.parse(readFileSync(summaryFile(), "utf8"));
    summaryCache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    summaryCache = {};
  }
  return summaryCache!;
}

function saveSummaries() {
  try {
    writeJsonAtomicSync(summaryFile(), summaries(), false);
  } catch (err) {
    console.error("AgenticOps Desk could not save chat summaries", err);
  }
}

const said = (history: { role: string; text: string }[]) => history.filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim());

export function chatSummary(chatId: string, history: { role: string; text: string }[] | undefined): string {
  const s = summaries()[chatId];
  if (!s?.text) return "";
  // The new message is sent on its own. A summary that is a few turns behind still describes the chat.
  // Rewriting it before the agent starts is what left the chat sitting on the summary.
  if (s.turns > said(history ?? []).length) return "";
  return s.text;
}

const SUMMARY_SYSTEM =
  "You keep a running summary of a chat between a user and an AI coding agent, so a fresh agent can continue it without the transcript. " +
  "Merge the earlier summary with the new turns. At most 250 words: the goal, decisions and the user's preferences, what is done, what is left, " +
  "and the exact file names, commands and errors that matter. Plain text, no preamble.";
const OUTCOME_SYSTEM =
  "Restate what this finished AI coding run did, in at most 2 sentences. Keep file names and the checks that passed. Plain text, no preamble.";
const NEW_TURNS_LIMIT = 3_000; // the built-in helper has a 2048-token window; one bite plus the summary must fit
const MAX_PASSES = 8;

// The model the user picked, or the local one. An empty Summaries setting still stays on this computer.
async function summaryModel(): Promise<string> {
  try {
    const settings = await loadSettings();
    const chosen = settings.summarizer?.trim();
    if (chosen) return chosen;
    return settings.localModelId ? `direct:ollama:${settings.localModelId}` : "";
  } catch {
    return "";
  }
}

// The summary for this history, writing it locally when the saved one does not cover these turns.
export async function ensureSummary(
  chatId: string,
  history: { role: string; text: string }[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const ready = chatSummary(chatId, history);
  if (ready || signal?.aborted) return ready;
  // No summary yet. The brief covers this message. Writing one must not hold the agent.
  void summarizeRun(chatId, await summaryModel(), history ?? [], null, signal);
  return "";
}

// After a run, so the next message usually already has its summary.
export async function refreshSummary(chatId: string, history: { role: string; text: string }[], capsule: Capsule | null) {
  await summarizeRun(chatId, await summaryModel(), history, capsule);
}

// Update the chat's rolling summary and tighten the new capsule's result. Failures leave the plain brief.
export async function summarizeRun(
  chatId: string,
  model: string,
  history: { role: string; text: string }[],
  capsule: Capsule | null,
  signal?: AbortSignal,
) {
  const turns = said(history);
  const prev = summaries()[chatId];
  const base = prev && prev.turns <= turns.length ? prev : undefined;
  const clean = (s: string) => scrubOutgoing(s).text;
  if (!model) return;
  const timeout = AbortSignal.timeout(90_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (turns.length >= 2) {
      // Feed the new turns in bites that fit a small window, folding each into the running summary.
      // Progress is saved per bite, so a long backlog finishes over a few runs if the passes run out.
      let at = base?.turns ?? 0;
      let text = base?.text ?? "(none)";
      for (let pass = 0; at < turns.length && pass < MAX_PASSES; pass++) {
        let bite = "";
        let end = at;
        while (end < turns.length) {
          const m = turns[end];
          const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`;
          if (bite && bite.length + line.length > NEW_TURNS_LIMIT) break;
          bite += `${bite ? "\n\n" : ""}${line.length > NEW_TURNS_LIMIT ? `${line.slice(0, NEW_TURNS_LIMIT)}…` : line}`;
          end++;
        }
        const r = await askDirect(model, SUMMARY_SYSTEM, `Earlier summary:\n${text}\n\nNew turns:\n${clean(bite)}`, stop);
        if (!r?.text || r.refused) break;
        text = r.text.slice(0, 3_000);
        at = end;
        summaries()[chatId] = { text, turns: at };
        saveSummaries();
      }
    }
    if (capsule && capsule.outcome.length > 300) {
      const r = await askDirect(model, OUTCOME_SYSTEM, `Asked: ${clean(capsule.request)}\n\nThe agent's final reply:\n${clean(capsule.outcome)}`, stop);
      if (r?.text && !r.refused && r.text.length < capsule.outcome.length) {
        capsule.outcome = r.text.replace(/\s+/g, " ").slice(0, 700);
        save();
      }
    }
  } catch (err) {
    if (stop.aborted) return;
    console.error("AgenticOps Desk could not summarize the run", err);
  }
}

export function capsulesBrief(chatId: string): string {
  return capsuleBrief(load()[chatId] ?? [], digestFile);
}

export function forgetCapsules(chatId: string) {
  const all = load();
  if (!all[chatId]) return;
  delete all[chatId];
  save();
  if (summaries()[chatId]) {
    delete summaries()[chatId];
    saveSummaries();
  }
}
