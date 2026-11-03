import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { app } from "electron";

// Watch and react: a chat follows a log file. When new lines contain an error, AgenticOps Desk sends them to
// that chat so it starts investigating without being asked. Cool-down keeps a noisy log from looping.
export type Watch = { chatId: string; file: string; pattern: string };

export const DEFAULT_PATTERN = "\\b(error|exception|failed|failure|traceback|panic|fatal)\\b";
const DEBOUNCE_MS = 4000;
const COOLDOWN_MS = 120_000;

type Live = { w: Watch; watcher: FSWatcher | null; offset: number; buffer: string; timer: ReturnType<typeof setTimeout> | null; lastFired: number; poll: ReturnType<typeof setInterval> | null };
const live = new Map<string, Live>();
let onHit: ((w: Watch, lines: string) => boolean) | null = null;

function store() {
  return path.join(app.getPath("userData"), "watches.json");
}

function saved(): Watch[] {
  try {
    const raw = JSON.parse(readFileSync(store(), "utf8"));
    return Array.isArray(raw) ? raw.filter((w) => w && typeof w.chatId === "string" && typeof w.file === "string") : [];
  } catch {
    return [];
  }
}

function persist() {
  const list = [...live.values()].map((l) => l.w);
  mkdirSync(path.dirname(store()), { recursive: true });
  writeFileSync(`${store()}.tmp`, JSON.stringify(list, null, 2), "utf8");
  renameSync(`${store()}.tmp`, store());
}

function idOf(w: Pick<Watch, "chatId" | "file">) {
  return `${w.chatId}\n${path.resolve(w.file).toLowerCase()}`;
}

function readNew(l: Live) {
  let size = 0;
  try {
    size = statSync(l.w.file).size;
  } catch {
    return;
  }
  if (size < l.offset) l.offset = 0; // the log was rotated or truncated
  if (size === l.offset) return;
  const len = Math.min(size - l.offset, 256_000);
  const buf = Buffer.alloc(len);
  const fd = openSync(l.w.file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  l.offset = size;
  l.buffer = (l.buffer + buf.toString("utf8")).slice(-64_000);
  let re: RegExp;
  try {
    re = new RegExp(l.w.pattern || DEFAULT_PATTERN, "i");
  } catch {
    re = new RegExp(DEFAULT_PATTERN, "i");
  }
  if (!re.test(l.buffer)) return;
  if (l.timer) clearTimeout(l.timer);
  // Wait for the burst to finish so the whole stack trace goes along.
  l.timer = setTimeout(() => {
    l.timer = null;
    if (Date.now() - l.lastFired < COOLDOWN_MS) return;
    const lines = l.buffer.split(/\r?\n/).slice(-60).join("\n");
    if (onHit?.(l.w, lines)) {
      l.lastFired = Date.now();
      l.buffer = "";
    }
  }, DEBOUNCE_MS);
}

function start(w: Watch) {
  const id = idOf(w);
  stop(id, false);
  const l: Live = { w, watcher: null, offset: existsSync(w.file) ? statSync(w.file).size : 0, buffer: "", timer: null, lastFired: 0, poll: null };
  try {
    l.watcher = watch(w.file, () => readNew(l));
  } catch {
    l.watcher = null;
  }
  // fs.watch misses appends on some network drives and editors; a slow poll covers that.
  l.poll = setInterval(() => readNew(l), 3000);
  live.set(id, l);
}

function stop(id: string, save = true) {
  const l = live.get(id);
  if (!l) return;
  l.watcher?.close();
  if (l.poll) clearInterval(l.poll);
  if (l.timer) clearTimeout(l.timer);
  live.delete(id);
  if (save) persist();
}

export function initWatches(handler: (w: Watch, lines: string) => boolean) {
  onHit = handler;
  for (const w of saved()) if (existsSync(w.file)) start(w);
}

export function addWatch(chatId: string, file: string, pattern?: string): Watch[] {
  start({ chatId, file: path.resolve(file), pattern: pattern?.trim() || DEFAULT_PATTERN });
  persist();
  return listWatches(chatId);
}

export function removeWatch(chatId: string, file: string): Watch[] {
  stop(idOf({ chatId, file }));
  return listWatches(chatId);
}

export function removeChatWatches(chatId: string) {
  for (const [id, l] of live) if (l.w.chatId === chatId) stop(id, false);
  persist();
}

export function listWatches(chatId?: string): Watch[] {
  return [...live.values()].map((l) => l.w).filter((w) => !chatId || w.chatId === chatId);
}

export function closeWatches() {
  for (const id of [...live.keys()]) stop(id, false);
}
