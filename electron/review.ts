import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import path from "node:path";
import { PRESETS, parseDirectModel, providerBaseUrl, providerKey } from "./providers";
import { lineDiff } from "./pureFeatures";

// Second opinion: after a run changes files, a model from a different provider (any Direct model the
// user set up) checks the change against what the user actually asked, before the user reads the diff.
export type ChangedFile = { path: string; before: string | null; after: string | null };

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const DIFF_LIMIT = 40_000;

function describe(files: ChangedFile[], cwd: string) {
  let text = "";
  for (const f of files) {
    const rel = path.relative(cwd, f.path) || f.path;
    const body =
      f.before === null ? `(new file)\n${(f.after ?? "").slice(0, 8000)}` : f.after === null ? "(deleted)" : lineDiff(f.before, f.after);
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
  const pick = parseDirectModel(opts.reviewer);
  if (!pick || !opts.files.length) return null;
  const preset = PRESETS[pick.provider];
  if (preset.needsKey && !providerKey(pick.provider)) return null;
  const user = `The user asked:\n${opts.request.slice(0, 6000)}\n\nThe change:\n${describe(opts.files, opts.cwd)}`;
  const label = `${preset.label} · ${pick.model}`;
  if (preset.kind === "anthropic") {
    const client = new Anthropic({ apiKey: providerKey("anthropic") });
    const msg = await client.beta.messages.create(
      {
        model: pick.model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
        ...(FALLBACK_MODELS.has(pick.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: opts.signal },
    );
    if (msg.stop_reason === "refusal") return { label, text: "The reviewer declined to review this change." };
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return text ? { label, text } : null;
  }
  const client = new OpenAI({ apiKey: providerKey(pick.provider) || "local", baseURL: providerBaseUrl(pick.provider) });
  const res = await client.chat.completions.create(
    { model: pick.model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] },
    { signal: opts.signal },
  );
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  return text ? { label, text } : null;
}
