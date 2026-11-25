import path from "node:path";
import { app } from "electron";
import { appendFileSync, readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./jsonStore";
import { generateLocally } from "./localModel";
import { privacyMode } from "./privacy";
import { claudeCodeOff, directModelOptions } from "./providers";
import { askClaudeCode } from "./quickEdit";
import { askDirect } from "./review";
import {
  applyVerdict,
  lessonVerdict,
  modelTier,
  nextTier,
  tierFromWord,
  type ModelLesson,
  type ModelTier,
} from "./pureFeatures";

// What each chat has taught the local model: which price of model was worth it.
type Store = Record<string, ModelLesson & { lastCost?: number }>;

const blank = (): ModelLesson => ({ kept: 0, retried: 0, raised: 0, lowered: 0, lastTier: 0, lastPrompt: "", assigned: "" });

function file() {
  return path.join(app.getPath("userData"), "model-learn.json");
}

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Store;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function save(all: Store) {
  writeJsonAtomicSync(file(), all);
}

export function modelForTier(tier: ModelTier): string {
  if (tier === 0) return "haiku";
  if (tier === 2) return "opus";
  return "sonnet";
}

export function tierLabel(model: string): string {
  const tier = modelTier(model);
  if (tier === 0) return "Haiku";
  if (tier === 2) return "Opus";
  return "Sonnet";
}

const ROUTER = [
  "Choose the model for this coding chat. Reply with one word: haiku, sonnet, or opus.",
  "haiku: chat, questions, explanations, lookups, or a continuation the cheap model already handled.",
  "sonnet: writing or changing code, debugging, or work across several files.",
  "opus: architecture, a hard bug, a proof, or work this chat keeps retrying or switching up to a heavier model for.",
].join("\n");

// Haiku routes: through the API key if there is one, else the Claude Code sign-in. Local only mode, or no
// answer from Haiku, falls back to the local model, which stays available.
async function askTier(row: ModelLesson, prompt: string): Promise<ModelTier | null> {
  const user = [
    `Record: kept ${row.kept}, retried ${row.retried}, switched up ${row.raised}, switched down ${row.lowered}, last tier ${row.lastTier}.`,
    `Message:\n${prompt.slice(0, 500)}`,
  ].join("\n");
  let heard: string | null = null;
  if (privacyMode() !== "local") {
    try {
      const key = directModelOptions().some((m) => m.value === "direct:anthropic:claude-haiku-5-5");
      heard = key ? ((await askDirect("direct:anthropic:claude-haiku-5-5", ROUTER, user))?.text ?? null) : claudeCodeOff() ? null : await askClaudeCode(ROUTER, user);
    } catch {
      heard = null;
    }
  }
  heard ??= await generateLocally(`${ROUTER}\n${user}`, 16, 8_000);
  return heard ? tierFromWord(heard) : null;
}

// The model for this message. A menu change away from the last pick is kept and remembered.
export async function chooseLearned(chatId: string, prompt: string, requested: string): Promise<{ model: string; label: string }> {
  const all = load();
  const row = all[chatId];
  const asked = requested.trim();
  const override = Boolean(row?.assigned) && asked !== "" && asked !== "default" && asked !== "auto" && asked !== row.assigned;
  let lesson = row ?? blank();
  if (row?.assigned) {
    const verdict = lessonVerdict(lesson, prompt, override ? asked : lesson.assigned);
    logRun({ chatId, verdict, of: lesson.assigned });
    lesson = applyVerdict(lesson, verdict);
  }
  let tier = nextTier(lesson);
  if (!override) {
    const heard = await askTier(lesson, prompt);
    if (heard !== null) tier = heard;
  }
  const model = override ? asked : modelForTier(tier);
  all[chatId] = { ...lesson, assigned: model, lastCost: row?.lastCost };
  save(all);
  return { model, label: tierLabel(model) };
}

// One line per run and per verdict, for measuring which work a local model could take (see scripts/eval).
function logRun(row: Record<string, unknown>) {
  try {
    appendFileSync(path.join(app.getPath("userData"), "runs.jsonl"), JSON.stringify({ at: Date.now(), ...row }) + "\n");
  } catch {
    /* the log is optional */
  }
}

// After a run: what it cost, and the prompt a retry would repeat.
export function noteLearned(chatId: string, prompt: string, model: string, costUsd: number, ok = true) {
  logRun({ chatId, model, costUsd, ok, prompt: prompt.trim().slice(0, 300) });
  const all = load();
  const row = all[chatId] ?? blank();
  all[chatId] = {
    ...row,
    lastTier: modelTier(model || row.assigned),
    lastPrompt: prompt.trim().slice(0, 180),
    lastCost: Math.round(costUsd * 1000) / 1000,
  };
  save(all);
}
