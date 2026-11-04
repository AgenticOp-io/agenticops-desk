import { query } from "@anthropic-ai/claude-agent-sdk";
import { ensureClaudeBinary } from "./claudeBinary";
import { isLocalProvider, privacyMode, restoreIncoming, scrubOutgoing } from "./privacy";
import { directModelOptions, parseDirectModel } from "./providers";
import { stripFence } from "./pureFeatures";
import { askDirect } from "./review";

// Quick edit (Ctrl+I in the editor): rewrite just the selected code from a one-line instruction, with a
// small fast model and no agent run. The renderer applies the result as an undoable edit and the user saves.

export type QuickEditRequest = { file: string; language: string; before: string; selection: string; after: string; instruction: string };

const SYSTEM =
  "You rewrite one selected part of a source file. Reply with only the new code that replaces the selection: " +
  "no explanation, no Markdown fence. Keep the file's style and the selection's indentation. If the instruction " +
  "asks for something that does not fit in the selection, do your best inside it.";

const CONTEXT = 4000;

// Local only: an Ollama model on this computer. Otherwise Claude Haiku through the API key if there is one,
// else Claude Code's Haiku with the user's sign-in.
function pickModel(): string | null {
  const direct = directModelOptions().map((m) => m.value);
  if (privacyMode() === "local") {
    return direct.find((v) => {
      const d = parseDirectModel(v);
      return Boolean(d && isLocalProvider(d.provider));
    }) ?? null;
  }
  return direct.find((v) => v === "direct:anthropic:claude-haiku-5-5") ?? "claude-code";
}

async function askClaudeCode(system: string, user: string): Promise<string> {
  const q = query({
    prompt: user,
    options: {
      model: "haiku",
      systemPrompt: system,
      tools: [],
      maxTurns: 1,
      settingSources: [],
      // No transcript for a one-off edit; chats never get written into the project.
      persistSession: false,
      pathToClaudeCodeExecutable: await ensureClaudeBinary(),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "AgenticOps-Desk" },
    },
  });
  for await (const msg of q) {
    if (msg.type !== "result") continue;
    if (msg.subtype !== "success" || msg.is_error) throw new Error("The quick edit did not finish. Try again.");
    return msg.result;
  }
  throw new Error("The quick edit returned nothing.");
}

export async function quickEdit(req: QuickEditRequest): Promise<{ text: string; model: string }> {
  const instruction = req.instruction.trim();
  if (!instruction) throw new Error("Type what to change.");
  const model = pickModel();
  if (!model) throw new Error("Local only is on, and no Ollama model is set up for quick edits.");
  const clean = (s: string) => scrubOutgoing(s).text;
  const user = [
    `File: ${req.file} (${req.language})`,
    `Code before the selection:\n${clean(req.before.slice(-CONTEXT))}`,
    `SELECTION TO REWRITE:\n${clean(req.selection)}`,
    `Code after the selection:\n${clean(req.after.slice(0, CONTEXT))}`,
    `Instruction: ${clean(instruction)}`,
  ].join("\n\n");
  let text: string;
  let label: string;
  if (model === "claude-code") {
    text = await askClaudeCode(SYSTEM, user);
    label = "Claude Code · Haiku";
  } else {
    const r = await askDirect(model, SYSTEM, user);
    if (!r) throw new Error("The quick edit model is not set up.");
    if (r.refused) throw new Error("The model declined this edit.");
    text = r.text;
    label = r.label;
  }
  // Placeholders go back to the real values on this computer, as for any other edit.
  return { text: restoreIncoming(stripFence(text)), model: label };
}
