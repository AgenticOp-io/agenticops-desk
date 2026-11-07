import { createHash, verify } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { downloadReleaseAssets, run } from "./features";
import { writeJsonAtomic } from "./jsonStore";
import { isNewerVersion, isReleaseTag, oneAtATime, patchRefusal, patchShell, type PatchManifest } from "./pureFeatures";
import { extractTarGzMember } from "./tarMember";

// Code updates without a full install. A patch is built in its own folder under resources/app/patches and checked
// file by file; one rename of patches/current.json then switches to it, and boot/boot.mjs loads it on the next start.
// A patch never touches the folder the running code came from.
// shortcut: Windows setup installs only; a portable copy is unpacked afresh each run, and macOS and Linux installs are not writable by the user.

const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi09l5MtKjPKBp8nezRTjG5TDWlJdLDUuQ5thtKYsUqE=\n-----END PUBLIC KEY-----\n";
const REPO = "AgenticOp-io/agenticops-desk";

type PatchState = { version: string | null; previous?: string | null; trial?: boolean; tried?: boolean; bad?: string[] };
export type PatchResult = { ready: boolean; note: string };

const patchesDir = () => path.join(app.getAppPath(), "patches");
const stateFile = () => path.join(patchesDir(), "current.json");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function canPatch() {
  return app.isPackaged && process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR;
}

async function readState(): Promise<PatchState> {
  try {
    return JSON.parse(await fs.readFile(stateFile(), "utf8")) as PatchState;
  } catch {
    return { version: null };
  }
}

function readyNote(version: string): PatchResult {
  return { ready: true, note: `Update ${version} is ready. It loads the next time the app starts.` };
}

const PATCH_FILES = ["patch-manifest.json", "patch-manifest.sig", "patch.tar.gz"];

// The GitHub CLI sign-in downloads the patch.
async function fetchPatch(tag: string): Promise<string | null> {
  // Tests point at a local folder. Whatever is in it still has to pass the signature check.
  if (process.env.AGENTICOPS_DESK_PATCH_FROM) return process.env.AGENTICOPS_DESK_PATCH_FROM;
  if (!isReleaseTag(tag)) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-patch-"));
  if (await downloadReleaseAssets(tag, dir, PATCH_FILES)) return dir;
  const args = ["release", "download", tag, "--repo", REPO, "--dir", dir, ...PATCH_FILES.flatMap((name) => ["-p", name])];
  const got = await run("gh", args, app.getPath("home"), 300_000);
  if (got.ok) return dir;
  await fs.rm(dir, { recursive: true, force: true });
  return null;
}

async function applyPatch(source: string, state: PatchState, current: string): Promise<PatchResult> {
  const fullInstall = (why: string) => ({ ready: false, note: `${why} This update needs the full installer.` });
  const bytes = await fs.readFile(path.join(source, "patch-manifest.json"));
  const signature = Buffer.from(await fs.readFile(path.join(source, "patch-manifest.sig"), "utf8"), "base64");
  if (!verify(null, bytes, PUBLIC_KEY, signature)) return fullInstall("The update's signature is not valid.");
  const manifest = JSON.parse(bytes.toString("utf8")) as PatchManifest;

  const root = app.getAppPath();
  const installed = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const refusal = patchRefusal(manifest, { current, shell: patchShell(process.versions.electron, installed.dependencies ?? {}), bad: state.bad ?? [] });
  if (refusal) return fullInstall(refusal);
  const tar = path.join(source, "patch.tar.gz");
  if (sha256(await fs.readFile(tar)) !== manifest.tar) return fullInstall("The update download is damaged.");

  const from = state.version ? path.join(patchesDir(), state.version) : root;
  const dest = path.join(patchesDir(), manifest.version);
  const building = `${dest}.new`;
  await fs.rm(building, { recursive: true, force: true });
  let downloaded = 0;
  for (const file of manifest.files) {
    const target = path.join(building, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const have = await fs.readFile(path.join(from, file.path)).catch(() => null);
    if (have && sha256(have) === file.sha256) await fs.writeFile(target, have);
    else {
      await extractTarGzMember(tar, target, [file.path, `./${file.path}`]);
      downloaded += 1;
    }
    if (sha256(await fs.readFile(target)) !== file.sha256) return fullInstall(`The update file ${file.path} is damaged.`);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.rename(building, dest);
  await writeJsonAtomic(stateFile(), {
    version: manifest.version,
    // A patch still waiting for a restart never ran, so what to fall back to stays the last one that did.
    previous: state.trial ? state.previous ?? null : state.version,
    trial: true,
    tried: false,
    bad: state.bad ?? [],
  } satisfies PatchState);
  console.log(`AgenticOps Desk patch ${manifest.version}: ${downloaded} changed of ${manifest.files.length} files`);
  return readyNote(manifest.version);
}

const lastTag: { value: string | null } = { value: null };
const runUpdate = oneAtATime(async (): Promise<PatchResult> => {
  const tag = lastTag.value;
  const state = await readState();
  const current = state.version ?? app.getVersion();
  if (state.trial && !state.tried) return readyNote(current);
  if (!process.env.AGENTICOPS_DESK_PATCH_FROM && !(tag && isNewerVersion(tag, current))) return { ready: false, note: "" };
  const source = await fetchPatch(tag ?? "");
  if (!source) return { ready: false, note: `${tag} is out. It came without a code update, so it needs the full installer.` };
  try {
    return await applyPatch(source, state, current);
  } finally {
    if (source !== process.env.AGENTICOPS_DESK_PATCH_FROM) await fs.rm(source, { recursive: true, force: true }).catch(() => {});
  }
});

// Installs the release's patch if there is one and this copy can take it. latest is the newest release tag.
export async function updateCode(latest: string | null): Promise<PatchResult> {
  if (!canPatch()) return { ready: false, note: "" };
  lastTag.value = latest;
  try {
    return await runUpdate();
  } catch (err) {
    return { ready: false, note: `The update could not be installed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// The window came up, so the patch works. Older patch folders are removed here, never ones that may still be in use.
export async function confirmPatch() {
  if (!canPatch() || !existsSync(stateFile())) return;
  const state = await readState();
  if (state.trial && state.tried) await writeJsonAtomic(stateFile(), { ...state, trial: false, tried: false });
  const keep = new Set([state.version, state.previous, app.getVersion(), "current.json"]);
  for (const name of await fs.readdir(patchesDir())) {
    if (!keep.has(name)) await fs.rm(path.join(patchesDir(), name), { recursive: true, force: true }).catch(() => {});
  }
}
