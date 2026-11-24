import { listFiles, readRepoFile, writeRepoFile } from "./github";

// The phone's own agent: a tool loop that calls the Anthropic Messages API directly with a credential typed on this phone.
// shortcut: it sits in localStorage (app-private, unencrypted), replies are not streamed; move to the keystore and streaming later.
export const credential = { get: () => localStorage.getItem("phone.ai") ?? "", set: (k: string) => localStorage.setItem("phone.ai", k.trim()) };

// Optional local model (Ollama, which speaks the same Messages API at /v1/messages). When set it replaces Haiku as the chat model.
export const localModel = {
  get: () => JSON.parse(localStorage.getItem("phone.local") ?? '{"url":"","model":""}') as { url: string; model: string },
  set: (url: string, model: string) => localStorage.setItem("phone.local", JSON.stringify({ url: url.trim().replace(/\/+$/, ""), model: model.trim() })),
};

// "auto" = chat model routes; otherwise every turn is pinned to that model.
export type Route = "auto" | "haiku" | "sonnet" | "opus";
export const route = { get: () => (localStorage.getItem("phone.route") ?? "auto") as Route, set: (r: Route) => localStorage.setItem("phone.route", r) };
const PINNED = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } as const;

export type AgentMsg = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> };

const HARDER = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } as const;

const TOOLS = [
  { name: "list_files", description: "List files in the repository.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "read_file", description: "Read a file from the repository.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or replace a file on the phone-work branch (never the default branch).", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  {
    name: "escalate",
    description:
      "Hand the rest of this request to a stronger model. Call it before doing the work when the request needs real coding: writing or changing code, debugging, or multi-file reasoning (sonnet), or architecture, a hard bug, or a task that already failed (opus). Do not call it for chat, questions, or simple lookups.",
    input_schema: { type: "object", properties: { tier: { type: "string", enum: ["sonnet", "opus"] }, reason: { type: "string" } }, required: ["tier", "reason"] },
  },
];

async function runTool(repo: string, name: string, input: Record<string, string>): Promise<string> {
  try {
    if (name === "list_files") return await listFiles(repo);
    if (name === "read_file") return await readRepoFile(repo, input.path);
    if (name === "write_file") return await writeRepoFile(repo, input.path, input.content);
    return `Unknown tool ${name}`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

async function call(model: string, repo: string, history: AgentMsg[]) {
  const local = localModel.get();
  const isLocal = !!local.url && model === local.model;
  if (!isLocal && !credential.get()) throw new Error("Add your API key first.");
  const res = await fetch(isLocal ? `${local.url}/v1/messages` : "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": isLocal ? "ollama" : credential.get(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model, max_tokens: 4096, system: `You are a coding agent running on a phone, working on the GitHub repository ${repo}. You can read files and write to the phone-work branch.`, tools: TOOLS, messages: history }),
  });
  if (!res.ok) throw new Error(`The ${isLocal ? "local model" : "API"} said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, string> }> };
  // Keep only text and tool calls: thinking blocks from one model are rejected when replayed to another.
  return body.content.filter((c) => c.type === "text" || c.type === "tool_use");
}

// Each turn starts on the cheap chat model (local if set, else Haiku). It answers chat itself and calls `escalate`
// for real work, after which the rest of the turn runs on Sonnet or Opus. Max 15 rounds; `history` is updated in place.
export async function runAgent(repo: string, history: AgentMsg[], onStep: (h: AgentMsg[]) => void): Promise<void> {
  const r = route.get();
  let model = r !== "auto" ? PINNED[r] : localModel.get().url ? localModel.get().model : PINNED.haiku;
  for (let round = 0; round < 15; round++) {
    const content = await call(model, repo, history);
    history.push({ role: "assistant", content });
    onStep([...history]);
    const uses = content.filter((c) => c.type === "tool_use");
    if (!uses.length) return;
    const results = [];
    for (const u of uses) {
      if (u.name === "escalate") {
        const next = HARDER[(u.input?.tier as keyof typeof HARDER) ?? "sonnet"] ?? HARDER.sonnet;
        if (r === "auto" && model !== HARDER.opus) model = next; // never step back down within a turn
        results.push({ type: "tool_result", tool_use_id: u.id, content: `Handed to ${model}. Continue the task.` });
      } else results.push({ type: "tool_result", tool_use_id: u.id, content: await runTool(repo, u.name!, u.input ?? {}) });
    }
    history.push({ role: "user", content: results });
    onStep([...history]);
  }
}
