import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonStore";

// What the agent shows with show_canvas, one document per chat. It is saved next to the chat's thread
// (canvas/<chatId>.json), so it survives restarts and travels with the chat in desk sync.
export type CanvasDoc = { chatId: string; title: string; kind: "html" | "svg" | "markdown"; content: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const KINDS = new Set(["html", "svg", "markdown"]);

// main.ts sets this: it saves the document and opens or updates the chat's Canvas window.
let shown: (doc: CanvasDoc) => Promise<void> = async () => {};
export const setCanvasShown = (fn: typeof shown) => void (shown = fn);
export const showCanvas = (doc: CanvasDoc) => shown(doc);

export const canvasFile = (chatId: string) => path.join(app.getPath("userData"), "canvas", `${chatId}.json`);

export async function saveCanvas(doc: CanvasDoc) {
  if (!ID.test(doc.chatId)) return;
  await writeJsonAtomic(canvasFile(doc.chatId), doc, false);
}

export async function loadCanvas(chatId: string): Promise<CanvasDoc | null> {
  if (!ID.test(chatId)) return null;
  const d = (await readJson(canvasFile(chatId)).catch(() => null)) as Partial<CanvasDoc> | null;
  if (!d || typeof d.title !== "string" || typeof d.content !== "string" || !KINDS.has(String(d.kind))) return null;
  return { chatId, title: d.title, kind: d.kind as CanvasDoc["kind"], content: d.content };
}

// main.ts sets this to close the chat's Canvas window, so a chat deleted here or by sync leaves none open.
let removed: (chatId: string) => void = () => {};
export const setCanvasRemoved = (fn: typeof removed) => void (removed = fn);

export async function deleteCanvas(chatId: string) {
  if (!ID.test(chatId)) return;
  await fs.rm(canvasFile(chatId), { force: true }).catch(() => undefined);
  removed(chatId);
}
