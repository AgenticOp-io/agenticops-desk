import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { llamaServerArgs, localServerThreads, openAiListsModel } from "./pureFeatures";
import { pullProviderModels } from "./providers";
import { patchSettings } from "./settings";

// Sets up llama.cpp's small server and a small model (pulled from Ollama's public registry over plain HTTP, no Ollama install) for chat summaries, then turns Summaries on.
// The installer asks for this, or Settings › AI models starts it later. 64-bit Windows, macOS and Linux (x64 and arm64) are supported.

export const LOCAL_MODEL = "qwen2.5-coder:7b";
const API = "http://127.0.0.1:11434";

export type LocalModelStatus = { running: boolean; text: string; ok?: boolean };
let status: LocalModelStatus = { running: false, text: "" };
let job: Promise<LocalModelStatus> | null = null;

export const localModelStatus = () => status;

function runFile(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 15 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

// Returns the sha256 of the bytes written, computed as they arrive.
async function download(url: string, file: string, label: string, say: (t: string) => void): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`The ${label} download returned ${res.status}.`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  let got = 0;
  let shown = -1;
  const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).on("data", (c: Buffer) => {
    hash.update(c);
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== shown && pct % 5 === 0) say(`Downloading ${label}… ${(shown = pct)}%`);
  });
  await pipeline(counted, createWriteStream(`${file}.part`));
  await fs.rename(`${file}.part`, file);
  return hash.digest("hex");
}

// The small llama.cpp server plus one model file are enough. Both live under userData/llama.
const llamaDir = () => path.join(app.getPath("userData"), "llama");
const serverDir = () => path.join(llamaDir(), "server");
const modelFile = () => path.join(llamaDir(), "model.gguf");
const EXE_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server";

// The archives differ in layout (flat on Windows, one folder on macOS/Linux), so look for the binary.
function llamaExe(): string | null {
  try {
    const hit = readdirSync(serverDir(), { recursive: true }).find((f) => path.basename(String(f)) === EXE_NAME);
    return hit ? path.join(serverDir(), String(hit)) : null;
  } catch {
    return null;
  }
}

// Plain HTTP against Ollama's registry: the manifest lists layers, and the model layer is the GGUF with its sha256.
async function pullFromRegistry(say: (t: string) => void) {
  const [name, tag] = LOCAL_MODEL.split(":");
  const base = `https://registry.ollama.ai/v2/library/${name}`;
  const res = await fetch(`${base}/manifests/${tag}`, { headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" } });
  if (!res.ok) throw new Error(`The model registry returned ${res.status} for ${LOCAL_MODEL}.`);
  const layers = ((await res.json()) as { layers?: Array<{ mediaType: string; digest: string }> }).layers ?? [];
  const layer = layers.find((l) => l.mediaType === "application/vnd.ollama.image.model");
  if (!layer || !/^sha256:[0-9a-f]{64}$/.test(layer.digest)) throw new Error(`The model registry has no model file for ${LOCAL_MODEL}.`);
  const dest = modelFile();
  const got = await download(`${base}/blobs/${layer.digest}`, dest, LOCAL_MODEL, say);
  if (`sha256:${got}` !== layer.digest) {
    await fs.rm(dest, { force: true });
    throw new Error("The downloaded model did not match its published checksum.");
  }
}

async function installLlama(say: (t: string) => void) {
  if ((process.arch !== "x64" && process.arch !== "arm64") || !["win32", "darwin", "linux"].includes(process.platform)) {
    throw new Error("The local model needs 64-bit Windows, macOS or Linux.");
  }
  await fs.mkdir(llamaDir(), { recursive: true });
  if (!llamaExe()) {
    const key = { win32: "win-cpu", darwin: "macos", linux: "ubuntu" }[process.platform as "win32" | "darwin" | "linux"];
    const ext = process.platform === "win32" ? "zip" : "tar.gz";
    const list = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5", { headers: { "User-Agent": "desk" } });
    if (!list.ok) throw new Error(`GitHub returned ${list.status} when looking up llama.cpp.`);
    const releases = (await list.json()) as Array<{ assets: Array<{ name: string; browser_download_url: string; digest?: string }> }>;
    // Anchored so GPU builds (ubuntu-vulkan-x64, cuda…) do not match; only the plain CPU build does.
    const asset = releases.flatMap((r) => r.assets).find((a) => new RegExp(`^llama-[^-]+-bin-${key}-${process.arch}\\.${ext.replace(".", "\\.")}$`).test(a.name));
    if (!asset) throw new Error(`No ${process.platform} ${process.arch} build of llama.cpp was found.`);
    const archive = path.join(llamaDir(), `server.${ext}`);
    const got = await download(asset.browser_download_url, archive, "the local model server", say);
    // GitHub publishes a sha256 per asset; refuse an archive that does not match it.
    const want = asset.digest?.replace(/^sha256:/, "");
    if (!want || want !== got) {
      await fs.rm(archive, { force: true });
      throw new Error("The downloaded local model server did not match its published checksum.");
    }
    say("Unpacking the local model server…");
    await fs.rm(serverDir(), { recursive: true, force: true });
    await fs.mkdir(serverDir(), { recursive: true });
    // Windows 10+ ships tar.exe, which reads zip too.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const r = await runFile(tar, ["-xf", archive, "-C", serverDir()], undefined, 120_000);
    await fs.rm(archive, { force: true });
    const exe = llamaExe();
    if (r.code !== 0 || !exe) throw new Error(`Unpacking the local model server failed. ${r.out}`);
    if (process.platform !== "win32") await fs.chmod(exe, 0o755);
  }
  if (!existsSync(modelFile())) await pullFromRegistry(say);
}

// Not detached: it dies with the app, so the ~5 GB model never lingers after quit.
let llamaChild: ChildProcess | null = null;

function stopLlama() {
  const child = llamaChild;
  if (!child) return;
  llamaChild = null;
  child.kill();
}

app.on("before-quit", () => stopLlama());

function startLlama() {
  stopLlama();
  const exe = llamaExe();
  if (!exe) throw new Error("The local model server is not installed.");
  // All cores at normal priority, plus OpenMP spinning, makes the window stop answering while the model loads.
  const threads = localServerThreads(os.availableParallelism?.() ?? os.cpus().length);
  const child = spawn(exe, llamaServerArgs(modelFile(), LOCAL_MODEL, threads), {
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      // The shared libraries sit next to the binary; Linux needs to be told.
      LD_LIBRARY_PATH: [path.dirname(exe), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      OMP_WAIT_POLICY: "PASSIVE",
      OMP_NUM_THREADS: String(threads),
    },
  });
  llamaChild = child;
  child.on("error", () => {});
  child.on("exit", () => {
    if (llamaChild === child) llamaChild = null;
  });
  return child;
}

// "ready" lists our model. "other" is some other program on the port. "down" means nothing is listening.
async function probePort(): Promise<"ready" | "other" | "down"> {
  try {
    const res = await fetch(`${API}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return "other";
    return openAiListsModel(await res.json(), LOCAL_MODEL) ? "ready" : "other";
  } catch {
    return "down";
  }
}

// Callers share one start, so a slow model load is not spawned again by every caller.
let starting: Promise<void> | null = null;
function startServer(): Promise<void> {
  return (starting ??= startServerOnce().finally(() => (starting = null)));
}

async function startServerOnce() {
  const now = await probePort();
  if (now === "ready") return;
  if (now === "other") {
    throw new Error(`Port 11434 is in use, but it is not serving ${LOCAL_MODEL}. Stop the other program using that port, then try again.`);
  }
  const child = startLlama();
  let died = false;
  const markDead = () => {
    died = true;
  };
  child.on("exit", markDead);
  child.on("error", markDead);
  // A cold load of the model file can take well over half a minute. Killing it early just starts the load again.
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (died) break;
    if ((await probePort()) === "ready") return;
  }
  stopLlama();
  throw new Error("The local model server did not start.");
}

// One setup at a time; a second call joins the first.
export function setupLocalModel(onStatus: (s: LocalModelStatus) => void): Promise<LocalModelStatus> {
  if (job) return job;
  const say = (text: string) => onStatus((status = { running: true, text }));
  job = (async () => {
    try {
      say("Looking for a local model server…");
      // Always install our own server, even if something else answers on the port: it would not have this model.
      await installLlama(say);
      say("Starting the local model server…");
      await startServer();
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
// does it mean"). Returns null when the local server or model is not installed, so the caller falls back to the
// cloud agent instead of blocking. Nothing leaves this computer: the model is local and the prompt is local.
export async function generateLocally(prompt: string, maxTokens = 400, timeoutMs = 30_000): Promise<string | null> {
  if (!prompt.trim()) return null;
  try {
    const now = await probePort();
    if (now !== "ready") {
      if (now === "other" || !llamaExe() || !existsSync(modelFile())) return null;
      // A chat must not sit inside the model load. The server keeps starting; the next call uses it.
      void startServer().catch(() => undefined);
      return null;
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
