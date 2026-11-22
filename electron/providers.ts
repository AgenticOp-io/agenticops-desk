import { readFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { writeJsonAtomicSync } from "./jsonStore";
import { chatModelIds, isCustomProviderId, PROVIDER_CATALOGS } from "./pureFeatures";

// AI providers the Direct engine can call without Claude Code. Keys are encrypted with Windows'
// credential protection (safeStorage) and never leave the main process.

export type BuiltinId = "anthropic" | "openai" | "openrouter" | "gemini" | "deepseek" | "xai" | "mistral" | "qwen" | "moonshot" | "zhipu" | "groq" | "together" | "fireworks" | "ollama" | "gpu";
// `u…` ids are OpenAI-compatible services the user added in Settings.
export type ProviderId = BuiltinId | `u${string}`;

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

export const PRESETS: Record<BuiltinId, Preset> = {
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
    catalog: PROVIDER_CATALOGS.openai,
    keyHint: "API key from platform.openai.com. GPT models are listed below; Test and load checks the key.",
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
    catalog: PROVIDER_CATALOGS.gemini,
    keyHint: "API key from aistudio.google.com. The Gemini API must be enabled on that key's project.",
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
  xai: {
    label: "xAI Grok",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    needsKey: true,
    catalog: PROVIDER_CATALOGS.xai,
    keyHint: "API key from console.x.ai. Billed per token, separate from a Grok or Cursor subscription.",
  },
  mistral: {
    label: "Mistral",
    kind: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    catalog: PROVIDER_CATALOGS.mistral,
    keyHint: "API key from console.mistral.ai.",
  },
  qwen: {
    label: "Qwen",
    kind: "openai-compatible",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    needsKey: true,
    catalog: PROVIDER_CATALOGS.qwen,
    keyHint: "API key from Alibaba Model Studio. Change the address if your key is for a different region.",
  },
  // No fixed model names: Test and load fills the menu from each service's own /models list.
  moonshot: {
    label: "Kimi (Moonshot)",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    needsKey: true,
    keyHint: "API key from platform.moonshot.ai. Use api.moonshot.cn as the address for a China account.",
  },
  zhipu: {
    label: "GLM (Z.ai)",
    kind: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    needsKey: true,
    keyHint: "API key from z.ai. Use open.bigmodel.cn/api/paas/v4 as the address for a China account.",
  },
  groq: {
    label: "Groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true,
    keyHint: "API key from console.groq.com. Very fast open models.",
  },
  together: {
    label: "Together AI",
    kind: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    needsKey: true,
    keyHint: "API key from api.together.ai. Hosts many open models.",
  },
  fireworks: {
    label: "Fireworks AI",
    kind: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    needsKey: true,
    keyHint: "API key from fireworks.ai. Model names look like accounts/fireworks/models/name.",
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

type Row = { key?: string; models?: string[]; baseUrl?: string; label?: string; keyRejected?: boolean };
type Stored = Partial<Record<string, Row>>;

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
  removable: boolean;
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

function isBuiltin(id: string): id is BuiltinId {
  return Object.prototype.hasOwnProperty.call(PRESETS, id);
}

function isProvider(id: string): id is ProviderId {
  return isBuiltin(id) || (isCustomProviderId(id) && Boolean(load()[id]));
}

// Built-in preset, or the name and address the user saved for an AI they added.
export function providerInfo(id: ProviderId): Preset {
  if (isBuiltin(id)) return PRESETS[id];
  const row = load()[id];
  return {
    label: row?.label || "Added AI",
    kind: "openai-compatible",
    baseUrl: row?.baseUrl,
    needsKey: true,
    keyHint: "OpenAI-compatible address. Test and load fills the model menu.",
  };
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
  return load()[id]?.baseUrl || providerInfo(id).baseUrl || "";
}

function modelsOf(id: ProviderId): string[] {
  const preset = providerInfo(id);
  const saved = load()[id]?.models ?? [];
  if (preset.models) return preset.models.map((m) => m.id);
  if (saved.length) return saved;
  return (preset.catalog ?? []).map((m) => m.id);
}

function modelName(id: ProviderId, model: string): string {
  const preset = providerInfo(id);
  return preset.models?.find((m) => m.id === model)?.name ?? preset.catalog?.find((m) => m.id === model)?.name ?? model;
}

function statusOf(id: ProviderId): ProviderStatus {
  const preset = providerInfo(id);
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
    removable: isCustomProviderId(id),
  };
}

// A keyless local provider is only "ready" while something answers there; drop a model list left from a server that is gone.
export async function pruneDeadLocal(): Promise<void> {
  for (const id of ["ollama"] as const) {
    const all = load();
    if (!all[id]?.models?.length) continue;
    const up = await fetch(`${providerBaseUrl(id).replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1_500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (up) continue;
    all[id] = { ...all[id], models: [] };
    save();
  }
}

export function providerStatus(): ProviderStatus[] {
  const custom = Object.keys(load()).filter(isCustomProviderId).sort();
  return [...(Object.keys(PRESETS) as BuiltinId[]), ...custom].map((id) => statusOf(id as ProviderId));
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

export function addCustomProvider(input: { label?: string; baseUrl?: string }): ProviderStatus[] {
  const label = String(input.label ?? "").trim().slice(0, 40);
  if (!label) throw new Error("Name the AI first.");
  const url = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) throw new Error("The address must start with http:// or https://");
  const all = load();
  let id = "";
  for (let n = 0; n < 5 && !id; n++) {
    const candidate = `u${Math.random().toString(36).slice(2, 8)}`;
    if (isCustomProviderId(candidate) && !all[candidate]) id = candidate;
  }
  if (!id) throw new Error("Could not add that AI. Try again.");
  all[id] = { label, baseUrl: url };
  save();
  return providerStatus();
}

export function removeCustomProvider(id: string): ProviderStatus[] {
  if (!isCustomProviderId(id) || !load()[id]) throw new Error("Only an AI you added can be removed.");
  delete load()[id];
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

// The built-in helper server (llama-server) answers on Ollama's port but runs a 2-4K context; the system prompt and tools alone fill that.
// Checked on listing and again on every run, since a model listed back when real Ollama ran there stays in the menu.
export async function assertChatContext(id: ProviderId): Promise<void> {
  const base = providerBaseUrl(id).replace(/\/+$/, "");
  const props = await fetch(`${new URL(base).origin}/props`, { signal: AbortSignal.timeout(2_000) })
    .then((r) => (r.ok ? (r.json() as Promise<{ default_generation_settings?: { n_ctx?: number } }>) : null))
    .catch(() => null);
  const ctx = props?.default_generation_settings?.n_ctx;
  if (ctx && ctx < 8192) {
    const all = load();
    if (all[id]?.models?.length) {
      all[id] = { ...all[id], models: [] }; // drop the stale entry from the model menu
      save();
    }
    throw new Error(
      `${providerInfo(id).label} is answered by the built-in summaries helper (${ctx}-token context), not Ollama. It is too small for chats. Install Ollama and run it with OLLAMA_CONTEXT_LENGTH=16384, or pick another model.`,
    );
  }
}

// Asks the provider for its model list and stores the chat models. Claude's list is fixed.
export async function pullProviderModels(id: string): Promise<void> {
  if (!isProvider(id)) throw new Error(`Unknown provider ${id}`);
  const preset = providerInfo(id);
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
  await assertChatContext(id);
  setKeyRejected(id, false);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const listed = new Set(chatModelIds((body.data ?? []).map((m) => m.id ?? ""), 80));
  const prefer = (preset.catalog ?? []).map((m) => m.id).filter((model) => listed.has(model));
  const ids = [...prefer, ...[...listed].filter((model) => !prefer.includes(model))].slice(0, 30);
  if (!ids.length) throw new Error(`${preset.label} did not list any chat models.`);
  const all = load();
  all[id] = { ...(all[id] ?? {}), models: ids };
  save();
}

export function parseDirectModel(value: string): { provider: ProviderId; model: string } | null {
  const m = /^direct:([a-z0-9]+):(.+)$/.exec(value);
  if (!m || !isProvider(m[1])) return null;
  return { provider: m[1], model: m[2] };
}
