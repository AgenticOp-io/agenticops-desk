import { execFile } from "node:child_process";

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
  // shortcut: no local-model summary. It started a llama server on the first message (a freeze) and invented files; restore only with a cap and a check.
  void request;
  if (!raw) return "";
  return `Git state (from the app, not a summary):\n${raw}`;
}
