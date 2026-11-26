import { listFiles, readRepoFile, writeRepoFile } from "./github";
import { secret } from "./secrets";

// The phone's own agent: a tool loop that calls the Anthropic Messages API directly with the API key the desk's pairing QR
// sent (Keystore vault). shortcut: replies are not streamed; add streaming if long answers feel slow.
export const credential = { get: () => secret.get("phone.ai") };

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
  if (!credential.get()) throw new Error("The desk sent no API key. Add one on the desk, then scan its code again.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": credential.get(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model, max_tokens: 4096, system: `You are a coding agent running on a phone, working on the GitHub repository ${repo}. You can read files and write to the phone-work branch.`, tools: TOOLS, messages: history }),
  });
  if (!res.ok) throw new Error(`The API said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content: Array<{ type: string; id?: string; name?: string; input?: Record<string, string> }> };
  // Keep only text and tool calls: thinking blocks from one model are rejected when replayed to another.
  return body.content.filter((c) => c.type === "text" || c.type === "tool_use");
}

// Each turn starts on Haiku. It answers chat itself and calls `escalate` for real work, after which the rest of the
// turn runs on Sonnet or Opus. Max 15 rounds; `history` is updated in place.
export async function runAgent(repo: string, history: AgentMsg[], onStep: (h: AgentMsg[]) => void): Promise<void> {
  let model: string = "claude-haiku-5-5";
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
        if (model !== HARDER.opus) model = next; // never step back down within a turn
        results.push({ type: "tool_result", tool_use_id: u.id, content: `Handed to ${model}. Continue the task.` });
      } else results.push({ type: "tool_result", tool_use_id: u.id, content: await runTool(repo, u.name!, u.input ?? {}) });
    }
    history.push({ role: "user", content: results });
    onStep([...history]);
  }
}
