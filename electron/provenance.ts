import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { writeJsonAtomicSync } from "./jsonStore";

// The "why" trail: for each file Claude changed, which chat changed it and the instruction behind it.
// Kept in app data (never in the repo), newest first, a few entries per file.
export type Origin = { chatId: string; prompt: string; at: number };

let book: Record<string, Origin[]> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function target() {
  return path.join(app.getPath("userData"), "provenance.json");
}

function load(): Record<string, Origin[]> {
  if (book) return book;
  try {
    const raw = JSON.parse(readFileSync(target(), "utf8"));
    book = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    book = {};
  }
  return book!;
}

function key(file: string) {
  return path.resolve(file).toLowerCase();
}

function flush() {
  timer = null;
  try {
    const all = load();
    const keys = Object.keys(all);
    // Keep the file small: drop the oldest files past 5,000.
    if (keys.length > 5000) {
      keys
        .sort((a, b) => (all[a][0]?.at ?? 0) - (all[b][0]?.at ?? 0))
        .slice(0, keys.length - 5000)
        .forEach((k) => delete all[k]);
    }
    writeJsonAtomicSync(target(), all, false);
  } catch (err) {
    console.error("AgenticOps Desk could not save provenance", err);
  }
}

export function recordOrigin(file: string, chatId: string, prompt: string) {
  if (!file || !chatId) return;
  const all = load();
  const k = key(file);
  const entry: Origin = { chatId, prompt: prompt.trim().slice(0, 600), at: Date.now() };
  const list = (all[k] ?? []).filter((o) => !(o.chatId === chatId && o.prompt === entry.prompt));
  all[k] = [entry, ...list].slice(0, 5);
  if (!timer) timer = setTimeout(flush, 1000);
}

export function originsOf(file: string): Origin[] {
  return load()[key(file)] ?? [];
}
