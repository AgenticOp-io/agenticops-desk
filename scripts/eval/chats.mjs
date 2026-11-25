// Training conversations from every agent chat on this computer: Claude Code transcripts (~/.claude/projects,
// which is what AgenticOps Desk runs) and Cursor agent transcripts (~/.cursor/projects plus the Desk's cursor-archive).
// node scripts/eval/chats.mjs [--max-chars 14000]   → eval/train/chats.jsonl
// Text turns only: tool calls and results are dropped (Cursor never saved results, so a trace would not line up).
// Secrets are masked and chats that mention Hyperion (work code, not ours) are left out.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { args, EVAL_DIR } from "./lib.mjs";

// The ones with a capture group keep it (the "Bearer " or "password=" part) and mask what follows.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];
export const scrub = (s) => SECRET.reduce((t, re) => t.replace(re, (_m, pre) => (typeof pre === "string" ? pre : "") + "<secret>"), s);

const text = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n"));
// Harness noise in user turns: slash-command echoes, reminders, interrupted markers.
const cleanUser = (s) => {
  const q = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) return q[1];
  s = s.replace(/<(system-reminder|timestamp|attached_files|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, "").trim();
  return /^\[Request interrupted|^Caveat: The messages below/.test(s) ? "" : s;
};

// Turns → alternating user/assistant messages, consecutive same-role text merged.
export function fold(turns) {
  const out = [];
  for (const { role, content } of turns) {
    const c = (role === "user" ? cleanUser(content) : content).trim();
    if (!c) continue;
    const last = out[out.length - 1];
    if (last?.role === role) last.content += "\n\n" + c;
    else out.push({ role, content: c });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// Split at user turns so each piece fits the training context and ends on an assistant reply.
export function chunk(msgs, maxChars) {
  const pieces = [];
  let cur = [];
  let size = 0;
  for (let i = 0; i + 1 < msgs.length; i += 2) {
    const pair = [msgs[i], msgs[i + 1]];
    if (pair[0].role !== "user" || pair[1].role !== "assistant") continue;
    const n = pair[0].content.length + pair[1].content.length;
    if (n > maxChars) continue; // one exchange too long to learn from whole
    if (size + n > maxChars && cur.length) (pieces.push(cur), (cur = []), (size = 0));
    cur.push(...pair);
    size += n;
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) e.name !== "subagents" && walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

if (process.argv[1]?.endsWith("chats.mjs")) {
  const maxChars = Number(args()["max-chars"] ?? 14_000); // ~4k tokens, what a QLoRA run on one L4 holds
  const home = os.homedir();
  const convs = [];
  const seenMsg = new Set(); // resumed Claude Code sessions repeat earlier messages in a new file
  for (const f of walk(path.join(home, ".claude", "projects"))) {
    const turns = [];
    for (const o of lines(f)) {
      if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta || !o.message) continue;
      if (o.uuid && seenMsg.has(o.uuid)) continue;
      if (o.uuid) seenMsg.add(o.uuid);
      turns.push({ role: o.message.role ?? o.type, content: text(o.message.content) });
    }
    convs.push({ src: "claude", file: f, msgs: fold(turns) });
  }
  const seenCursor = new Set();
  const cursorFiles = [...walk(path.join(home, ".cursor", "projects")), ...walk(path.join(process.env.APPDATA ?? "", "AgenticOps Desk", "cursor-archive"))]
    .sort((a, b) => statSync(b).size - statSync(a).size); // the larger copy of a chat is the more complete one
  for (const f of cursorFiles) {
    const id = path.basename(f, ".jsonl");
    if (seenCursor.has(id)) continue;
    seenCursor.add(id);
    convs.push({ src: "cursor", file: f, msgs: fold(lines(f).filter((o) => o.role === "user" || o.role === "assistant").map((o) => ({ role: o.role, content: text(o.message?.content) }))) });
  }
  // Cursor's own database holds chats older than the transcript files. Read a copy: Cursor may have it open.
  const db = path.join(process.env.APPDATA ?? "", "Cursor", "User", "globalStorage", "state.vscdb");
  if (existsSync(db)) {
    const tmp = path.join(os.tmpdir(), `cursor-state-${process.pid}.vscdb`);
    copyFileSync(db, tmp);
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(tmp, { readOnly: true });
    const bubbles = new Map(d.prepare("select key, value from cursorDiskKV where key like 'bubbleId:%'").all().map((r) => [r.key, r.value]));
    for (const r of d.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all()) {
      const id = r.key.slice(13);
      if (seenCursor.has(id)) continue; // already have it as a transcript
      seenCursor.add(id);
      const turns = [];
      for (const h of JSON.parse(r.value).fullConversationHeadersOnly ?? []) {
        const b = bubbles.get(`bubbleId:${id}:${h.bubbleId}`);
        if (b) turns.push({ role: h.type === 1 ? "user" : "assistant", content: JSON.parse(b).text ?? "" });
      }
      convs.push({ src: "cursor", file: `cursor-db:${id}`, msgs: fold(turns) });
    }
    d.close();
    rmSync(tmp, { force: true });
  }
  let work = 0;
  const rows = [];
  const count = { claude: 0, cursor: 0 };
  for (const c of convs) {
    if (/hyperion/i.test(c.file) || c.msgs.some((m) => /hyperion/i.test(m.content))) {
      work++;
      continue;
    }
    for (const piece of chunk(c.msgs.map((m) => ({ ...m, content: scrub(m.content) })), maxChars)) {
      rows.push(JSON.stringify({ src: c.src, messages: piece }));
      count[c.src]++;
    }
  }
  mkdirSync(path.join(EVAL_DIR, "train"), { recursive: true });
  const out = path.join(EVAL_DIR, "train", "chats.jsonl");
  writeFileSync(out, rows.join("\n") + "\n");
  console.log(`${convs.length} chats read, ${work} left out (Hyperion), ${rows.length} examples (claude ${count.claude}, cursor ${count.cursor}) in ${out}`);
}
