import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { pullProviderModels } from "./providers";
import { patchSettings } from "./settings";

// Installs Ollama and a small model for chat summaries, then turns Summaries on. The installer asks for this,
// or Settings › AI models starts it later. Windows only installs Ollama; elsewhere it must already be there.

export const LOCAL_MODEL = "qwen2.5-coder:7b";
const SETUP_URL = "https://ollama.com/download/OllamaSetup.exe";
const API = "http://127.0.0.1:11434";

export type LocalModelStatus = { running: boolean; text: string; ok?: boolean };
let status: LocalModelStatus = { running: false, text: "" };
let job: Promise<LocalModelStatus> | null = null;

export const localModelStatus = () => status;

function ollamaExe(): string | null {
  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe")]
      : ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function runFile(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 15 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

// The downloaded installer only runs if Windows says Ollama signed it.
async function signedByOllama(file: string): Promise<boolean> {
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = await runFile(
    ps,
    ["-NoProfile", "-NonInteractive", "-Command", "$s = Get-AuthenticodeSignature -LiteralPath $env:DESK_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""],
    { DESK_FILE: file },
    60_000,
  );
  const [state, subject = ""] = r.out.split("|");
  return state === "Valid" && /(^|, )O=Ollama Inc\.,/.test(subject);
}

async function installOllama(say: (t: string) => void): Promise<string> {
  if (process.platform !== "win32") throw new Error("Install Ollama from ollama.com, then try again.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-ollama-"));
  try {
    const file = path.join(dir, "OllamaSetup.exe");
    const res = await fetch(SETUP_URL, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`The Ollama download returned ${res.status}.`);
    const total = Number(res.headers.get("content-length")) || 0;
    let got = 0;
    let shown = -1;
    const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (c: Buffer) => {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== shown && pct % 5 === 0) say(`Downloading Ollama… ${(shown = pct)}%`);
    });
    await pipeline(counted, createWriteStream(file));
    say("Checking the Ollama installer's signature…");
    if (!(await signedByOllama(file))) throw new Error("The Ollama installer was not signed by Ollama, so it was not run.");
    say("Installing Ollama…");
    const r = await runFile(file, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
    if (r.code !== 0) throw new Error(`The Ollama installer stopped with code ${r.code}.`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  const exe = ollamaExe();
  if (!exe) throw new Error("Ollama installed, but ollama.exe was not found.");
  return exe;
}

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${API}/api/version`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function startServer(exe: string) {
  if (await serverUp()) return;
  const child = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverUp()) return;
  }
  throw new Error("Ollama did not start.");
}

async function pullModel(say: (t: string) => void) {
  const res = await fetch(`${API}/api/pull`, { method: "POST", body: JSON.stringify({ model: LOCAL_MODEL, stream: true }) });
  if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status} when downloading the model.`);
  const decoder = new TextDecoder();
  let buf = "";
  let shown = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { status?: string; error?: string; total?: number; completed?: number };
      if (m.error) throw new Error(`Ollama could not download ${LOCAL_MODEL}: ${m.error}`);
      const text = m.total && m.completed ? `Downloading ${LOCAL_MODEL}… ${Math.floor((m.completed / m.total) * 100)}%` : `${LOCAL_MODEL}: ${m.status ?? ""}`;
      if (text !== shown) say((shown = text));
      if (m.status === "success") return;
    }
  }
  throw new Error(`The download of ${LOCAL_MODEL} stopped before it finished.`);
}

// One setup at a time; a second call joins the first.
export function setupLocalModel(onStatus: (s: LocalModelStatus) => void): Promise<LocalModelStatus> {
  if (job) return job;
  const say = (text: string) => onStatus((status = { running: true, text }));
  job = (async () => {
    try {
      say("Looking for Ollama…");
      const exe = ollamaExe() ?? (await installOllama(say));
      say("Starting Ollama…");
      await startServer(exe);
      await pullModel(say);
      await pullProviderModels("ollama");
      await patchSettings({ summarizer: `direct:ollama:${LOCAL_MODEL}` });
      status = { running: false, ok: true, text: `${LOCAL_MODEL} is ready and writes the summaries.` };
    } catch (err) {
      status = { running: false, ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    onStatus(status);
    job = null;
    return status;
  })();
  return job;
}

// The installer's "set up a local model" box leaves this file; the first normal start runs the setup.
export const pendingSetupFile = () => path.join(app.getPath("userData"), "local-model-setup.json");

// One-shot, cheap local completion for operational triage (git/gh status, log reads, "what failed and what
// does it mean"). Returns null when Ollama or the model is not available, so the caller falls back to the
// cloud agent instead of blocking. Nothing leaves this computer: the model is local and the prompt is local.
export async function generateLocally(prompt: string, maxTokens = 400): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    if (!(await serverUp())) return null;
    const res = await fetch(`${API}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LOCAL_MODEL, prompt, stream: false, options: { num_predict: maxTokens, temperature: 0 } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return typeof data.response === "string" && data.response.trim() ? data.response.trim() : null;
  } catch {
    return null;
  }
}
