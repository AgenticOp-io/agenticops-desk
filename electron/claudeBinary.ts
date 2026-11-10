import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { app, net } from "electron";
import { extractTarGzMember } from "./tarMember";

// Packaged installs carry neither the agent SDK nor the 270 MB Claude Code binary. The first chat
// downloads the matching builds from npm, checks npm's SHA-512, and keeps them under the app data
// folder. A source checkout already has both in node_modules.

type Target = { id: string; pkg: string; file: string };

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header && !report.header.glibcVersionRuntime) return true;
  } catch {
    /* fall through to the loader names */
  }
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

function targetFor(musl: boolean): Target {
  const file = process.platform === "win32" ? "claude.exe" : "claude";
  const id = `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
  return { id, pkg: `@anthropic-ai/claude-agent-sdk-${id}`, file };
}

// The SDK version this build was compiled against (vite.config.ts reads it from node_modules). The binary
// and the downloaded SDK must both match it.
declare const __AGENT_SDK_VERSION__: string;
const SDK_PKG = "@anthropic-ai/claude-agent-sdk";

function sdkVersion(): string {
  return __AGENT_SDK_VERSION__;
}

// The binary shipped next to the SDK when this checkout was installed. Source runs use it and skip the download.
function moduleClaude(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const target = targetFor(isMusl());
    const pkg = req.resolve(`${target.pkg}/package.json`);
    const exe = path.join(path.dirname(pkg), target.file);
    const unpacked = exe.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (existsSync(unpacked)) return unpacked;
    if (existsSync(exe)) return exe;
  } catch {
    /* this platform's package is not installed, which is normal for a packaged app */
  }
  return null;
}

function binaryDir(version: string, id: string) {
  return path.join(app.getPath("userData"), "claude-code", version, id);
}

function savedClaude(version: string, target: Target): string | null {
  const exe = path.join(binaryDir(version, target.id), target.file);
  const mark = `${exe}.sha512`;
  if (existsSync(exe) && existsSync(mark)) return exe;
  return null;
}

type Dist = { tarball: string; integrity: string };

// Give up instead of waiting forever: every Claude Code chat waits on this one download.
const META_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 60_000;

async function registryDist(pkg: string, version: string): Promise<Dist> {
  const url = `https://registry.npmjs.org/${pkg}/${version}`;
  const res = await net.fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "AgenticOps-Desk" },
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  });
  if (res.status === 404) throw new Error(`missing:${pkg}`);
  if (!res.ok) throw new Error(`npm returned ${res.status} for ${pkg}.`);
  const body = (await res.json()) as { dist?: { tarball?: string; integrity?: string } };
  const tarball = body.dist?.tarball;
  const integrity = body.dist?.integrity;
  if (!tarball || !integrity?.startsWith("sha512-")) {
    throw new Error(`npm did not publish a SHA-512 fingerprint for ${pkg}.`);
  }
  return { tarball, integrity };
}

async function downloadTarball(url: string, dest: string, onStatus?: (text: string) => void): Promise<string> {
  // Abort when no bytes arrive for a minute, so a dead connection fails instead of hanging.
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
  };
  let res: Response;
  try {
    res = await net.fetch(url, { headers: { "User-Agent": "AgenticOps-Desk" }, signal: stall.signal });
  } catch (err) {
    clearTimeout(timer);
    throw stall.signal.aborted ? new Error("The agent engine download timed out. Check the connection and try again.") : err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`The agent engine download failed (${res.status}).`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  const hash = createHash("sha512");
  let received = 0;
  let lastPct = -1;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      touch();
      hash.update(chunk);
      received += chunk.length;
      if (onStatus) {
        const pct = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          onStatus(pct >= 0 ? `Downloading the agent engine… ${pct}%` : "Downloading the agent engine…");
        }
      }
      cb(null, chunk);
    },
  });
  const web = res.body as unknown as NodeWebStream<Uint8Array>;
  try {
    await pipeline(Readable.fromWeb(web), hasher, createWriteStream(dest));
  } catch (err) {
    throw stall.signal.aborted ? new Error("The agent engine download stalled. Check the connection and try again.") : err;
  } finally {
    clearTimeout(timer);
  }
  return `sha512-${hash.digest("base64")}`;
}

// Each SDK update downloads a new 270 MB binary; drop the versions nothing uses anymore.
async function removeOldVersions(keep: string) {
  const root = path.join(app.getPath("userData"), "claude-code");
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

function fetchBinary(version: string, target: Target, onStatus?: (text: string) => void): Promise<string> {
  return fetchMember(target.pkg, version, binaryDir(version, target.id), target.file, onStatus);
}

// Downloads one npm package at an exact version, checks npm's SHA-512, and keeps one file from it in dir.
async function fetchMember(pkg: string, version: string, dir: string, file: string, onStatus?: (text: string) => void): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const exe = path.join(dir, file);
  const partial = `${exe}.partial`;
  const tgz = path.join(dir, `.download-${process.pid}.tgz`);
  onStatus?.("Downloading the agent engine…");
  try {
    const dist = await registryDist(pkg, version);
    const got = await downloadTarball(dist.tarball, tgz, onStatus);
    if (got !== dist.integrity) {
      throw new Error("The agent engine download did not match npm's fingerprint. Nothing was installed.");
    }
    onStatus?.("Installing the agent engine…");
    await extractTarGzMember(tgz, partial, [`package/${file}`, file]);
    const st = await fs.stat(partial);
    if (st.size < 1024) throw new Error("The agent engine download was empty.");
    await fs.rename(partial, exe);
    if (process.platform !== "win32") await fs.chmod(exe, 0o755);
    await fs.writeFile(`${exe}.sha512`, dist.integrity, "utf8");
    await removeOldVersions(version);
    return exe;
  } finally {
    await fs.rm(tgz, { force: true }).catch(() => {});
    await fs.rm(partial, { force: true }).catch(() => {});
  }
}

type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdkLoad: Promise<AgentSdk> | null = null;

// The agent SDK is Anthropic's and is not ours to redistribute, so installers do not carry it. A source checkout
// loads it from node_modules; a packaged app downloads sdk.mjs at the exact version it was built against.
// sdk.mjs imports only Node built-ins, so it runs on its own from the app data folder.
export function loadAgentSdk(onStatus?: (text: string) => void): Promise<AgentSdk> {
  sdkLoad ??= (async () => {
    try {
      return (await import("@anthropic-ai/claude-agent-sdk")) as AgentSdk;
    } catch {
      /* not in node_modules: a packaged app */
    }
    const version = sdkVersion();
    const dir = path.join(app.getPath("userData"), "claude-code", version, "sdk");
    const file = path.join(dir, "sdk.mjs");
    if (!existsSync(file) || !existsSync(`${file}.sha512`)) await fetchMember(SDK_PKG, version, dir, "sdk.mjs", onStatus);
    return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as AgentSdk;
  })().catch((err) => {
    sdkLoad = null;
    throw err;
  });
  return sdkLoad;
}

let inflight: Promise<string> | null = null;

// The Claude Code binary for this machine: the one in node_modules, or the copy kept in app data.
// Downloads at most once, and only when neither is already there.
export function ensureClaudeBinary(onStatus?: (text: string) => void): Promise<string> {
  const local = moduleClaude();
  if (local) return Promise.resolve(local);
  if (!inflight) {
    inflight = (async () => {
      const version = sdkVersion();
      const musl = isMusl();
      const primary = targetFor(musl);
      const saved = savedClaude(version, primary);
      if (saved) return saved;
      try {
        return await fetchBinary(version, primary, onStatus);
      } catch (err) {
        const missing = err instanceof Error && err.message.startsWith("missing:");
        if (!missing) throw err;
        if (!musl) throw new Error(`No agent engine build is published for ${primary.id}.`);
        const glibc = targetFor(false);
        const glibcSaved = savedClaude(version, glibc);
        if (glibcSaved) return glibcSaved;
        try {
          return await fetchBinary(version, glibc, onStatus);
        } catch (again) {
          if (again instanceof Error && again.message.startsWith("missing:")) {
            throw new Error(`No agent engine build is published for ${primary.id}.`);
          }
          throw again;
        }
      }
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
