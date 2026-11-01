import { app } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listCursorChats, listCursorProjects, slugFromPath, type CursorChat, type CursorProject } from "./cursor";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";

export type ProjectRecord = CursorProject & { lastUsedAt: number };

type Library = {
  removed: string[];
  added: Array<{ path: string; name?: string; slug?: string; addedAt: number }>;
  lastUsed: Record<string, number>;
  chatLastUsed: Record<string, number>;
  chats: CursorChat[];
  // Chats the user deleted. Cursor rescans and late saves skip these, so a deleted chat stays deleted.
  deleted: string[];
};

const empty = (): Library => ({
  removed: [],
  added: [],
  lastUsed: {},
  chatLastUsed: {},
  chats: [],
  deleted: [],
});

function keyOf(p: string) {
  return path.normalize(p).toLowerCase();
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
      console.error("ClaudeDesk could not save the library", err);
      dirty = true;
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

// Every library read-modify-write goes through here so concurrent IPC calls can't drop each other's changes.
function withLibrary<T>(fn: (lib: Library) => Promise<T> | T): Promise<T> {
  return serialized(LIB, async () => fn(await load()));
}

export function migrateLibraryIfNeeded() {
  return withLibrary((lib) => migrate(lib));
}

async function migrate(lib: Library) {
  const dest = libraryFile();
  const appData = app.getPath("appData");
  const olds = [
    path.join(appData, "Electron", "library.json"),
    path.join(appData, "claudedesk", "library.json"),
  ];
  let changed = false;
  for (const old of olds) {
    if (!existsSync(old) || path.normalize(old) === path.normalize(dest)) continue;
    try {
      const raw = (await readJson(old)) as Partial<Library> | undefined;
      if (!raw) continue;
      for (const a of raw.added ?? []) {
        if (!a?.path) continue;
        if (!lib.added.some((x) => keyOf(x.path) === keyOf(a.path))) {
          lib.added.push(a);
          changed = true;
        }
      }
      for (const c of raw.chats ?? []) {
        if (!c?.id || lib.chats.some((x) => x.id === c.id)) continue;
        lib.chats.push(c);
        changed = true;
      }
      for (const [k, v] of Object.entries(raw.lastUsed ?? {})) {
        if (lib.lastUsed[k] || typeof v !== "number") continue;
        lib.lastUsed[k] = v;
        changed = true;
      }
      for (const [k, v] of Object.entries(raw.chatLastUsed ?? {})) {
        if (lib.chatLastUsed[k] || typeof v !== "number") continue;
        lib.chatLastUsed[k] = v;
        changed = true;
      }
    } catch {
      /* try next */
    }
  }
  if (changed) {
    remember(lib);
    await flushLibrary();
  }

  const destThreads = path.join(app.getPath("userData"), "threads");
  const oldThreadDirs = [
    path.join(appData, "Electron", "threads"),
    path.join(appData, "claudedesk", "threads"),
  ];
  for (const oldDir of oldThreadDirs) {
    if (!existsSync(oldDir) || path.normalize(oldDir) === path.normalize(destThreads)) continue;
    try {
      const files = await fs.readdir(oldDir);
      await fs.mkdir(destThreads, { recursive: true });
      for (const f of files) {
        const target = path.join(destThreads, f);
        if (existsSync(target)) continue;
        await fs.copyFile(path.join(oldDir, f), target);
      }
    } catch {
      /* try next */
    }
  }
}

function hydrate(lib: Library): Library {
  const removed = new Set(lib.removed.map((x) => x.toLowerCase()));
  for (const [k, ts] of Object.entries(lib.lastUsed)) {
    if (!k || removed.has(k)) continue;
    if (lib.added.some((a) => keyOf(a.path) === k)) continue;
    lib.added.push({
      path: k,
      name: path.basename(k),
      slug: slugFromPath(k),
      addedAt: typeof ts === "number" ? ts : Date.now(),
    });
  }
  const projectsByTime = Object.entries(lib.lastUsed).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  for (const [id, ts] of Object.entries(lib.chatLastUsed)) {
    if (!id || lib.chats.some((c) => c.id === id)) continue;
    const match = projectsByTime.find(([, t]) => t === ts)?.[0] ?? projectsByTime[0]?.[0] ?? "";
    lib.chats.push({
      id,
      slug: match ? slugFromPath(match) : "",
      projectPath: match || null,
      projectName: match ? path.basename(match) : "Agent",
      title: "Agent",
      updatedAt: typeof ts === "number" ? ts : Date.now(),
      lastUsedAt: typeof ts === "number" ? ts : Date.now(),
      size: 0,
    });
  }
  return lib;
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
        }
      : empty();
  const beforeAdded = lib.added.length;
  const beforeChats = lib.chats.length;
  hydrate(lib);
  memory = lib;
  if (lib.added.length !== beforeAdded || lib.chats.length !== beforeChats) {
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

export function addProject(dir: string) {
  const resolved = path.normalize(dir);
  return withLibrary(async (lib) => {
    const k = keyOf(resolved);
    lib.removed = lib.removed.filter((x) => x !== k);
    const existing = lib.added.find((a) => keyOf(a.path) === k);
    if (!existing) {
      lib.added.push({
        path: resolved,
        name: path.basename(resolved),
        slug: slugFromPath(resolved),
        addedAt: Date.now(),
      });
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
      if (lib.removed.includes(k)) continue;
      if (!lib.added.some((a) => keyOf(a.path) === k)) {
        lib.added.push({
          path: p.path,
          name: p.name,
          slug: p.slug,
          addedAt: Date.now(),
        });
        changed = true;
      }
    }
    if (changed) remember(lib);
  });
}

export function rememberChats(chats: CursorChat[]) {
  if (!chats.length) return Promise.resolve();
  return withLibrary(async (lib) => {
    const byId = new Map(lib.chats.map((c) => [c.id, c]));
    const gone = new Set(lib.deleted);
    let changed = false;
    for (const c of chats) {
      if (gone.has(c.id)) continue;
      const prev = byId.get(c.id);
      if (!prev) {
        byId.set(c.id, { ...c });
        changed = true;
        continue;
      }
      if (
        prev.title !== c.title ||
        prev.updatedAt !== c.updatedAt ||
        prev.projectPath !== c.projectPath ||
        prev.size !== c.size
      ) {
        byId.set(c.id, {
          ...prev,
          ...c,
          title: prev.titleLocked ? prev.title : c.title,
          titleLocked: prev.titleLocked,
          lastUsedAt: c.lastUsedAt ?? prev.lastUsedAt,
          pinned: c.pinned ?? prev.pinned,
          mode: c.mode ?? prev.mode,
          model: c.model ?? prev.model,
          parentId: c.parentId ?? prev.parentId,
        });
        changed = true;
      }
    }
    if (changed) {
      lib.chats = [...byId.values()];
      remember(lib);
    }
  });
}

export function upsertChat(chat: CursorChat) {
  return withLibrary(async (lib) => {
    if (lib.deleted.includes(chat.id)) return;
    const i = lib.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) lib.chats[i] = { ...lib.chats[i], ...chat };
    else lib.chats.push(chat);
    lib.chatLastUsed[chat.id] = chat.lastUsedAt ?? Date.now();
    if (chat.projectPath) {
      lib.lastUsed[keyOf(chat.projectPath)] = Date.now();
      const k = keyOf(chat.projectPath);
      if (!lib.removed.includes(k) && !lib.added.some((a) => keyOf(a.path) === k)) {
        lib.added.push({
          path: chat.projectPath,
          name: chat.projectName,
          slug: chat.slug,
          addedAt: Date.now(),
        });
      }
    }
    remember(lib);
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
    console.error("ClaudeDesk could not read Cursor projects", err);
  }
  try {
    chats = await listCursorChats();
    await rememberChats(chats);
  } catch (err) {
    console.error("ClaudeDesk could not read Cursor chats", err);
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
    lib.added = lib.added.filter((a) => keyOf(a.path) !== k);
    remember(lib);
    await flushLibrary();
  });
}

export async function listLibraryProjects(): Promise<ProjectRecord[]> {
  const lib = await withLibrary((l) => l);
  const removed = new Set(lib.removed.map((x) => x.toLowerCase()));
  let discovered: CursorProject[] = [];
  try {
    discovered = await listCursorProjects();
  } catch {
    discovered = [];
  }
  const out = new Map<string, ProjectRecord>();

  for (const p of discovered) {
    const k = p.path ? keyOf(p.path) : p.slug.toLowerCase();
    if (!k) continue;
    if (removed.has(k) || removed.has(p.slug.toLowerCase())) continue;
    if (out.has(k)) continue;
    out.set(k, {
      ...p,
      lastUsedAt: lib.lastUsed[k] ?? p.lastChatAt ?? 0,
    });
  }

  for (const a of lib.added) {
    const k = keyOf(a.path);
    if (removed.has(k) || out.has(k)) continue;
    const slug = a.slug || slugFromPath(a.path);
    const chats = discovered.find((p) => p.slug.toLowerCase() === slug.toLowerCase());
    out.set(k, {
      name: a.name || path.basename(a.path) || a.path,
      path: a.path,
      slug,
      exists: existsSync(a.path),
      chatCount: chats?.chatCount ?? 0,
      lastChatAt: chats?.lastChatAt ?? null,
      lastUsedAt: lib.lastUsed[k] ?? a.addedAt,
    });
  }

  return [...out.values()].sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name),
  );
}
