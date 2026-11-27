// Training examples from every agent chat on this computer: Claude Code transcripts (~/.claude/projects, which is
// what AgenticOps Desk runs) and Cursor agent transcripts (~/.cursor/projects, the Desk's cursor-archive, Cursor's
// state.vscdb). No Electron imports, so scripts/eval/chats.mjs runs it under plain node too.
// Text turns only: tool calls and results are dropped (Cursor never saved results, so a trace would not line up).
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Msg = { role: string; content: string };

// The ones with a capture group keep it (the "Bearer " or "password=" part) and mask what follows.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
  /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];
export const scrub = (s: string) => SECRET.reduce((t, re) => t.replace(re, (_m, pre) => (typeof pre === "string" ? pre : "") + "<secret>"), s);

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n")
      : "";
// Harness noise in user turns: slash-command echoes, reminders, interrupted markers.
const cleanUser = (s: string) => {
  const q = s.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (q) return q[1];
  s = s.replace(/<(system-reminder|timestamp|attached_files|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, "").trim();
  return /^\[Request interrupted|^Caveat: The messages below/.test(s) ? "" : s;
};

// Turns → alternating user/assistant messages, consecutive same-role text merged.
export function fold(turns: Msg[]): Msg[] {
  const out: Msg[] = [];
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
export function chunk(msgs: Msg[], maxChars: number): Msg[][] {
  const pieces: Msg[][] = [];
  let cur: Msg[] = [];
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

// Words in the leave-out list, matched case-insensitively against the chat's file path and every message.
export function leftOut(file: string, msgs: Msg[], words: string[]): boolean {
  const ws = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  return ws.length > 0 && [file, ...msgs.map((m) => m.content)].some((s) => ws.some((w) => s.toLowerCase().includes(w)));
}

const walk = (dir: string, out: string[] = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) e.name !== "subagents" && walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};
// Async with a yield per file: run inside the app, a sync pass over every transcript froze the window for ~10 s.
const lines = async (f: string): Promise<any[]> =>
  (await new Promise((r) => setImmediate(r)), await readFile(f, "utf8")).split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

// One user message and the reply to it, for recall (recall.ts). `at` is the transcript's last change, 0 if unknown.
export type Exchange = { src: "claude" | "cursor"; file: string; at: number; user: string; assistant: string };
export type TrainingSet = { rows: string[]; chats: number; leftOut: number; claude: number; cursor: number; exchanges: Exchange[] };

const mtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

export async function collectChats(opts: { deskDir: string; appData?: string; home?: string; maxChars?: number; leaveOut?: string[] }): Promise<TrainingSet> {
  const home = opts.home ?? os.homedir();
  const appData = opts.appData ?? process.env.APPDATA ?? "";
  const maxChars = opts.maxChars ?? 14_000; // ~4k tokens, what a QLoRA run on one L4 holds
  const convs: { src: "claude" | "cursor"; file: string; msgs: Msg[] }[] = [];
  const seenMsg = new Set<string>(); // resumed Claude Code sessions repeat earlier messages in a new file
  for (const f of walk(path.join(home, ".claude", "projects"))) {
    const turns: Msg[] = [];
    for (const o of await lines(f)) {
      if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta || !o.message) continue;
      if (o.uuid && seenMsg.has(o.uuid)) continue;
      if (o.uuid) seenMsg.add(o.uuid);
      turns.push({ role: o.message.role ?? o.type, content: text(o.message.content) });
    }
    convs.push({ src: "claude", file: f, msgs: fold(turns) });
  }
  const seenCursor = new Set<string>();
  const cursorFiles = [...walk(path.join(home, ".cursor", "projects")), ...walk(path.join(opts.deskDir, "cursor-archive"))].sort(
    (a, b) => statSync(b).size - statSync(a).size, // the larger copy of a chat is the more complete one
  );
  for (const f of cursorFiles) {
    const id = path.basename(f, ".jsonl");
    if (seenCursor.has(id)) continue;
    seenCursor.add(id);
    const turns = (await lines(f)).filter((o) => o.role === "user" || o.role === "assistant").map((o) => ({ role: o.role, content: text(o.message?.content) }));
    convs.push({ src: "cursor", file: f, msgs: fold(turns) });
  }
  // Cursor's own database holds chats older than the transcript files. Read a copy: Cursor may have it open.
  const db = path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  if (appData && existsSync(db)) {
    const tmp = path.join(os.tmpdir(), `cursor-state-${process.pid}.vscdb`);
    try {
      await copyFile(db, tmp);
      const { DatabaseSync } = await import("node:sqlite");
      const d = new DatabaseSync(tmp, { readOnly: true });
      // Row by row with a yield every 500, so a large Cursor history does not block the window for a second.
      let n = 0;
      const rows = async function* (sql: string) {
        for (const r of d.prepare(sql).iterate() as Iterable<any>) {
          if (++n % 500 === 0) await new Promise((res) => setImmediate(res));
          yield r;
        }
      };
      const bubbles = new Map<string, unknown>();
      for await (const r of rows("select key, value from cursorDiskKV where key like 'bubbleId:%'")) bubbles.set(r.key, r.value);
      for await (const r of rows("select key, value from cursorDiskKV where key like 'composerData:%'")) {
        const id = String(r.key).slice(13);
        if (seenCursor.has(id)) continue; // already have it as a transcript
        seenCursor.add(id);
        const turns: Msg[] = [];
        for (const h of JSON.parse(r.value).fullConversationHeadersOnly ?? []) {
          const b = bubbles.get(`bubbleId:${id}:${h.bubbleId}`);
          if (b) turns.push({ role: h.type === 1 ? "user" : "assistant", content: JSON.parse(String(b)).text ?? "" });
        }
        convs.push({ src: "cursor", file: `cursor-db:${id}`, msgs: fold(turns) });
      }
      d.close();
    } catch {
      /* no node:sqlite in this runtime, or a database layout we don't know: the transcripts still count */
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const set: TrainingSet = { rows: [], chats: convs.length, leftOut: 0, claude: 0, cursor: 0, exchanges: [] };
  for (const c of convs) {
    if (leftOut(c.file, c.msgs, opts.leaveOut ?? [])) {
      set.leftOut++;
      continue;
    }
    const msgs = c.msgs.map((m) => ({ ...m, content: scrub(m.content) }));
    const at = c.file.startsWith("cursor-db:") ? 0 : mtime(c.file);
    for (let i = 0; i + 1 < msgs.length; i++)
      if (msgs[i].role === "user" && msgs[i + 1].role === "assistant")
        set.exchanges.push({ src: c.src, file: c.file, at, user: msgs[i].content, assistant: msgs[i + 1].content });
    for (const piece of chunk(msgs, maxChars)) {
      set.rows.push(JSON.stringify({ src: c.src, messages: piece }));
      set[c.src]++;
    }
  }
  return set;
}
