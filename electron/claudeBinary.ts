import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { app, net } from "electron";
import { extractTarGzMember } from "./tarMember";

// Packaged installs do not carry the 270 MB Claude Code binary. The first launch
// downloads the one build that matches this computer, checks npm's SHA-512, and
// keeps it under the app data folder. A source checkout already has it in node_modules.

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

function sdkVersion(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("@anthropic-ai/claude-agent-sdk/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("The Claude Agent SDK package has no version.");
  return pkg.version;
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
    headers: { Accept: "application/json", "User-Agent": "ClaudeDesk" },
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
    res = await net.fetch(url, { headers: { "User-Agent": "ClaudeDesk" }, signal: stall.signal });
  } catch (err) {
    clearTimeout(timer);
    throw stall.signal.aborted ? new Error("The Claude Code download timed out. Check the connection and try again.") : err;
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`The Claude Code download failed (${res.status}).`);
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
          onStatus(pct >= 0 ? `Downloading Claude Code… ${pct}%` : "Downloading Claude Code…");
        }
      }
      cb(null, chunk);
    },
  });
  const web = res.body as unknown as NodeWebStream<Uint8Array>;
  try {
    await pipeline(Readable.fromWeb(web), hasher, createWriteStream(dest));
  } catch (err) {
    throw stall.signal.aborted ? new Error("The Claude Code download stalled. Check the connection and try again.") : err;
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

async function fetchBinary(version: string, target: Target, onStatus?: (text: string) => void): Promise<string> {
  const dir = binaryDir(version, target.id);
  await fs.mkdir(dir, { recursive: true });
  const exe = path.join(dir, target.file);
  const partial = `${exe}.partial`;
  const tgz = path.join(dir, `.download-${process.pid}.tgz`);
  onStatus?.("Downloading Claude Code…");
  try {
    const dist = await registryDist(target.pkg, version);
    const got = await downloadTarball(dist.tarball, tgz, onStatus);
    if (got !== dist.integrity) {
      throw new Error("The Claude Code download did not match npm's fingerprint. Nothing was installed.");
    }
    onStatus?.("Installing Claude Code…");
    await extractTarGzMember(tgz, partial, [`package/${target.file}`, target.file]);
    const st = await fs.stat(partial);
    if (st.size < 1024) throw new Error("The Claude Code download was empty.");
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
        if (!musl) throw new Error(`No Claude Code build is published for ${primary.id}.`);
        const glibc = targetFor(false);
        const glibcSaved = savedClaude(version, glibc);
        if (glibcSaved) return glibcSaved;
        try {
          return await fetchBinary(version, glibc, onStatus);
        } catch (again) {
          if (again instanceof Error && again.message.startsWith("missing:")) {
            throw new Error(`No Claude Code build is published for ${primary.id}.`);
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
