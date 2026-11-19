// Models the app can download from the public registry. "" means do not run one.
export const LOCAL_MODEL_CHOICES: { id: string; label: string; detail: string }[] = [
  { id: "", label: "None", detail: "No model on this computer. Notes stay a short brief, and the agent can re-read details." },
  { id: "qwen2.5:1.5b", label: "Brief notes", detail: "About 1 GB. Short summaries. Enough when a missing detail can be looked up again." },
  { id: "qwen2.5:3b", label: "More detail", detail: "About 2 GB. Keeps paths and decisions more carefully." },
  { id: "qwen2.5-coder:3b", label: "Code heavy", detail: "About 2 GB. Better when the notes should keep signatures and code." },
];

export const DEFAULT_LOCAL_MODEL = "qwen2.5:1.5b";

// A missing value, or the old 7B id, becomes the small default. An explicit empty string stays off.
export function normalizeLocalModel(value: unknown): string {
  if (value === "") return "";
  if (typeof value !== "string") return DEFAULT_LOCAL_MODEL;
  return LOCAL_MODEL_CHOICES.some((c) => c.id === value) ? value : DEFAULT_LOCAL_MODEL;
}
