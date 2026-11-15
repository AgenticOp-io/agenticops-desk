import { execFile } from "node:child_process";
import { generateLocally } from "./localModel";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 8_000, maxBuffer: 1_000_000 }, (_err, stdout, stderr) => {
      const text = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve(/^fatal:/i.test(text) ? "" : text);
    });
  });
}

// What the paid model needs before it starts: git state, and a local summary of it when Ollama is up.
export async function paidPacket(cwd: string, request: string): Promise<string> {
  const [status, stat] = await Promise.all([git(cwd, ["status", "-sb"]), git(cwd, ["diff", "--stat"])]);
  const raw = [status && `status:\n${status}`, stat && `diff:\n${stat}`].filter(Boolean).join("\n").slice(0, 4_000);
  const local = await generateLocally(
    `A coding agent is about to do this. List only what it needs: files to open, what is already changed, and errors. Under 120 words. Do not invent files.\n\nRequest:\n${request.slice(0, 1_500)}\n\nGit:\n${raw || "(no git output)"}`,
    220,
    12_000,
  );
  const body = (local || raw).trim();
  if (!body) return "";
  return `Local findings (trust this; open a file only to change it or if this is incomplete):\n${body}`;
}
