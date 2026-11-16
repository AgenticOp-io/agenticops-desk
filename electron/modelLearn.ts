import path from "node:path";
import { app } from "electron";
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./jsonStore";
import { generateLocally, LOCAL_MODEL } from "./localModel";
import {
  applyVerdict,
  lessonVerdict,
  modelTier,
  nextTier,
  tierForAgent,
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
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function save(all: Store) {
  writeJsonAtomicSync(file(), all);
}

export function modelForTier(tier: ModelTier): string {
  if (tier === 0) return `direct:ollama:${LOCAL_MODEL}`;
  if (tier === 2) return "opus";
  return "sonnet";
}

export function tierLabel(model: string): string {
  const tier = modelTier(model);
  if (tier === 0) return "Local model";
  if (tier === 2) return "Opus";
  return "Sonnet";
}

async function askTier(row: ModelLesson, prompt: string): Promise<ModelTier | null> {
  const heard = await generateLocally(
    [
      "Choose the model for this coding chat. Reply with one word: local, sonnet, or opus.",
      "local: a small edit, a lookup, or a continuation the cheap model already handled.",
      "sonnet: ordinary coding.",
      "opus: a proof, a design, or work this chat keeps retrying or switching up to a heavier model for.",
      `Record: kept ${row.kept}, retried ${row.retried}, switched up ${row.raised}, switched down ${row.lowered}, last tier ${row.lastTier}.`,
      `Message:\n${prompt.slice(0, 500)}`,
    ].join("\n"),
    16,
    8_000,
  );
  return heard ? tierFromWord(heard) : null;
}

// The model for this message. A menu change away from the last pick is kept and remembered.
export async function chooseLearned(chatId: string, prompt: string, requested: string): Promise<{ model: string; label: string }> {
  const all = load();
  const row = all[chatId];
  const asked = requested.trim();
  const override = Boolean(row?.assigned) && asked !== "" && asked !== "default" && asked !== "auto" && asked !== row.assigned;
  let lesson = row ?? blank();
  if (row?.assigned) lesson = applyVerdict(lesson, lessonVerdict(lesson, prompt, override ? asked : lesson.assigned));
  let tier = nextTier(lesson);
  if (!override) {
    const heard = await askTier(lesson, prompt);
    if (heard !== null) tier = heard;
    // A local pick, or no answer, still runs on Sonnet. The small model only writes the summary.
    tier = tierForAgent(tier);
  }
  const model = override ? asked : modelForTier(tier);
  all[chatId] = { ...lesson, assigned: model, lastCost: row?.lastCost };
  save(all);
  return { model, label: tierLabel(model) };
}

// After a run: what it cost, and the prompt a retry would repeat.
export function noteLearned(chatId: string, prompt: string, model: string, costUsd: number) {
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
