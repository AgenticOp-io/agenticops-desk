import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// One promise chain per key, so read-modify-write cycles on the same file never interleave.
const chains = new Map<string, Promise<unknown>>();
let seq = 0;

export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

export function hasPendingWrites() {
  return chains.size > 0;
}

// Resolves once every queued write (including ones queued while waiting) has landed.
export async function flushWrites() {
  while (chains.size) await Promise.all([...chains.values()]);
}

// Write to a temp file and rename over the target, so a crash mid-write never leaves half a JSON file.
export async function writeJsonAtomic(file: string, data: unknown, pretty = true) {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch {
    // Windows can refuse the rename while something (e.g. antivirus) holds the target open.
    await fs.writeFile(file, text, "utf8");
    await fs.rm(tmp, { force: true });
  }
}

// undefined when missing or unreadable. A corrupt file is set aside rather than silently replaced.
export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (existsSync(file)) {
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    }
    return undefined;
  }
}
