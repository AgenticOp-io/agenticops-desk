import { run } from "./features";
import { generateLocally } from "./localModel";
import { app } from "electron";

// Cheap operational triage: run ONE read-only status command and, when the local model is up, hand its output
// to the local Ollama model for a short "what happened / what does it mean" summary. This is the cheap/free path
// for git and GitHub Actions status busywork that should never be re-queried on an expensive cloud model.
//
// Only read-only commands are allowed: git status/log/show, and gh status/run list/run view. Anything else is
// refused, so this path can never mutate a repo or account.

const READ_ONLY = [
  /^git\s+(?:status|log|show|rev-parse|remote\s+-v|branch|diff|stash\s+list)\b/i,
  /^gh\s+(?:status|auth\s+status|run\s+list|run\s+view|release\s+list|api\s+repos?\/[^/]+\/[^/]+\/actions\/runs)\b/i,
];

function allowed(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || cmd.length > 400) return false;
  if (/[;&|`<>]/.test(cmd)) return false;
  const [bin, ...rest] = cmd.split(/\s+/);
  if (bin.toLowerCase() !== "git" && bin.toLowerCase() !== "gh") return false;
  if (rest.some((a) => /^[^a-zA-Z0-9._\/-]/.test(a) && a !== "-")) return false;
  return READ_ONLY.some((re) => re.test(cmd));
}

export type OpsResult = { ok: boolean; command: string; summary: string | null; raw: string };

export async function opsTriage(command: string): Promise<OpsResult> {
  const cmd = command.trim();
  if (!allowed(cmd)) return { ok: false, command: cmd, summary: null, raw: "Only read-only git and gh status commands are allowed." };
  const [bin, ...args] = cmd.split(/\s+/);
  const got = await run(bin, args, app.getPath("home"), 60_000);
  if (!got.ok && !got.output) return { ok: false, command: cmd, summary: null, raw: "The command produced no output (it may not be installed or signed in)." };
  const raw = got.output.slice(-6000);
  const summary = await generateLocally(
    `You are triaging the output of a read-only operational command on the user's machine. Command: ${cmd}\n\nOutput:\n${raw}\n\nAnswer in 1-3 plain sentences: what does this show, and is there an error or failure the user should act on?`,
    300,
  );
  return { ok: got.ok, command: cmd, summary, raw };
}
