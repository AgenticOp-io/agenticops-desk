import { readFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { writeJsonAtomicSync } from "./jsonStore";
import { chatModelIds } from "./pureFeatures";

// AI providers the Direct engine can call without Claude Code. Keys are encrypted with Windows'
// credential protection (safeStorage) and never leave the main process.

export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini" | "deepseek" | "ollama" | "gpu";

type Preset = {
  label: string;
  kind: "anthropic" | "openai-compatible";
  baseUrl?: string;
  needsKey: boolean;
  // Fixed list for Claude. `catalog` is the menu until the provider's own /models list replaces it.
  models?: Array<{ id: string; name: string }>;
  catalog?: Array<{ id: string; name: string }>;
  keyHint: string;
};

export const PRESETS: Record<ProviderId, Preset> = {
  anthropic: {
    label: "Claude API",
    kind: "anthropic",
    needsKey: true,
    models: [
      { id: "claude-opus-5-5", name: "Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
      { id: "claude-haiku-5-5", name: "Haiku 5.5" },
      { id: "claude-fable-5-1", name: "Fable 5.1" },
      // Every other model the Claude API still serves, newest first. Each needs a price in direct.ts, or the
      // spending cap never counts its cost. Retired models (Opus 4.1 and 4, Sonnet 4) are left out.
      { id: "claude-fable-5-2", name: "Fable 5.2" },
      { id: "claude-fable-5", name: "Fable 5" },
      { id: "claude-opus-5", name: "Opus 5" },
      { id: "claude-opus-4-8", name: "Opus 4.8" },
      { id: "claude-opus-4-7", name: "Opus 4.7" },
      { id: "claude-opus-4-6", name: "Opus 4.6" },
      { id: "claude-opus-4-5", name: "Opus 4.5" },
      { id: "claude-sonnet-5", name: "Sonnet 5" },
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      { id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
      { id: "claude-haiku-4-5", name: "Haiku 4.5" },
    ],
    keyHint: "API key from platform.claude.com (sk-ant-…). Billed per token, separate from a Claude subscription.",
  },
  openai: {
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true,
    keyHint: "API key from platform.openai.com.",
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyHint: "API key from openrouter.ai. Model names look like vendor/model.",
  },
  gemini: {
    label: "Google Gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    needsKey: true,
    keyHint: "API key from aistudio.google.com.",
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    needsKey: true,
    catalog: [
      { id: "deepseek-flash", name: "DeepSeek Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
    keyHint: "API key from platform.deepseek.com.",
  },
  ollama: {
    label: "Ollama (local)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    keyHint: "No key needed. Run Ollama locally and list the models you have pulled.",
  },
  // Its own id, not "ollama": the tunnel is on localhost but the data leaves this computer, so privacy must still scrub it.
  gpu: {
    label: "Cloud GPU (Ollama over SSH tunnel)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11435/v1",
    needsKey: false,
    keyHint: "Your own cloud GPU running Ollama, reached through an SSH tunnel on port 11435. Start it and the tunnel first; it powers itself off when idle.",
  },
};

// keyRejected: the provider refused this key (401/403); cleared when a new key is saved or it works again.
type Stored = Partial<Record<ProviderId, { key?: string; models?: string[]; baseUrl?: string; keyRejected?: boolean }>>;

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  hasKey: boolean;
  keyRejected: boolean;
  needsKey: boolean;
  keyHint: string;
  baseUrl: string;
  editableModels: boolean;
  models: string[];
  ready: boolean;
};

export type DirectModelOption = {
  value: string;
  displayName: string;
  group: string;
  description?: string;
  // Shown in the agent menu before a key or a model list exists. Auto ignores these.
  needsSetup?: "key" | "models";
};

let cache: Stored | null = null;

function file() {
  return path.join(app.getPath("userData"), "providers.json");
}

function load(): Stored {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Stored) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function save() {
  writeJsonAtomicSync(file(), load());
}

function isProvider(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(PRESETS, id);
}

export function providerKey(id: ProviderId): string {
  const enc = load()[id]?.key;
  if (!enc) return "";
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return "";
  }
}

export function providerBaseUrl(id: ProviderId): string {
  return load()[id]?.baseUrl || PRESETS[id].baseUrl || "";
}

function modelsOf(id: ProviderId): string[] {
  const preset = PRESETS[id];
  const saved = load()[id]?.models ?? [];
  if (preset.models) return preset.models.map((m) => m.id);
  if (saved.length) return saved;
  return (preset.catalog ?? []).map((m) => m.id);
}

function modelName(id: ProviderId, model: string): string {
  const preset = PRESETS[id];
  return preset.models?.find((m) => m.id === model)?.name ?? preset.catalog?.find((m) => m.id === model)?.name ?? model;
}

export function providerStatus(): ProviderStatus[] {
  return (Object.keys(PRESETS) as ProviderId[]).map((id) => {
    const preset = PRESETS[id];
    const hasKey = Boolean(load()[id]?.key);
    const keyRejected = Boolean(load()[id]?.keyRejected);
    const models = modelsOf(id);
    return {
      id,
      label: preset.label,
      hasKey,
      keyRejected,
      needsKey: preset.needsKey,
      keyHint: preset.keyHint,
      baseUrl: providerBaseUrl(id),
      editableModels: !preset.models,
      models,
      ready: (hasKey || !preset.needsKey) && !keyRejected && models.length > 0,
    };
  });
}

// Remembers whether the provider accepted the key, so the agent menu only lists providers that work.
export function setKeyRejected(id: ProviderId, rejected: boolean) {
  const cur = load()[id];
  if (!cur || Boolean(cur.keyRejected) === rejected) return;
  if (rejected) cur.keyRejected = true;
  else delete cur.keyRejected;
  save();
}

export function setProvider(id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) {
  if (!isProvider(id)) throw new Error(`Unknown provider ${id}`);
  const all = load();
  const cur = { ...(all[id] ?? {}) };
  if (patch.key === null || patch.key === "") delete cur.key;
  else if (typeof patch.key === "string") {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows could not encrypt the key, so it was not saved.");
    cur.key = safeStorage.encryptString(patch.key.trim()).toString("base64");
  }
  if (patch.key !== undefined) delete cur.keyRejected;
  if (Array.isArray(patch.models)) {
    cur.models = patch.models.map((m) => m.trim()).filter(Boolean).slice(0, 30);
  }
  if (typeof patch.baseUrl === "string") {
    const url = patch.baseUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) throw new Error("The address must start with http:// or https://");
    if (url) cur.baseUrl = url;
    else delete cur.baseUrl;
  }
  all[id] = cur;
  save();
  return providerStatus();
}

// Model picker entries for the Direct engine: value "direct:<provider>:<model>".
// Only providers with a key that has not been rejected (or that need none) and a model list are listed;
// the rest are set up in Settings → Providers.
export function directModelOptions(): DirectModelOption[] {
  return providerStatus()
    .filter((p) => p.ready)
    .flatMap((p) => p.models.map((m) => ({ value: `direct:${p.id}:${m}`, displayName: modelName(p.id, m), group: `Direct · ${p.label}` })));
}

// Asks the provider for its model list and stores the chat models. Claude's list is fixed.
export async function pullProviderModels(id: string): Promise<void> {
  if (!isProvider(id)) throw new Error(`Unknown provider ${id}`);
  const preset = PRESETS[id];
  if (preset.kind === "anthropic") return;
  const key = providerKey(id);
  if (preset.needsKey && !key) throw new Error(`Add an API key for ${preset.label} first.`);
  const base = providerBaseUrl(id).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    throw new Error(`${preset.label} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) setKeyRejected(id, true);
  if (!res.ok) throw new Error(`${preset.label} returned ${res.status} when listing models.`);
  setKeyRejected(id, false);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = chatModelIds((body.data ?? []).map((m) => m.id ?? ""));
  if (!ids.length) throw new Error(`${preset.label} did not list any chat models.`);
  const all = load();
  all[id] = { ...(all[id] ?? {}), models: ids };
  save();
}

export function parseDirectModel(value: string): { provider: ProviderId; model: string } | null {
  const m = /^direct:([a-z]+):(.+)$/.exec(value);
  if (!m || !isProvider(m[1])) return null;
  return { provider: m[1], model: m[2] };
}
