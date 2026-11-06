import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { cursorHome, cursorUserDir, listTranscripts, readCursorChat, searchIndexText } from "./cursor";
import { cursorRunning } from "./cursorLink";
import { writeJsonAtomic } from "./jsonStore";
import { importCursorLibrary, loadThread, rememberedChats, saveThread } from "./library";
import { cursorRemovalRefusal } from "./pureFeatures";
import { loadSettings, patchSettings } from "./settings";

// Copies Cursor's projects, chats and agent files into the desk's own storage and never changes Cursor's.
// After this the desk needs nothing of Cursor's, which is what makes deleting it (opt-in, below) safe.

export type ConvertReport = { chats: number; converted: number; recovered: number; already: number; empty: number; errors: string[] };

const RECOVERED_NOTE = "Recovered from Cursor's search index. The original chat was lost, so this is only what you typed, run together, without the agent's answers.";

const markerFile = () => path.join(app.getPath("userData"), "cursor-converted.json");
const archiveDir = () => path.join(app.getPath("userData"), "cursor-archive");

export async function readConvertReport(): Promise<ConvertReport | null> {
  try {
    return JSON.parse(await fs.readFile(markerFile(), "utf8")) as ConvertReport;
  } catch {
    return null;
  }
}

// The raw files keep what a chat thread does not: tool calls, subagents, canvases, pasted images, plans.
async function archiveCursorFiles(errors: string[]) {
  const copy = async (from: string, to: string) => {
    if (!existsSync(from)) return;
    try {
      await fs.cp(from, path.join(archiveDir(), to), { recursive: true, force: true });
    } catch (err) {
      errors.push(`${from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const projects = path.join(cursorHome(), "projects");
  const slugs = await fs.readdir(projects).catch(() => [] as string[]);
  for (const slug of slugs) {
    for (const part of ["agent-transcripts", "canvases", "assets"]) await copy(path.join(projects, slug, part), path.join("projects", slug, part));
  }
  for (const part of ["plans", "agents", "rules", "skills", "commands", "mcp.json"]) await copy(path.join(cursorHome(), part), part);
  for (const part of ["settings.json", "keybindings.json", "snippets"]) await copy(path.join(cursorUserDir(), part), path.join("user", part));
}

// Safe to run again: a chat the desk already holds is left alone, so nothing said here is ever overwritten.
export async function convertCursorChats(): Promise<ConvertReport> {
  const report: ConvertReport = { chats: 0, converted: 0, recovered: 0, already: 0, empty: 0, errors: [] };
  await importCursorLibrary();
  const slugOf = new Map((await listTranscripts()).map((t) => [t.id, t.slug]));
  for (const chat of await rememberedChats()) {
    report.chats += 1;
    try {
      if ((await loadThread(chat.id))?.length) {
        report.already += 1;
        continue;
      }
      const detail = await readCursorChat(slugOf.get(chat.id) ?? chat.slug, chat.id, true);
      if (detail?.messages.length) {
        await saveThread(chat.id, detail.messages);
        report.converted += 1;
        continue;
      }
      const typed = await searchIndexText(chat.id);
      if (typed) {
        await saveThread(chat.id, [{ role: "system", text: RECOVERED_NOTE }, { role: "user", text: typed }]);
        report.recovered += 1;
      } else report.empty += 1;
    } catch (err) {
      report.errors.push(`${chat.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await archiveCursorFiles(report.errors);
  // Left unmarked when anything failed, so the next start tries again.
  if (!report.errors.length) await writeJsonAtomic(markerFile(), report);
  return report;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(child);
    else if (entry.isFile()) total += (await fs.stat(child).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// Cursor's own data only: never a project folder. Worktrees hold real code, so they stay.
async function removalTargets() {
  const home = cursorHome();
  const keep = path.join(home, "worktrees");
  const children = await fs.readdir(home).catch(() => [] as string[]);
  const inHome = children.map((name) => path.join(home, name)).filter((p) => p !== keep);
  const appData = path.dirname(cursorUserDir());
  return { paths: [...inHome, ...(existsSync(appData) ? [appData] : [])], home, appData, keep: existsSync(keep) ? keep : null };
}

export async function reviewCursorRemoval() {
  const { paths, home, appData, keep } = await removalTargets();
  const report = await readConvertReport();
  const bytes = async (p: string) => ((await fs.stat(p).catch(() => null))?.isDirectory() ? folderBytes(p) : (await fs.stat(p).catch(() => ({ size: 0 }))).size);
  const sizes = await Promise.all(paths.map(bytes));
  const size = (test: (p: string) => boolean) => paths.reduce((sum, p, i) => sum + (test(p) ? sizes[i] : 0), 0);
  return {
    folders: [
      { path: home, bytes: size((p) => p !== appData) },
      ...(paths.includes(appData) ? [{ path: appData, bytes: size((p) => p === appData) }] : []),
    ].filter((f) => f.bytes > 0),
    keep,
    report,
    archive: archiveDir(),
  };
}

// The databases themselves, so a delete can never again be the end of something conversion could not read.
async function backupCursorDatabases() {
  const sources = ["globalStorage", "workspaceStorage"].map((name) => path.join(cursorUserDir(), name)).filter((p) => existsSync(p));
  const needed = (await Promise.all(sources.map(folderBytes))).reduce((a, b) => a + b, 0);
  const dest = path.join(archiveDir(), "databases");
  await fs.mkdir(dest, { recursive: true });
  const disk = await fs.statfs(dest);
  if (disk.bavail * disk.bsize < needed) throw new Error(`it needs ${Math.ceil(needed / 1e9)} GB free`);
  for (const source of sources) await fs.cp(source, path.join(dest, path.basename(source)), { recursive: true, force: true });
}

// Converts once more first, so a chat from this morning is not lost, and backs up Cursor's databases. Refuses unless both fully worked.
export async function removeCursorFolders(): Promise<{ ok: boolean; note: string; failed: string[] }> {
  const { chatStorage: mode } = await loadSettings();
  // Checked before copying, because the other modes promise that Cursor's files stay put and nothing is copied.
  const notAllowed = cursorRemovalRefusal({ mode, running: false, errors: [] });
  if (notAllowed) return { ok: false, note: notAllowed, failed: [] };
  const report = await convertCursorChats();
  const refusal = cursorRemovalRefusal({ mode, running: await cursorRunning(), errors: report.errors });
  if (refusal) return { ok: false, note: refusal, failed: [] };
  try {
    await backupCursorDatabases();
  } catch (err) {
    return { ok: false, note: `Nothing was deleted, because the backup failed: ${err instanceof Error ? err.message : String(err)}`, failed: [] };
  }
  // The sync link lives in these folders, so it stops with them.
  await patchSettings({ cursorIntegration: "off" });
  const { paths } = await removalTargets();
  const failed: string[] = [];
  for (const target of paths) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(() => failed.push(target));
  }
  return {
    ok: !failed.length,
    note: failed.length ? "Some files could not be deleted. Close any program using them and try again." : "Cursor's folders are deleted. Your chats are safe here.",
    failed,
  };
}
