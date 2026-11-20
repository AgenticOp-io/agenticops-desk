import { run } from "./features";
import { generateLocally } from "./localModel";
import { readOnlyOpsCommand } from "./pureFeatures";
import { app } from "electron";

// Cheap operational triage: run ONE read-only status command and, when the local model is up, hand its output
// to the local Ollama model for a short "what happened / what does it mean" summary. This is the cheap/free path
// for git and GitHub Actions status busywork that should never be re-queried on an expensive cloud model.
//
// It runs without a permission prompt, so readOnlyOpsCommand (pureFeatures.ts) refuses anything that could change
// a repository or account, or read outside the repository.

export type OpsResult = { ok: boolean; command: string; summary: string | null; raw: string };

// cwd is the chat's folder, so git describes that project. Without one (the Settings button) it runs in the home folder.
export async function opsTriage(command: string, cwd?: string): Promise<OpsResult> {
  const cmd = command.trim();
  const args = readOnlyOpsCommand(cmd);
  if (!args) return { ok: false, command: cmd, summary: null, raw: "Only read-only git and gh status commands are allowed." };
  const [bin, ...rest] = args;
  const got = await run(bin, rest, cwd || app.getPath("home"), 60_000);
  if (!got.ok && !got.output) return { ok: false, command: cmd, summary: null, raw: "The command produced no output (it may not be installed or signed in)." };
  const raw = got.output.slice(-6000);
  const summary = await generateLocally(
    `You are triaging the output of a read-only operational command on the user's machine. Command: ${cmd}\n\nOutput:\n${raw}\n\nAnswer in 1-3 plain sentences: what does this show, and is there an error or failure the user should act on?`,
    300,
  );
  return { ok: got.ok, command: cmd, summary, raw };
}
