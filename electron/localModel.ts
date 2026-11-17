import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { pullProviderModels } from "./providers";
import { patchSettings } from "./settings";

// Sets up a local model server (an Ollama already here, else llama.cpp's small server) and a small model for chat summaries, then turns Summaries on. The installer asks for this,
// or Settings › AI models starts it later. Without Ollama, only Windows can set itself up; elsewhere Ollama must already be there.

export const LOCAL_MODEL = "qwen2.5-coder:7b";
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

async function download(url: string, file: string, label: string, say: (t: string) => void) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`The ${label} download returned ${res.status}.`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  let shown = -1;
  const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (c: Buffer) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== shown && pct % 5 === 0) say(`Downloading ${label}… ${(shown = pct)}%`);
  });
  await pipeline(counted, createWriteStream(`${file}.part`));
  await fs.rename(`${file}.part`, file);
}

// Without Ollama, the small llama.cpp server plus one model file are enough. Both live under userData/llama.
const llamaDir = () => path.join(app.getPath("userData"), "llama");
const llamaExe = () => path.join(llamaDir(), "llama-server.exe");
const modelFile = () => path.join(llamaDir(), "model.gguf");
const MODEL_URL = "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf";

async function installLlama(say: (t: string) => void) {
  if (process.platform !== "win32") throw new Error("Install Ollama from ollama.com, then try again.");
  await fs.mkdir(llamaDir(), { recursive: true });
  if (!existsSync(llamaExe())) {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const list = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5", { headers: { "User-Agent": "desk" } });
    if (!list.ok) throw new Error(`GitHub returned ${list.status} when looking up llama.cpp.`);
    const releases = (await list.json()) as Array<{ assets: Array<{ name: string; browser_download_url: string }> }>;
    const asset = releases.flatMap((r) => r.assets).find((a) => new RegExp(`^llama-.*-bin-win-cpu-${arch}\\.zip$`).test(a.name));
    if (!asset) throw new Error("No Windows build of llama.cpp was found.");
    const zip = path.join(llamaDir(), "server.zip");
    await download(asset.browser_download_url, zip, "the local model server", say);
    say("Unpacking the local model server…");
    const r = await runFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", llamaDir()], undefined, 120_000);
    await fs.rm(zip, { force: true });
    if (r.code !== 0 || !existsSync(llamaExe())) throw new Error(`Unpacking the local model server failed. ${r.out}`);
  }
  if (!existsSync(modelFile())) await download(MODEL_URL, modelFile(), LOCAL_MODEL, say);
}

function startLlama() {
  const child = spawn(llamaExe(), ["-m", modelFile(), "--alias", LOCAL_MODEL, "--host", "127.0.0.1", "--port", "11434", "-c", "8192"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${API}/v1/models`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function startServer(exe: string | null) {
  if (await serverUp()) return;
  if (exe) {
    const child = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } else startLlama();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverUp()) return;
  }
  throw new Error("The local model server did not start.");
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
      say("Looking for a local model server…");
      const exe = ollamaExe();
      if (!exe && !(await serverUp())) await installLlama(say);
      say("Starting the local model server…");
      await startServer(exe);
      if (exe) await pullModel(say);
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
export async function generateLocally(prompt: string, maxTokens = 400, timeoutMs = 30_000): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    if (!(await serverUp())) {
      if (!existsSync(llamaExe()) || !existsSync(modelFile())) return null;
      await startServer(null);
    }
    const res = await fetch(`${API}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LOCAL_MODEL, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: maxTokens, temperature: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
