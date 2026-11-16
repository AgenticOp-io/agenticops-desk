import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";
import { addUsage, summarizeUsage, type UsageLog, type UsageRow, type UsageTally } from "./pureFeatures";

// Tokens and estimated cost per day, per engine or Direct provider, per model, plus the last plan-limit
// readings from the default engine. Only counts; no prompts or replies are stored here.

export type PlanWindow = { id: string; label: string; percent: number | null; resetsAt: number | null };
export type PlanLimits = { updatedAt: number; subscription: string | null; windows: PlanWindow[]; note?: string };
export type UsageReport = { rows: UsageRow[]; plan: PlanLimits | null };

type Stored = UsageLog & { plan?: PlanLimits };

const KEY = "usage";
let cache: Stored | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function usageFile() {
  return path.join(app.getPath("userData"), "usage.json");
}

async function load(): Promise<Stored> {
  if (cache) return cache;
  const raw = (await readJson(usageFile())) as Stored | undefined;
  if (raw && typeof raw === "object" && raw.days && typeof raw.days === "object") cache = raw;
  else {
    cache = { days: {} };
    await backfill(cache).catch((err) => console.error("AgenticOps Desk could not read past usage", err));
    scheduleSave();
  }
  return cache;
}

// The first time, count the last 30 days from the engine's own session logs, so the page is not empty.
// Those logs have tokens per call but no price.
async function backfill(log: Stored) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const since = Date.now() - 30 * 86_400_000;
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".jsonl")) files.push(p);
    }
  };
  await walk(root);
  const seen = new Set<string>();
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs < since) continue;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"usage"')) continue;
      let row: { timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, number> } };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const u = row.message?.usage;
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN;
      const id = row.message?.id;
      const model = row.message?.model ?? "";
      if (!u || !id || seen.has(id) || !(at >= since) || model === "<synthetic>") continue;
      seen.add(id);
      const add = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      };
      if (add.input + add.output + add.cacheRead + add.cacheWrite) addUsage(log, at, "claude-code", model, add);
    }
  }
}

// Direct runs record every turn. Writes are batched so a long run does not rewrite the file each step.
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void serialized(KEY, async () => {
      if (cache) await writeJsonAtomic(usageFile(), cache, false);
    });
  }, 2000);
}

export function recordUsage(source: string, model: string, add: Partial<UsageTally>) {
  void serialized(`${KEY}:add`, async () => {
    addUsage(await load(), Date.now(), source, model, add);
    scheduleSave();
  });
}

export function recordPlan(update: (plan: PlanLimits) => PlanLimits) {
  void serialized(`${KEY}:add`, async () => {
    const log = await load();
    log.plan = update(log.plan ?? { updatedAt: 0, subscription: null, windows: [] });
    scheduleSave();
  });
}

export async function usageReport(): Promise<UsageReport> {
  const log = await load();
  return { rows: summarizeUsage(log, Date.now()), plan: log.plan ?? null };
}

let peekedPlan: PlanLimits | null | undefined;

function peekPlan(): PlanLimits | null {
  if (cache?.plan) return cache.plan;
  if (peekedPlan !== undefined) return peekedPlan;
  try {
    const raw = JSON.parse(readFileSync(usageFile(), "utf8")) as Stored;
    peekedPlan = raw?.plan ?? null;
  } catch {
    peekedPlan = null;
  }
  return peekedPlan;
}

// The rolling allowance, or null once that window has reset or never been read.
// A reset reading must not keep blocking resumes.
export function fiveHourWindow(now = Date.now()): { percent: number; resetsAt: number | null } | null {
  const window = peekPlan()?.windows.find((w) => w.id === "five_hour");
  if (!window || window.percent == null) return null;
  if (window.resetsAt != null && window.resetsAt <= now) return null;
  return { percent: window.percent, resetsAt: window.resetsAt };
}
