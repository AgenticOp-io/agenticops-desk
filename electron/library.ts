import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listCursorChats, listCursorProjects, slugFromPath, type CursorChat, type CursorProject } from "./cursor";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";
import { cleanupProposals, emptyGoneProjectIds, mergeRemotes, remoteKey, type CleanupProposal, type SyncProject } from "./pureFeatures";

export type ProjectRecord = CursorProject & { lastUsedAt: number };

// One project. The id is permanent. path is its folder on this computer, empty when it only came from sync.
type ProjectRow = {
  id: string;
  path: string;
  name?: string;
  slug?: string;
  addedAt: number;
  remotes?: string[];
  // Earlier folders (lower case), so Cursor listing an old path does not bring the project back as a second one.
  aliases?: string[];
};

type MoveEntry = { chatId: string; from: string | null; to: string | null; at: number; why: string };

type Library = {
  removed: string[];
  added: ProjectRow[];
  lastUsed: Record<string, number>;
  chatLastUsed: Record<string, number>;
  chats: CursorChat[];
  // Chats the user deleted. Cursor rescans and late saves skip these, so a deleted chat stays deleted.
  deleted: string[];
  // Project ids merged into another project, kept so a chat or computer still using an old id lands in the right place.
  merged: Record<string, string>;
  // The record of every change to a chat's project.
  moves: MoveEntry[];
};

const MAX_MOVES = 2000;

const empty = (): Library => ({
  removed: [],
  added: [],
  lastUsed: {},
  chatLastUsed: {},
  chats: [],
  deleted: [],
  merged: {},
  moves: [],
});

function keyOf(p: string) {
  return path.normalize(p).toLowerCase();
}

function rowById(lib: Library, id: string | null | undefined): ProjectRow | undefined {
  let cur = id;
  for (let hops = 0; cur && lib.merged[cur] && hops < 50; hops += 1) cur = lib.merged[cur];
  return cur ? lib.added.find((row) => row.id === cur) : undefined;
}

function rowForPath(lib: Library, dir: string): ProjectRow | undefined {
  const k = keyOf(dir);
  return lib.added.find((row) => row.path && keyOf(row.path) === k) ?? lib.added.find((row) => row.aliases?.includes(k));
}

function addRow(lib: Library, dir: string, name?: string): ProjectRow | undefined {
  const resolved = path.normalize(dir);
  if (lib.removed.includes(keyOf(resolved))) return undefined;
  const row: ProjectRow = {
    id: randomUUID(),
    path: resolved,
    name: name || path.basename(resolved),
    slug: slugFromPath(resolved),
    addedAt: Date.now(),
  };
  lib.added.push(row);
  return row;
}

function applyRow(chat: CursorChat, row: ProjectRow) {
  chat.projectId = row.id;
  chat.projectPath = row.path || null;
  chat.projectName = row.name || path.basename(row.path) || chat.projectName;
}

// The one place a chat gets a project. Once it has one it keeps it; a folder only decides the first time.
function fileChat(lib: Library, chat: CursorChat, keep?: string | null) {
  const row =
    rowById(lib, keep ?? chat.projectId) ??
    (chat.projectPath ? rowForPath(lib, chat.projectPath) ?? addRow(lib, chat.projectPath, chat.projectName) : undefined);
  if (row) applyRow(chat, row);
  else delete chat.projectId;
}

function logMove(lib: Library, chatId: string, from: string | null | undefined, to: string | null | undefined, why: string) {
  lib.moves.push({ chatId, from: from ?? null, to: to ?? null, at: Date.now(), why });
  if (lib.moves.length > MAX_MOVES) lib.moves.splice(0, lib.moves.length - MAX_MOVES);
}

function moveChat(lib: Library, chat: CursorChat, row: ProjectRow, why: string) {
  if (chat.projectId === row.id) return;
  logMove(lib, chat.id, chat.projectPath ?? chat.projectId, row.path || row.id, why);
  applyRow(chat, row);
  chat.projectMovedAt = Date.now();
}

// Everything in one project becomes part of the other. Returns the folders, so the caller can carry over project memory.
function mergeRow(lib: Library, from: ProjectRow, to: ProjectRow, why: string) {
  if (from === to) return null;
  lib.merged[from.id] = to.id;
  const fromKey = from.path ? keyOf(from.path) : "";
  to.aliases = [...new Set([...(to.aliases ?? []), ...(from.aliases ?? []), ...(fromKey ? [fromKey] : [])])].filter(
    (k) => !to.path || k !== keyOf(to.path),
  );
  to.remotes = mergeRemotes(from.remotes, to.remotes);
  if (!to.path && from.path) {
    to.path = from.path;
    to.slug = from.slug;
    to.aliases = to.aliases.filter((k) => k !== fromKey);
  }
  lib.added = lib.added.filter((row) => row !== from);
  for (const chat of lib.chats) if (chat.projectId === from.id) moveChat(lib, chat, to, why);
  if (fromKey) {
    lib.lastUsed[keyOf(to.path)] = Math.max(lib.lastUsed[keyOf(to.path)] ?? 0, lib.lastUsed[fromKey] ?? 0);
    delete lib.lastUsed[fromKey];
  }
  return { from: from.path, to: to.path };
}

// Points a project at a folder. A folder that is already another project means they were one project all along.
// Returns the old and new folder, so the caller can carry over project memory.
function placeRow(lib: Library, row: ProjectRow, dir: string, why: string) {
  const resolved = path.normalize(dir);
  const k = keyOf(resolved);
  // The project the user is locating keeps its ID: other computers may already know it by that one.
  const other = lib.added.find((item) => item !== row && item.path && keyOf(item.path) === k);
  if (other) mergeRow(lib, other, row, why);
  const before = row.path;
  row.aliases = [...new Set([...(row.aliases ?? []), ...(before ? [keyOf(before)] : [])])].filter((key) => key !== k);
  row.path = resolved;
  row.name = path.basename(resolved) || row.name;
  row.slug = slugFromPath(resolved);
  lib.removed = lib.removed.filter((key) => key !== k);
  for (const item of lib.added) if (item !== row && item.aliases?.includes(k)) item.aliases = item.aliases.filter((key) => key !== k);
  for (const chat of lib.chats) if (chat.projectId === row.id) applyRow(chat, row);
  if (before) delete lib.lastUsed[keyOf(before)];
  lib.lastUsed[k] = Date.now();
  return before ? { from: before, to: resolved } : null;
}

function libraryFile() {
  return path.join(app.getPath("userData"), "library.json");
}

function threadFile(id: string) {
  // The id is the file name. Reject anything that could leave the threads folder.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(id)) throw new Error("Invalid chat id");
  return path.join(app.getPath("userData"), "threads", `${id}.json`);
}

const LIB = "library";
let memory: Library | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

// The library stays in memory. Touches update that copy and one write follows, instead of
// rewriting library.json on every rename, send, or last-used bump.
function remember(lib: Library) {
  memory = lib;
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLibrary();
  }, 1000);
}

export function libraryPending() {
  return dirty || flushing !== null || flushTimer !== null;
}

let flushed: () => void = () => {};

// Desk sync listens here. The library does not import sync, so the two cannot call each other in a circle.
export function onLibraryFlush(fn: () => void) {
  flushed = fn;
}

export function flushLibrary(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) return flushing.then(() => (dirty ? flushLibrary() : undefined));
  if (!memory || !dirty) return Promise.resolve();
  dirty = false;
  const snapshot = JSON.parse(JSON.stringify(memory)) as Library;
  flushing = writeJsonAtomic(libraryFile(), snapshot)
    .catch((err) => {
      console.error("AgenticOps Desk could not save the library", err);
      dirty = true;
    })
    .finally(() => {
      flushing = null;
      flushed();
    });
  return flushing;
}

export type LibrarySlice = {
  chats: CursorChat[];
  deleted: string[];
  projects: Array<{ id: string; path: string; name: string; remotes: string[] }>;
  merged: Record<string, string>;
};

export function exportLibrarySlice(): Promise<LibrarySlice> {
  return withLibrary((lib) => ({
    chats: lib.chats.map((chat) => ({ ...chat })),
    deleted: [...lib.deleted],
    projects: lib.added.map((row) => ({
      id: row.id,
      path: row.path,
      name: row.name || path.basename(row.path),
      remotes: row.remotes ?? [],
    })),
    merged: { ...lib.merged },
  }));
}

export function rememberProjectRemotes(found: Array<{ id: string; remote: string }>) {
  return withLibrary((lib) => {
    let changed = false;
    for (const { id, remote } of found) {
      const row = rowById(lib, id);
      if (!row) continue;
      const next = mergeRemotes(row.remotes, [remote]);
      if (JSON.stringify(next) === JSON.stringify(row.remotes ?? [])) continue;
      row.remotes = next;
      changed = true;
    }
    if (changed) remember(lib);
  });
}

// Projects other computers know about, and merges they made. A project new here has no folder until the user gives it one.
export function importSyncedProjects(projects: SyncProject[], merged: Record<string, string>) {
  return withLibrary((lib) => {
    let changed = false;
    const carried: Array<{ from: string; to: string }> = [];
    for (const [from, to] of Object.entries(merged)) {
      if (lib.merged[from] === to || from === to) continue;
      lib.merged[from] = to;
      changed = true;
    }
    const final = (id: string) => {
      let cur = id;
      for (let hops = 0; lib.merged[cur] && hops < 50; hops += 1) cur = lib.merged[cur];
      return cur;
    };
    for (const row of [...lib.added]) {
      const target = final(row.id);
      if (target === row.id) continue;
      changed = true;
      const other = lib.added.find((item) => item.id === target);
      if (other) {
        const pair = mergeRow(lib, row, other, "sync");
        if (pair?.from && pair.to) carried.push(pair);
        continue;
      }
      // The same project under the ID the other computer gave it first. Nothing moves.
      const old = row.id;
      row.id = target;
      for (const chat of lib.chats) if (chat.projectId === old) chat.projectId = target;
    }
    for (const project of projects) {
      if (lib.merged[project.id]) continue;
      const row = lib.added.find((item) => item.id === project.id);
      if (!row) {
        lib.added.push({ id: project.id, path: "", name: project.name, addedAt: Date.now(), remotes: mergeRemotes([], project.remotes) });
        changed = true;
        continue;
      }
      const next = mergeRemotes(row.remotes, project.remotes);
      if (JSON.stringify(next) !== JSON.stringify(row.remotes ?? [])) {
        row.remotes = next;
        changed = true;
      }
    }
    if (changed) remember(lib);
    return carried;
  });
}

// Writes merged chats back. Unchanged data does not schedule another sync.
export function importSyncedLibrary(chats: CursorChat[], deleted: string[]) {
  return withLibrary(async (lib) => {
    let changed = false;
    for (const id of deleted) {
      if (!id || lib.deleted.includes(id)) continue;
      lib.deleted.push(id);
      changed = true;
    }
    const gone = new Set(lib.deleted);
    const before = lib.chats.length;
    lib.chats = lib.chats.filter((chat) => !gone.has(chat.id));
    if (lib.chats.length !== before) changed = true;
    for (const chat of chats) {
      if (!chat.id || gone.has(chat.id)) continue;
      const index = lib.chats.findIndex((row) => row.id === chat.id);
      if (index < 0) {
        const next = { ...chat };
        fileChat(lib, next);
        lib.chats.push(next);
        changed = true;
        continue;
      }
      const prev = lib.chats[index];
      const next =
        (chat.updatedAt ?? 0) < (prev.updatedAt ?? 0)
          ? { ...prev }
          : { ...prev, ...chat, title: prev.titleLocked ? prev.title : chat.title, titleLocked: prev.titleLocked, projectPath: prev.projectPath };
      // A move made here while this sync ran is newer than what came down.
      const stay = (prev.projectMovedAt ?? 0) > (chat.projectMovedAt ?? 0);
      next.projectMovedAt = stay ? prev.projectMovedAt : chat.projectMovedAt ?? prev.projectMovedAt;
      fileChat(lib, next, stay ? prev.projectId : chat.projectId ?? prev.projectId);
      if (next.projectId !== prev.projectId && next.projectId) logMove(lib, chat.id, prev.projectPath ?? prev.projectId, next.projectPath ?? next.projectId, "sync");
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        lib.chats[index] = next;
        changed = true;
      }
    }
    if (changed) remember(lib);
  });
}

// Every library read-modify-write goes through here so concurrent IPC calls can't drop each other's changes.
function withLibrary<T>(fn: (lib: Library) => Promise<T> | T): Promise<T> {
  return serialized(LIB, async () => fn(await load()));
}

function hydrate(lib: Library): Library {
  const removed = new Set(lib.removed.map((x) => x.toLowerCase()));
  for (const [k, ts] of Object.entries(lib.lastUsed)) {
    if (!k || removed.has(k)) continue;
    if (lib.added.some((a) => (a.path && keyOf(a.path) === k) || a.aliases?.includes(k))) continue;
    lib.added.push({
      id: randomUUID(),
      path: k,
      name: path.basename(k),
      slug: slugFromPath(k),
      addedAt: typeof ts === "number" ? ts : Date.now(),
    });
  }
  // A chat known only by when it was last used has no project on record. It waits unfiled; guessing would misfile it.
  for (const [id, ts] of Object.entries(lib.chatLastUsed)) {
    if (!id || lib.chats.some((c) => c.id === id)) continue;
    lib.chats.push({
      id,
      slug: "empty-window",
      projectPath: null,
      projectName: "Agents",
      title: "Agent",
      updatedAt: typeof ts === "number" ? ts : Date.now(),
      lastUsedAt: typeof ts === "number" ? ts : Date.now(),
      size: 0,
    });
  }
  // Projects from before permanent IDs get one here, and each chat is tied to its project once.
  for (const row of lib.added) {
    if (!row.id) row.id = randomUUID();
    if (row.path) row.slug = slugFromPath(row.path);
  }
  for (const chat of lib.chats) fileChat(lib, chat);
  return lib;
}

// A project whose folder and chats are both gone. Chats are never removed here: an earlier pass deleted
// identical transcripts, and that threw away conversations the user still wanted.
async function tidyLibrary(lib: Library): Promise<boolean> {
  const counts = new Map<string, number>();
  for (const chat of lib.chats) if (chat.projectId) counts.set(chat.projectId, (counts.get(chat.projectId) ?? 0) + 1);
  const ghosts = new Set(
    emptyGoneProjectIds(lib.added.map((row) => ({ id: row.id, exists: Boolean(row.path) && existsSync(row.path), chats: counts.get(row.id) ?? 0 }))),
  );
  if (!ghosts.size) return false;
  const backup = path.join(app.getPath("userData"), "backups", "library-before-tidy.json");
  if (!existsSync(backup)) {
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(libraryFile(), backup).catch(() => undefined);
  }
  for (const row of lib.added) {
    if (!ghosts.has(row.id) || !row.path) continue;
    const key = keyOf(row.path);
    if (!lib.removed.includes(key)) lib.removed.push(key);
  }
  lib.added = lib.added.filter((row) => !ghosts.has(row.id));
  return true;
}

// Only call inside withLibrary. readJson sets a corrupt file aside before we start over from empty.
async function load(): Promise<Library> {
  if (memory) return memory;
  const raw = (await readJson(libraryFile())) as Partial<Library> | undefined;
  const lib: Library =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? {
          removed: Array.isArray(raw.removed) ? raw.removed : [],
          added: Array.isArray(raw.added) ? raw.added : [],
          lastUsed: raw.lastUsed && typeof raw.lastUsed === "object" ? raw.lastUsed : {},
          chatLastUsed: raw.chatLastUsed && typeof raw.chatLastUsed === "object" ? raw.chatLastUsed : {},
          chats: Array.isArray(raw.chats) ? (raw.chats as CursorChat[]) : [],
          deleted: Array.isArray(raw.deleted) ? raw.deleted.filter((x): x is string => typeof x === "string") : [],
          merged: raw.merged && typeof raw.merged === "object" ? raw.merged : {},
          moves: Array.isArray(raw.moves) ? raw.moves : [],
        }
      : empty();
  const before = JSON.stringify(lib);
  hydrate(lib);
  const tidied = await tidyLibrary(lib);
  memory = lib;
  if (tidied || JSON.stringify(lib) !== before) {
    remember(lib);
    await flushLibrary();
  }
  return lib;
}

export function touchProject(dir: string) {
  if (!dir) return Promise.resolve();
  return withLibrary(async (lib) => {
    lib.lastUsed[keyOf(dir)] = Date.now();
    remember(lib);
  });
}

export function touchChat(chatId: string, projectPath?: string | null) {
  if (!chatId) return Promise.resolve();
  return withLibrary(async (lib) => {
    lib.chatLastUsed[chatId] = Date.now();
    if (projectPath) lib.lastUsed[keyOf(projectPath)] = Date.now();
    const row = lib.chats.find((c) => c.id === chatId);
    if (row) {
      row.lastUsedAt = Date.now();
      row.updatedAt = Date.now();
    }
    remember(lib);
  });
}

export function chatLastUsedMap() {
  return withLibrary((lib) => lib.chatLastUsed);
}

// The user picked this folder. If one project is waiting for a folder with this remote, this is that project moved or cloned.
export function addProject(dir: string, remote?: string | null) {
  const resolved = path.normalize(dir);
  return withLibrary(async (lib) => {
    const k = keyOf(resolved);
    lib.removed = lib.removed.filter((x) => x !== k);
    if (!lib.added.some((a) => a.path && keyOf(a.path) === k)) {
      // Adding a folder merged away earlier makes it a project again: the user asked for it by name.
      for (const row of lib.added) if (row.aliases?.includes(k)) row.aliases = row.aliases.filter((key) => key !== k);
      const key = remote ? remoteKey(remote) : null;
      const waiting = key
        ? lib.added.filter((row) => (!row.path || !existsSync(row.path)) && row.remotes?.some((item) => remoteKey(item) === key))
        : [];
      if (waiting.length === 1) placeRow(lib, waiting[0], resolved, "folder added");
      else addRow(lib, resolved);
    }
    lib.lastUsed[k] = Date.now();
    remember(lib);
    return resolved;
  });
}

export function rememberProjects(projects: CursorProject[]) {
  if (!projects.length) return Promise.resolve();
  return withLibrary(async (lib) => {
    let changed = false;
    for (const p of projects) {
      if (!p.path) continue;
      const k = keyOf(p.path);
      if (lib.removed.includes(k) || rowForPath(lib, p.path)) continue;
      addRow(lib, p.path, p.name);
      changed = true;
    }
    if (changed) remember(lib);
  });
}

// Scans refresh titles and times. They never change the project of a chat that has one, and return each chat as filed.
export function rememberChats(chats: CursorChat[]): Promise<CursorChat[]> {
  if (!chats.length) return Promise.resolve([]);
  return withLibrary(async (lib) => {
    const byId = new Map(lib.chats.map((c) => [c.id, c]));
    const gone = new Set(lib.deleted);
    let changed = false;
    const filed: CursorChat[] = [];
    for (const c of chats) {
      if (gone.has(c.id)) continue;
      const prev = byId.get(c.id);
      if (!prev) {
        const next = { ...c };
        fileChat(lib, next);
        byId.set(c.id, next);
        filed.push(next);
        changed = true;
        continue;
      }
      const next = {
        ...prev,
        ...c,
        title: prev.titleLocked ? prev.title : c.title,
        titleLocked: prev.titleLocked,
        lastUsedAt: c.lastUsedAt ?? prev.lastUsedAt,
        pinned: c.pinned ?? prev.pinned,
        mode: c.mode ?? prev.mode,
        model: c.model ?? prev.model,
        parentId: c.parentId ?? prev.parentId,
        projectPath: c.projectPath || prev.projectPath,
        projectMovedAt: prev.projectMovedAt,
      };
      fileChat(lib, next, prev.projectId ?? null);
      filed.push(next);
      if (
        prev.title !== next.title ||
        prev.updatedAt !== next.updatedAt ||
        prev.projectId !== next.projectId ||
        prev.projectPath !== next.projectPath ||
        prev.size !== next.size
      ) {
        byId.set(c.id, next);
        changed = true;
      }
    }
    if (changed) {
      lib.chats = [...byId.values()];
      remember(lib);
    }
    return filed;
  });
}

// Cursor chats new to the desk get their project here. A chat already known keeps its own.
export function fileNewChats(chats: CursorChat[]) {
  return withLibrary((lib) => {
    let changed = false;
    for (const chat of chats) {
      if (lib.deleted.includes(chat.id) || lib.chats.some((row) => row.id === chat.id)) continue;
      const next = { ...chat };
      fileChat(lib, next);
      lib.chats.push(next);
      changed = true;
    }
    if (changed) remember(lib);
  });
}

// The renderer's copy can be out of date, so a save never changes which project a chat is in.
export function upsertChat(chat: CursorChat) {
  return withLibrary(async (lib) => {
    if (lib.deleted.includes(chat.id)) return;
    const i = lib.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) {
      const prev = lib.chats[i];
      const next = { ...prev, ...chat, projectMovedAt: prev.projectMovedAt, projectPath: prev.projectPath };
      fileChat(lib, next, prev.projectId ?? null);
      lib.chats[i] = next;
    } else {
      const next = { ...chat };
      fileChat(lib, next);
      lib.chats.push(next);
    }
    lib.chatLastUsed[chat.id] = chat.lastUsedAt ?? Date.now();
    const filed = lib.chats.find((c) => c.id === chat.id);
    if (filed?.projectPath) lib.lastUsed[keyOf(filed.projectPath)] = Date.now();
    remember(lib);
  });
}

// An explicit move: a chat into a project, or into the project of a folder the user picked.
export function moveChatToProject(chatId: string, target: { projectId?: string; folder?: string }, why = "moved by the user") {
  return withLibrary(async (lib) => {
    const chat = lib.chats.find((c) => c.id === chatId);
    if (!chat) return null;
    const row = target.folder
      ? rowForPath(lib, target.folder) ?? addRow(lib, target.folder)
      : rowById(lib, target.projectId);
    if (!row) return null;
    moveChat(lib, chat, row, why);
    remember(lib);
    await flushLibrary();
    return { ...chat };
  });
}

export function locateProject(projectId: string, dir: string) {
  return withLibrary(async (lib) => {
    const row = rowById(lib, projectId);
    if (!row) return null;
    const carried = placeRow(lib, row, dir, "folder located");
    remember(lib);
    await flushLibrary();
    return carried;
  });
}

function cleanupRows(lib: Library) {
  return lib.added.map((row) => ({
    id: row.id,
    name: row.name || path.basename(row.path),
    path: row.path,
    exists: Boolean(row.path) && existsSync(row.path),
    chats: lib.chats.filter((chat) => chat.projectId === row.id).length,
  }));
}

export function projectCleanupPlan(): Promise<CleanupProposal[]> {
  return withLibrary((lib) => cleanupProposals(cleanupRows(lib)));
}

// Merges the projects the user approved, after saving a copy of library.json to come back to.
export function applyProjectCleanup(merges: Array<{ from: string; to: string }>) {
  return withLibrary(async (lib) => {
    await flushLibrary();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(app.getPath("userData"), "backups", `library-before-cleanup-${stamp}.json`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(libraryFile(), backup);
    const carried: Array<{ from: string; to: string }> = [];
    let moved = 0;
    for (const merge of merges) {
      const from = lib.added.find((row) => row.id === merge.from);
      const to = lib.added.find((row) => row.id === merge.to);
      if (!from || !to || from === to) continue;
      moved += lib.chats.filter((chat) => chat.projectId === from.id).length;
      const pair = mergeRow(lib, from, to, "cleanup");
      if (pair?.from && pair.to) carried.push(pair);
    }
    remember(lib);
    await flushLibrary();
    return { moved, backup, carried };
  });
}

// Only the fields the UI edits; anything else in the patch (ids, paths) is ignored.
export function patchChat(
  id: string,
  patch: { title?: unknown; pinned?: unknown; mode?: unknown; model?: unknown; parentId?: unknown },
) {
  return withLibrary(async (lib) => {
    const row = lib.chats.find((c) => c.id === id);
    if (!row) return null;
    if (typeof patch.title === "string" && patch.title.trim()) {
      row.title = patch.title.trim().slice(0, 200);
      row.titleLocked = true;
    }
    if (typeof patch.pinned === "boolean") row.pinned = patch.pinned;
    if (typeof patch.mode === "string") row.mode = patch.mode.slice(0, 40);
    if (typeof patch.model === "string") row.model = patch.model.slice(0, 120);
    if (typeof patch.parentId === "string") row.parentId = patch.parentId.slice(0, 120);
    row.updatedAt = Date.now();
    remember(lib);
    return row;
  });
}

export function deleteChat(id: string) {
  return withLibrary(async (lib) => {
    lib.chats = lib.chats.filter((c) => c.id !== id);
    delete lib.chatLastUsed[id];
    if (!lib.deleted.includes(id)) lib.deleted.push(id);
    remember(lib);
    await flushLibrary();
    await fs.rm(threadFile(id), { force: true }).catch(() => undefined);
  });
}

export function deletedChatIds(): Promise<Set<string>> {
  return withLibrary((lib) => new Set(lib.deleted));
}

type SavedMsg = { text?: unknown };

// Searches message text only (not the JSON around it), several files at a time.
export async function searchMessages(query: string): Promise<string[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const dir = path.join(app.getPath("userData"), "threads");
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const hits: string[] = [];
  const check = async (name: string) => {
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      if (!raw.toLowerCase().includes(needle)) return;
      const msgs = JSON.parse(raw) as SavedMsg[];
      if (Array.isArray(msgs) && msgs.some((m) => typeof m?.text === "string" && m.text.toLowerCase().includes(needle))) {
        hits.push(name.slice(0, -5));
      }
    } catch {
      /* skip a thread that is mid-write */
    }
  };
  for (let i = 0; i < names.length && hits.length < 40; i += 16) {
    await Promise.all(names.slice(i, i + 16).map(check));
  }
  return hits.slice(0, 40);
}

export function rememberedChats(): Promise<CursorChat[]> {
  return withLibrary((lib) => lib.chats);
}

// Reads Cursor's own project list and chat index into this library. Removed projects stay removed.
export async function importCursorLibrary(): Promise<{ projects: number; chats: number; workspace: string | null }> {
  let projects: CursorProject[] = [];
  let chats: CursorChat[] = [];
  try {
    projects = await listCursorProjects();
    await rememberProjects(projects);
  } catch (err) {
    console.error("AgenticOps Desk could not read Cursor projects", err);
  }
  try {
    chats = await listCursorChats();
    await rememberChats(chats);
  } catch (err) {
    console.error("AgenticOps Desk could not read Cursor chats", err);
  }
  const workspace =
    [...projects]
      .filter((p) => p.path && p.exists)
      .sort((a, b) => (b.lastChatAt ?? 0) - (a.lastChatAt ?? 0))[0]?.path ?? null;
  return { projects: projects.filter((p) => p.path).length, chats: chats.length, workspace };
}

export function lastUsedProjects() {
  return withLibrary((lib) => lib.lastUsed);
}

// One queue per chat and a temp-file rename, so overlapping saves never leave half a thread on disk.
export function saveThread(chatId: string, messages: unknown[]) {
  if (!chatId) return Promise.resolve();
  return serialized(`thread:${chatId}`, () => writeJsonAtomic(threadFile(chatId), messages, false));
}

export async function loadThread(chatId: string): Promise<unknown[] | null> {
  const raw = await serialized(`thread:${chatId}`, () => readJson(threadFile(chatId)));
  return Array.isArray(raw) ? raw : null;
}

export function removeProject(dir: string) {
  return withLibrary(async (lib) => {
    const k = keyOf(dir);
    if (!lib.removed.includes(k)) lib.removed.push(k);
    const gone = lib.added.filter((a) => a.path && keyOf(a.path) === k).map((a) => a.id);
    lib.added = lib.added.filter((a) => !gone.includes(a.id));
    // Its chats keep their folder for the record and wait unfiled until the user moves them.
    for (const chat of lib.chats) if (chat.projectId && gone.includes(chat.projectId)) delete chat.projectId;
    remember(lib);
    await flushLibrary();
  });
}

export async function listLibraryProjects(): Promise<ProjectRecord[]> {
  let discovered: CursorProject[] = [];
  try {
    discovered = await listCursorProjects();
  } catch {
    discovered = [];
  }
  await rememberProjects(discovered);
  const lib = await withLibrary((l) => l);
  const removed = new Set(lib.removed.map((x) => x.toLowerCase()));
  const out = new Map<string, ProjectRecord>();

  for (const p of discovered) {
    const k = p.path ? keyOf(p.path) : p.slug.toLowerCase();
    if (!k) continue;
    if (removed.has(k) || removed.has(p.slug.toLowerCase())) continue;
    if (out.has(k)) continue;
    // A folder merged into another project shows as that project, not as a second one.
    const row = p.path ? rowForPath(lib, p.path) : undefined;
    if (row && keyOf(row.path) !== k) continue;
    out.set(k, {
      ...p,
      id: row?.id,
      remote: row?.remotes?.find((r) => /github\.com/i.test(r)),
      lastUsedAt: lib.lastUsed[k] ?? p.lastChatAt ?? 0,
    });
  }

  for (const a of lib.added) {
    const k = a.path ? keyOf(a.path) : a.id;
    if (removed.has(k) || out.has(k)) continue;
    const slug = a.slug || (a.path ? slugFromPath(a.path) : "");
    const chats = slug ? discovered.find((p) => p.slug.toLowerCase() === slug.toLowerCase()) : undefined;
    out.set(k, {
      id: a.id,
      name: a.name || path.basename(a.path) || a.path,
      path: a.path,
      remote: a.remotes?.find((r) => /github\.com/i.test(r)),
      slug,
      exists: Boolean(a.path) && existsSync(a.path),
      chatCount: chats?.chatCount ?? 0,
      lastChatAt: chats?.lastChatAt ?? null,
      // Being added to the list is not being opened: a bulk import dates every row at once, and that would keep
      // them all out of the archive. Adding a folder by hand records a real open, and chats bring their own dates.
      lastUsedAt: lib.lastUsed[k] ?? 0,
    });
  }

  return [...out.values()].sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name),
  );
}
