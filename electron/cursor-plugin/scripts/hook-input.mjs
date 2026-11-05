import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

export function safeId(value) {
  return typeof value === "string" && ID.test(value) ? value : "";
}

export function idFromHook(input) {
  if (!input || typeof input !== "object") return "";
  return safeId(input.conversation_id) || safeId(input.session_id) || safeId(input.composer_id);
}

export function allowedRemote(url) {
  const s = typeof url === "string" ? url.trim() : "";
  if (s.length < 8 || s.length > 400 || /[\s"'`]/.test(s) || s.startsWith("-")) return "";
  if (/^https:\/\/[^\s]+\/[^\s]+\/[^\s]+$/i.test(s)) return s;
  if (/^git@[^\s:]+:[^\s/]+\/[^\s]+$/i.test(s)) return s;
  if (/^ssh:\/\/[^\s]+\/[^\s/]+\/[^\s]+$/i.test(s)) return s;
  return "";
}

// Only files already under the Cursor home are copied. A hook payload cannot point at an arbitrary path.
export function cursorFile(cursorHome, file) {
  if (typeof file !== "string" || !file.trim()) return "";
  const root = path.resolve(cursorHome);
  const resolved = path.resolve(file);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return resolved;
}
