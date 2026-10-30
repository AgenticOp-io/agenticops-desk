import { app } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listCursorProjects, slugFromPath, type CursorChat, type CursorProject } from "./cursor";
import { readJson, serialized, writeJsonAtomic } from "./jsonStore";

export type ProjectRecord = CursorProject & { lastUsedAt: number };

type Library = {
  removed: string[];
  added: Array<{ path: string; name?: string; slug?: string; addedAt: number }>;
  lastUsed: Record<string, number>;
  chatLastUsed: Record<string, number>;
  chats: CursorChat[];
};

const empty = (): Library => ({
  removed: [],
  added: [],
  lastUsed: {},
  chatLastUsed: {},
  chats: [],
});

function keyOf(p: string) {
  return path.normalize(p).toLowerCase();
}

function libraryFile() {
  return path.join(app.getPath("userData"), "library.json");
}

function threadFile(id: string) {
  return path.join(app.getPath("userData"), "threads", `${id}.json`);
}

const LIB = "library";

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
  if (changed) await save(lib);

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

async function load(): Promise<Library> {
  let lib: Library;
  try {
    const raw = JSON.parse(await fs.readFile(libraryFile(), "utf8")) as Partial<Library>;
    lib = {
      removed: Array.isArray(raw.removed) ? raw.removed : [],
      added: Array.isArray(raw.added) ? raw.added : [],
      lastUsed: raw.lastUsed && typeof raw.lastUsed === "object" ? raw.lastUsed : {},
      chatLastUsed: raw.chatLastUsed && typeof raw.chatLastUsed === "object" ? raw.chatLastUsed : {},
      chats: Array.isArray(raw.chats) ? (raw.chats as CursorChat[]) : [],
    };
  } catch {
    lib = empty();
  }
  const beforeAdded = lib.added.length;
  const beforeChats = lib.chats.length;
  hydrate(lib);
  if (lib.added.length !== beforeAdded || lib.chats.length !== beforeChats) {
    await save(lib);
  }
  return lib;
}

async function save(lib: Library) {
  await writeJsonAtomic(libraryFile(), lib);
}

export async function touchProject(dir: string) {
  if (!dir) return;
  const lib = await load();
  lib.lastUsed[keyOf(dir)] = Date.now();
  await save(lib);
}

export async function touchChat(chatId: string, projectPath?: string | null) {
  if (!chatId) return;
  const lib = await load();
  lib.chatLastUsed[chatId] = Date.now();
  if (projectPath) lib.lastUsed[keyOf(projectPath)] = Date.now();
  const row = lib.chats.find((c) => c.id === chatId);
  if (row) {
    row.lastUsedAt = Date.now();
    row.updatedAt = Date.now();
  }
  await save(lib);
}

export async function chatLastUsedMap() {
  return (await load()).chatLastUsed;
}

export async function addProject(dir: string) {
  const resolved = path.normalize(dir);
  const lib = await load();
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
  await save(lib);
  return resolved;
}

export async function rememberProjects(projects: CursorProject[]) {
  if (!projects.length) return;
  const lib = await load();
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
  if (changed) await save(lib);
}

export async function rememberChats(chats: CursorChat[]) {
  if (!chats.length) return;
  const lib = await load();
  const byId = new Map(lib.chats.map((c) => [c.id, c]));
  let changed = false;
  for (const c of chats) {
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
      byId.set(c.id, { ...prev, ...c, lastUsedAt: c.lastUsedAt ?? prev.lastUsedAt });
      changed = true;
    }
  }
  if (changed) {
    lib.chats = [...byId.values()];
    await save(lib);
  }
}

export async function upsertChat(chat: CursorChat) {
  const lib = await load();
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
  await save(lib);
}

export async function rememberedChats(): Promise<CursorChat[]> {
  return (await load()).chats;
}

export async function lastUsedProjects() {
  return (await load()).lastUsed;
}

export async function saveThread(chatId: string, messages: unknown[]) {
  if (!chatId) return;
  const file = threadFile(chatId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(messages), "utf8");
}

export async function loadThread(chatId: string): Promise<unknown[] | null> {
  try {
    const raw = JSON.parse(await fs.readFile(threadFile(chatId), "utf8"));
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function removeProject(dir: string) {
  const lib = await load();
  const k = keyOf(dir);
  if (!lib.removed.includes(k)) lib.removed.push(k);
  lib.added = lib.added.filter((a) => keyOf(a.path) !== k);
  await save(lib);
}

export async function listLibraryProjects(): Promise<ProjectRecord[]> {
  const lib = await load();
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
