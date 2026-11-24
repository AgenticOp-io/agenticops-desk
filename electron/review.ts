import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import path from "node:path";
import { helperBaseUrl, retryWhileLoading } from "./localModel";
import { parseDirectModel, providerBaseUrl, providerInfo, providerKey } from "./providers";
import { lineDiff } from "./pureFeatures";
import { recordUsage } from "./usageLog";

// Second opinion: after a run changes files, a model from a different provider (any Direct model the
// user set up) checks the change against what the user actually asked, before the user reads the diff.
export type ChangedFile = { path: string; before: string | null; after: string | null };

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const DIFF_LIMIT = 8_000;

function describe(files: ChangedFile[], cwd: string) {
  let text = "";
  for (const f of files) {
    const rel = path.relative(cwd, f.path) || f.path;
    const body =
      f.before === null ? `(new file)\n${(f.after ?? "").slice(0, 2_000)}` : f.after === null ? "(deleted)" : lineDiff(f.before, f.after);
    text += `\n### ${rel}\n${body}\n`;
    if (text.length > DIFF_LIMIT) {
      text = `${text.slice(0, DIFF_LIMIT)}\n… (diff cut for length)`;
      break;
    }
  }
  return text;
}

const SYSTEM =
  "You review a change another AI coding agent just made. Judge only whether the change does what the user asked, " +
  "and flag clear bugs, missed parts of the request, or edits the user did not ask for. Do not restate the change. " +
  "Answer in at most 6 short lines. Start with exactly 'Matches the request.' or 'Concerns:' followed by bullet points.";

export async function secondOpinion(opts: {
  reviewer: string;
  request: string;
  files: ChangedFile[];
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ label: string; text: string } | null> {
  if (!opts.files.length) return null;
  const user = `The user asked:\n${opts.request.slice(0, 6000)}\n\nThe change:\n${describe(opts.files, opts.cwd)}`;
  const r = await askDirect(opts.reviewer, SYSTEM, user, opts.signal);
  if (!r) return null;
  if (r.refused) return { label: r.label, text: "The reviewer declined to review this change." };
  return r.text ? { label: r.label, text: r.text } : null;
}

// One question to one Direct model ("direct:<provider>:<model>"), no tools. Null when that model is not set up.
export async function askDirect(
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<{ label: string; text: string; refused?: boolean } | null> {
  const pick = parseDirectModel(model);
  if (!pick) return null;
  const preset = providerInfo(pick.provider);
  if (preset.needsKey && !providerKey(pick.provider)) return null;
  const label = `${preset.label} · ${pick.model}`;
  if (preset.kind === "anthropic") {
    const client = new Anthropic({ apiKey: providerKey("anthropic") });
    const msg = await client.beta.messages.create(
      {
        model: pick.model,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }],
        ...(FALLBACK_MODELS.has(pick.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
    recordUsage("anthropic", msg.model, {
      input: msg.usage.input_tokens ?? 0,
      output: msg.usage.output_tokens ?? 0,
      cacheRead: msg.usage.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
    });
    if (msg.stop_reason === "refusal") return { label, text: "", refused: true };
    return { label, text: msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() };
  }
  // The built-in summaries helper has no provider entry; reach it directly when the model is its own.
  const baseURL = (pick.provider === "ollama" && (await helperBaseUrl(pick.model))) || providerBaseUrl(pick.provider);
  const client = new OpenAI({ apiKey: providerKey(pick.provider) || "local", baseURL });
  const res = await retryWhileLoading(
    () => client.chat.completions.create(
      { model: pick.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      { signal },
    ),
    signal,
  );
  if (res.usage) recordUsage(pick.provider, pick.model, { input: res.usage.prompt_tokens ?? 0, output: res.usage.completion_tokens ?? 0 });
  return { label, text: res.choices[0]?.message?.content?.trim() ?? "" };
}
