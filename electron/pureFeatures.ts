import { createCipheriv, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RemoteHost } from "./gitHosts";

// Electron-free helpers for standing orders, org memory and the second opinion, so plain Node can test them.

// OpenAI's /v1/models body. True only when this exact model id is listed.
export function openAiListsModel(body: unknown, model: string): boolean {
  if (!body || typeof body !== "object") return false;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.some((row) => !!row && typeof row === "object" && (row as { id?: unknown }).id === model);
}

// At most two threads, and always leave the app a core. More threads page the machine and the window stops answering.
export function localServerThreads(logical: number): number {
  return Math.max(1, Math.min(2, Math.floor(logical) - 1));
}

// Free bytes that must remain after the model file is in memory, and the floor that stops a running server.
export const MODEL_RESERVE_BYTES = 3_000_000_000;
export const MEMORY_FLOOR_BYTES = 1_500_000_000;

export type ResourceSample = { freeBytes: number; logicalCpus: number };
export type ModelBudget = { start: boolean; threads: number; context: number; reason: string };

// Refuse to load the model when doing so would leave the app without RAM. A small context and two threads are the most it may use.
export function modelBudget(sample: ResourceSample, modelBytes: number): ModelBudget {
  const spare = sample.freeBytes - Math.max(0, modelBytes);
  const threads = localServerThreads(sample.logicalCpus);
  const context = spare >= 6_000_000_000 ? 4096 : 2048;
  if (spare < MODEL_RESERVE_BYTES) {
    const freeGb = Math.max(0, Math.floor(sample.freeBytes / 1_000_000_000));
    const needGb = Math.ceil((Math.max(0, modelBytes) + MODEL_RESERVE_BYTES) / 1_000_000_000);
    return {
      start: false,
      threads,
      context,
      reason: `Not enough free memory to load the local model without freezing the app (${freeGb} GB free, ${needGb} GB needed). Close other programs and try again.`,
    };
  }
  return { start: true, threads, context, reason: "" };
}

export function shouldStopForMemory(freeBytes: number): boolean {
  return freeBytes < MEMORY_FLOOR_BYTES;
}

// The process image name, not a path. Matches CPython and the Windows py launcher, not unrelated names.
export function isPythonImage(name: string): boolean {
  const base = (name.split(/[/\\]/).pop() ?? "").toLowerCase();
  return /^(pyw?|python[\d.]*w?)(\.exe)?$/.test(base);
}

export type ProcessRow = { pid: number; parent: number; name: string };

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, parent, name] = line.split("|");
    const id = Number(pid);
    const ppid = Number(parent);
    if (!name || !Number.isInteger(id) || !Number.isInteger(ppid)) continue;
    rows.push({ pid: id, parent: ppid, name });
  }
  return rows;
}

// Python the app opened, including grandchildren. Other people's Python is left alone.
export function pythonPidsInTree(rows: ProcessRow[], rootPid: number): number[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0 || row.pid === rootPid) continue;
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const found: number[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const id = stack.pop();
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) {
      stack.push(child.pid);
      if (isPythonImage(child.name)) found.push(child.pid);
    }
  }
  return found;
}

// Bits for every CPU except the first two, which stay with the app. Null when there is nothing to spare.
export function affinityMask(logicalCpus: number): number | null {
  const n = Math.floor(logicalCpus);
  if (n <= 2 || n > 30) return null;
  return ((1 << n) - 1) ^ 0b11;
}

// CPU only, idle priority, and a small batch, so one prompt cannot take the machine.
export function llamaServerArgs(modelPath: string, alias: string, threads: number, context = 2048): string[] {
  const n = String(Math.max(1, Math.min(2, Math.floor(threads))));
  const ctx = String(Math.min(4096, Math.max(512, Math.floor(context))));
  return [
    "-m", modelPath,
    "--alias", alias,
    "--host", "127.0.0.1",
    "--port", "11437",
    "-c", ctx,
    "-b", "256",
    "-ub", "128",
    "-t", n,
    "-tb", n,
    "--prio", "-1",
    "--device", "none",
    "-ngl", "0",
    "--fit", "off",
    "--no-op-offload",
    "--log-disable",
  ];
}

// A result only ends the run when no background task can still wake the agent; older CLIs never report idle or tasks.
export function turnIsOver(msg: { type?: unknown; subtype?: unknown; state?: unknown }, backgroundTasks: number): boolean {
  if (msg.type === "result") return backgroundTasks === 0;
  return msg.type === "system" && msg.subtype === "session_state_changed" && msg.state === "idle";
}

// "src/**" matches everything under src; "*.lock" matches a lock file in any folder; "a/b.ts" matches that file.
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "/**");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(g.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

// The owner of a git remote ("AgenticOp-io" for https://github.com/AgenticOp-io/x.git), or null.
export function ownerFromRemote(url: string): string | null {
  const m = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/[^/]+\/)([^/]+)\//i.exec(url.trim());
  return m ? m[1].replace(/[^\w.-]/g, "") || null : null;
}

// A compact line diff: common prefix and suffix are skipped, the middle is shown as -/+ lines.
export function lineDiff(before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out = [`@@ line ${start + 1}`];
  for (let i = Math.max(0, start - 2); i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  for (let i = endA + 1; i < Math.min(a.length, endA + 3); i++) out.push(`  ${a[i]}`);
  return out.join("\n");
}

// Auto model: errors that mean "this AI can't take the job right now", so the next one should try.
// Anything else (a tool failing, a bad request in the chat itself) stays with the user.
const FAILOVER =
  /\b(?:api error|status|error|http)\W{0,3}(?:429|5\d\d)\b|:\s*5\d\d\b|rate.?limit|usage limit|5-hour limit|you've hit your|overloaded|high demand|(?:exceeded|out of|over) (?:your |the )?(?:current )?quota|quota (?:exceeded|exhausted|reached)|credit balance|billing (?:error|issue|problem)|insufficient (?:credit|funds|quota|balance)|too many requests|(?:at|over) capacity|rejected the api key|invalid api key|add an api key|not logged in|\/login|authentication|unauthori[sz]ed|declined this request|connection error|could not connect|econnrefused|econnreset|enotfound|etimedout|fetch failed|network error|(?:request|connection|api) timed out|stalled|no (claude code|agent engine) build|(claude code|agent engine) (was )?not found|model\b.*\b(not found|does not exist|not available)|returned no output|local only is on/i;

export function shouldFailOver(error: string): boolean {
  return FAILOVER.test(error);
}

// Gemini signs each function call. The next request must send that signature back, or the tool turn is rejected.
export function thoughtSignature(extra: unknown): { google: { thought_signature: string } } | undefined {
  const sig = (extra as { google?: { thought_signature?: unknown } } | null)?.google?.thought_signature;
  return typeof sig === "string" && sig ? { google: { thought_signature: sig } } : undefined;
}

// A call we did not sign (an older saved turn) still has to carry a signature. Gemini documents this exact value.
export function geminiSignature(extra: unknown): { google: { thought_signature: string } } {
  return thoughtSignature(extra) ?? { google: { thought_signature: "skip_thought_signature_validator" } };
}

// llama.cpp returns this while the model file is still loading. The server is up; the request should wait.
export function isModelLoading(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const row = err as { status?: number; message?: string; error?: { message?: string } };
  return row.status === 503 && /loading model/i.test(`${row.message ?? ""} ${row.error?.message ?? ""}`);
}

// What Auto does with one event of a run it routes: let it through, hide a provider error so the next AI
// can try, end the run, or hand the message over (the run ended after a hidden error).
// Claude Code prints the 5-hour limit as a normal reply, then again as an error. A short line that is
// only that notice is hidden. A long reply that merely mentions a limit is not.
const LIMIT_LINE = /you've hit your|5-hour limit|usage limit reached/i;

export function autoStep(
  run: { queue: string[]; failed?: string; erred?: boolean },
  kind: string,
  text = "",
): "pass" | "swallow" | "finish" | "handover" {
  const notice = text.trim();
  const limitLine = kind === "line" && notice.length <= 500 && LIMIT_LINE.test(notice) && shouldFailOver(notice);
  if ((kind === "error" && notice && shouldFailOver(notice)) || limitLine) {
    if (!run.failed) run.failed = notice;
    return "swallow";
  }
  // The engine reports the same limit twice, sometimes in pieces. Later copies stay out of the chat.
  if (run.failed && (kind === "error" || kind === "line" || kind === "thinking")) return "swallow";
  if (kind === "error") run.erred = true;
  if (kind !== "done") return "pass";
  return run.failed ? "handover" : "finish";
}

// Claude Code's prompt cache lasts about an hour. Resuming an interrupted run after that resends its history.
export const RESUME_TTL_MS = 45 * 60_000;

// A follow-up never resumes the paid session and never resends the transcript. The local model
// carries a short summary, or the short brief when it cannot. A run with no history — a review
// round, or resuming an interrupted run — keeps its session.
export function shouldHandOff(historyMessages: number): boolean {
  return historyMessages > 0;
}

// 0 local, 1 Sonnet-class, 2 Opus-class. A new chat starts at 0.
export type ModelTier = 0 | 1 | 2;

export type ModelLesson = {
  kept: number;
  retried: number;
  raised: number;
  lowered: number;
  lastTier: ModelTier;
  lastPrompt: string;
  assigned: string;
};

export function modelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m.includes("opus") || m.includes("fable")) return 2;
  if (m.includes("ollama") || m.includes("haiku") || m === "local") return 0;
  return 1;
}

export function tierFromWord(text: string): ModelTier | null {
  const word = text.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  if (word === "local" || word === "cheap") return 0;
  if (word === "sonnet" || word === "mid" || word === "medium") return 1;
  if (word === "opus" || word === "expensive") return 2;
  return null;
}

export function lessonVerdict(row: ModelLesson, prompt: string, model: string): "kept" | "retried" | "raised" | "lowered" {
  if (row.lastPrompt && prompt.trim().slice(0, 180) === row.lastPrompt) return "retried";
  const tier = modelTier(model);
  if (row.assigned && tier > row.lastTier) return "raised";
  if (row.assigned && tier < row.lastTier) return "lowered";
  return "kept";
}

export function applyVerdict(row: ModelLesson, verdict: "kept" | "retried" | "raised" | "lowered"): ModelLesson {
  return { ...row, [verdict]: row[verdict] + 1 };
}

// The local model writes the summary. It does not run the chat, unless the user picked it in the menu.
export function tierForAgent(tier: ModelTier): ModelTier {
  return tier === 0 ? 1 : tier;
}

// Step up after repeated raises or retries. Step down after several accepted cheaper runs.
export function nextTier(row: ModelLesson | undefined): ModelTier {
  if (!row?.assigned) return 0;
  const up = row.raised + row.retried;
  if (up >= 2 && up > row.kept) return Math.min(2, row.lastTier + 1) as ModelTier;
  if (row.kept >= 3 && row.kept > up && row.lastTier > 0) return (row.lastTier - 1) as ModelTier;
  return row.lastTier;
}

// Cache-read tokens one run may accumulate before its tool log is dropped and the work continues
// from a short packet. About one heavy pass over a long thread.
export const COMPACT_REREAD = 1_500_000;

const GATHER_TOOLS = new Set([
  "read",
  "readfile",
  "notebookread",
  "grep",
  "search",
  "glob",
  "ls",
  "listfiles",
  "webfetch",
  "websearch",
  "bash",
  "powershell",
  "runcommand",
]);
const SHELL_TOOLS = new Set(["bash", "powershell", "runcommand"]);

// A long read, search, or command result. Short enough that the next step does not re-read a file body.
// Null means the result is already small enough to keep.
export function shrinkGatherResult(toolName: string, text: string, limit = 1_800): string | null {
  const key = toolName.toLowerCase().replace(/[^a-z]/g, "");
  if (!GATHER_TOOLS.has(key) || text.length <= limit) return null;
  if (SHELL_TOOLS.has(key)) {
    const head = Math.floor(limit * 0.4);
    return `${text.slice(0, head)}\n…\n${text.slice(-(limit - head))}`;
  }
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters left on disk. Open only the lines you will change.)`;
}

const BRIEF_LIMIT = 8_000;

// What a fresh session needs in order to continue: the original request and the latest replies, not tool output.
export function sessionBrief(history: { role: string; text: string }[] | undefined, limit = BRIEF_LIMIT): string {
  const turns = (history ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim());
  if (!turns.length) return "";
  const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
  // File bodies in a reply are on disk. The fallback packet keeps the words, the paths, and the errors.
  const words = (text: string) =>
    text
      .replace(/```[\w-]*\r?\n[\s\S]*?```/g, "[code omitted]")
      .split(/\r?\n/)
      .filter((line) => line.length <= 240)
      .join("\n")
      .trim();
  const line = (m: { role: string; text: string }, n: number) => `${m.role === "user" ? "User" : "Assistant"}: ${clip(words(m.text), n)}`;
  const first = turns[0];
  const recent = turns.slice(-4);
  const lines = recent.includes(first) ? recent.map((m) => line(m, 1600)) : [line(first, 800), ...recent.map((m) => line(m, 1600))];
  let text = lines.join("\n\n");
  if (text.length <= limit) return text;
  text = [lines[0], ...lines.slice(-2)].join("\n\n");
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

// The newest assistant replies word for word (tables, plans, code), so a summary or a trimmed brief cannot lose what the user may ask about next.
// shortcut: the last 2 replies within 6000 characters in total; the oldest is cut first, then the newest is clipped from its start.
export function lastRepliesVerbatim(history: { role: string; text: string }[] | undefined, count = 2, limit = 6_000): string {
  const replies = (history ?? []).filter((m) => m.role === "assistant" && m.text.trim()).slice(-count);
  const kept: string[] = [];
  let used = 0;
  for (const m of replies.reverse()) {
    const room = limit - used;
    if (room < 200) break;
    const text = m.text.trim();
    kept.unshift(text.length > room ? `…${text.slice(-room)}` : text);
    used += Math.min(text.length, room);
  }
  return kept.map((t) => `Assistant (word for word): ${t}`).join("\n\n");
}

// Markdown tables from OLDER assistant replies (the newest two ride along whole), so a table sent earlier is not lost.
// shortcut: tables only, newest first within 4000 characters; plans in prose are not detected. Derived from history, nothing stored.
export function pinnedTables(history: { role: string; text: string }[] | undefined, skipNewest = 2, limit = 4_000): string {
  const replies = (history ?? []).filter((m) => m.role === "assistant" && m.text.trim());
  const older = replies.slice(0, Math.max(0, replies.length - skipNewest));
  const found: string[] = [];
  for (const m of older) {
    for (const block of m.text.split(/\n\s*\n/)) {
      const lines = block.trim().split("\n");
      if (lines.length >= 3 && lines.every((l) => l.trim().startsWith("|")) && /^\|?\s*:?-+/.test(lines[1].trim().replace(/^\|\s*/, "|"))) found.push(block.trim());
    }
  }
  const kept: string[] = [];
  let used = 0;
  for (const t of found.reverse()) {
    if (used + t.length > limit) continue;
    kept.unshift(t);
    used += t.length;
  }
  return kept.length ? `Earlier tables from this chat, unchanged:\n\n${kept.join("\n\n")}` : "";
}

// Token and cost totals per day, per engine or provider, per model. Kept for USAGE_DAYS days.
export type UsageTally = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; calls: number };
export type UsageLog = { days: Record<string, Record<string, UsageTally>> };
export const USAGE_DAYS = 60;

export function usageDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addUsage(log: UsageLog, at: number, source: string, model: string, add: Partial<UsageTally>): UsageLog {
  const day = usageDay(at);
  const key = `${source}|${model || "unknown"}`;
  const row = ((log.days[day] ??= {})[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0 });
  row.input += add.input ?? 0;
  row.output += add.output ?? 0;
  row.cacheRead += add.cacheRead ?? 0;
  row.cacheWrite += add.cacheWrite ?? 0;
  row.costUsd += add.costUsd ?? 0;
  row.calls += add.calls ?? 1;
  const oldest = usageDay(at - USAGE_DAYS * 86_400_000);
  for (const d of Object.keys(log.days)) if (d < oldest) delete log.days[d];
  return log;
}

export type UsageRow = {
  source: string;
  model: string;
  today: UsageTally;
  week: UsageTally;
  month: UsageTally;
  // Tokens per day, oldest first, for the last `span` days.
  daily: number[];
};

const tokensOf = (t: UsageTally) => t.input + t.output + t.cacheRead + t.cacheWrite;

export function summarizeUsage(log: UsageLog, now: number, span = 14): UsageRow[] {
  const zero = (): UsageTally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, calls: 0 });
  const plus = (a: UsageTally, b: UsageTally) => {
    a.input += b.input;
    a.output += b.output;
    a.cacheRead += b.cacheRead;
    a.cacheWrite += b.cacheWrite;
    a.costUsd += b.costUsd;
    a.calls += b.calls;
  };
  const days = Array.from({ length: 30 }, (_, i) => usageDay(now - i * 86_400_000));
  const rows = new Map<string, UsageRow>();
  days.forEach((day, age) => {
    for (const [key, tally] of Object.entries(log.days[day] ?? {})) {
      const [source, model] = key.split("|");
      let row = rows.get(key);
      if (!row) {
        row = { source, model, today: zero(), week: zero(), month: zero(), daily: Array(span).fill(0) };
        rows.set(key, row);
      }
      if (age === 0) plus(row.today, tally);
      if (age < 7) plus(row.week, tally);
      plus(row.month, tally);
      if (age < span) row.daily[span - 1 - age] += tokensOf(tally);
    }
  });
  return [...rows.values()].sort((a, b) => tokensOf(b.month) - tokensOf(a.month));
}

// Plan limits come as 0-1 in stream events and 0-100 from the usage request.
export function percentUsed(value: number | null | undefined, scale: "fraction" | "percent"): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, scale === "fraction" ? value * 100 : value));
}

// Intelligence Shorthand (IS-T3) for chats: what a finished run proved, kept
// instead of its transcript. Only a run whose checks passed leaves one, and a capsule whose files changed since
// is dropped (IS demote-on-digest-mismatch), so the next session trusts only what is still true.
export type Capsule = {
  at: number;
  request: string;
  outcome: string;
  gates: string[];
  files: { path: string; digest: string | null }[];
};

const GATE =
  /\b(tsc|vitest|jest|pytest|ruff|eslint|cargo (test|build|check)|go (test|build|vet)|node --test|(npm|pnpm|yarn|bun)( run)? (test|check|lint|build|typecheck)\b|git commit|git push)/i;

// A shell call whose success proves something about the work, e.g. "npx tsc --noEmit". Null for anything else.
export function gateCommand(name: string, input: unknown): string | null {
  if (!/^(bash|powershell|shell)$/i.test(name)) return null;
  const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string") return null;
  const hit = command.match(GATE);
  return hit ? hit[0].toLowerCase() : null;
}

// Did a check's tool result pass? Wrapped commands always "succeed" and report the real code as "[exit code: N]".
// shortcut: a chain like "tsc; npm test" reports only its last exit code; parse per command if that misleads.
export function gatePassed(result: { is_error?: boolean; content?: unknown }): boolean {
  if (result.is_error === true) return false;
  const c = result.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n")
        : "";
  const codes = [...text.matchAll(/\[exit code: (-?\d+)\]/g)];
  return !codes.length || codes[codes.length - 1][1] === "0";
}

const clipText = (text: string, n: number) => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function makeCapsule(input: {
  at: number;
  request: string;
  outcome: string;
  gates: string[];
  files: { path: string; digest: string | null }[];
}): Capsule | null {
  if (!input.gates.length || !input.outcome.trim()) return null;
  return {
    at: input.at,
    request: clipText(input.request, 300),
    outcome: clipText(input.outcome, 700),
    gates: [...new Set(input.gates)],
    files: input.files.slice(0, 30),
  };
}

// Verified capsules still true on disk, newest last, within `limit` characters.
export function capsuleBrief(capsules: Capsule[], digestOf: (file: string) => string | null, limit = 3_000): string {
  const fresh = capsules.filter((c) => c.files.every((f) => digestOf(f.path) === f.digest));
  const blocks: string[] = [];
  let size = 0;
  for (const c of [...fresh].reverse()) {
    const files = c.files.length ? `\n  Files: ${c.files.map((f) => f.path.split(/[\\/]/).pop()).join(", ")}` : "";
    const block = `- Asked: ${c.request}\n  Result: ${c.outcome}\n  Passed: ${c.gates.join(", ")}${files}`;
    if (size + block.length > limit) break;
    blocks.unshift(block);
    size += block.length;
  }
  return blocks.join("\n");
}

export function contextTokens(usage: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

// Last main-agent context in a Claude Code session transcript. A limit error at the end reports zeros and must
// not hide the turn that filled the window. Tool output can echo a usage object; only an assistant message counts.
export function latestContextTokens(transcript: string): number | undefined {
  const needle = '"usage":';
  let last = 0;
  let i = 0;
  while (i < transcript.length) {
    const at = transcript.indexOf(needle, i);
    if (at < 0) break;
    const before = transcript.slice(Math.max(0, at - 2000), at);
    const brace = transcript.indexOf("{", at);
    i = at + needle.length;
    if (brace < 0 || brace > at + needle.length + 5) continue;
    if (!/"role"\s*:\s*"assistant"/.test(before)) continue;
    if (/"parent_tool_use_id"\s*:\s*"/.test(before) || /"isSidechain"\s*:\s*true/.test(before)) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = brace; j < transcript.length && j < brace + 4000; j++) {
      const c = transcript[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      const tokens = contextTokens(JSON.parse(transcript.slice(brace, end)));
      if (tokens > 0) last = tokens;
    } catch {
      /* not a usage object */
    }
    i = end;
  }
  return last > 0 ? last : undefined;
}

// Rate limits and quota errors last a while; anything else gets a short rest.
export function coolDownMs(error: string): number {
  return /429|rate.?limit|usage limit|5-hour limit|you've hit your|quota|credit balance|too many requests/i.test(error) ? 5 * 60_000 : 60_000;
}

// "resets 9:20pm (America/Mexico_City)" → the next time that clock shows, in ms. Null if it cannot be read.
function clockResetMs(error: string, now: number): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([^)]+)\)/i.exec(error);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const ap = m[3].toLowerCase();
  const zone = m[4].trim();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }
  const parts = (ms: number) => {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = p.value;
    return o;
  };
  const wall = (p: Record<string, string>, h: number, min: number) => Date.UTC(+p.year, +p.month - 1, +p.day, h, min, 0);
  const p = parts(now);
  let guess = now + (wall(p, hour, minute) - wall(p, +p.hour, +p.minute) - +p.second * 1000);
  if (guess <= now) guess += 86_400_000;
  const g = parts(guess);
  guess += wall(g, hour, minute) - wall(g, +g.hour, +g.minute);
  if (guess <= now) guess += 86_400_000;
  if (!(guess > now && guess < now + 14 * 24 * 60 * 60_000)) return null;
  return guess;
}

// The signed-in agent's 5-hour window is already full, so Auto should not start it.
export function claudeWindowFull(window: { percent: number; resetsAt: number | null } | null, now: number): boolean {
  return window != null && window.percent >= 100 && window.resetsAt != null && window.resetsAt > now;
}

// When a used-up AI may be tried again. A reset time in the message (unix seconds or ms after "|", or a clock) wins.
export function restUntil(error: string, now: number): number {
  const stamp = /\|(\d{10,13})\b/.exec(error);
  if (stamp) {
    const n = Number(stamp[1]);
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > now && ms < now + 14 * 24 * 60 * 60_000) return ms;
  }
  return clockResetMs(error, now) ?? now + coolDownMs(error);
}

// Lower runs first when the user has not set an order. One cheap model per lab, then stronger paid
// models, then whatever the user added, then a model on this computer.
export function autoRank(model: string): number {
  const id = model.replace(/^direct:[a-z0-9]+:/, "");
  if (model === "default") return 0;
  if (id === "deepseek-flash") return 10;
  if (/gemini-4-hydrogen|gemini-3\.8-flash|haiku/.test(id)) return 20;
  if (/^gpt-6\.1-terra$|^gpt-6-sol$|^gpt-6\.2-sol$/.test(id)) return 30;
  if (/deepseek-v4-pro|mistral-large-4|codestral|qwen4-max/.test(id)) return 40;
  if (model.startsWith("direct:")) {
    if (/^direct:(ollama|gpu):/.test(model)) return 100;
    if (/gemini-4-(carbon|argon|neon)|grok-/.test(id)) return 70;
    if (/opus|fable|gpt-6\.2-astra/.test(id)) return 90;
    return 50;
  }
  return 95;
}

// A model on this computer, or the user's own GPU. Auto uses these only after the other models are off.
export function isOwnedModel(model: string): boolean {
  return /^direct:(ollama|gpu):/.test(model);
}

// The order Auto tries models in. The user's list wins among the hosted models; otherwise cheaper
// capable models run before the strong paid ones, and the chat's last good hosted model stays first.
// An owned model waits until every hosted model is off. A model that is used up is left out until its rest ends.
export function autoOrder(opts: {
  chosen: string[];
  available: string[];
  sticky?: string;
  restingUntil: Record<string, number>;
  now: number;
  owned?: (model: string) => boolean;
}): string[] {
  const isOwned = opts.owned ?? isOwnedModel;
  const avail = new Set(opts.available);
  const resting = (m: string) => (opts.restingUntil[m] ?? 0) > opts.now;
  let pool = (opts.chosen.length ? opts.chosen : opts.available).filter((m) => avail.has(m));
  if (!opts.chosen.length) pool = [...pool].sort((a, b) => autoRank(a) - autoRank(b) || a.localeCompare(b));
  const active = [...new Set(pool)].filter((m) => !resting(m));
  let hosted = active.filter((m) => !isOwned(m));
  let owned = active.filter(isOwned);
  // A chat that fell back to another AI must not stay there once the first choice is usable again.
  if (hosted[0] === "default") { /* keep it first */ }
  else if (opts.sticky && hosted.includes(opts.sticky)) hosted = [opts.sticky, ...hosted.filter((m) => m !== opts.sticky)];
  else if (!hosted.length && opts.sticky && owned.includes(opts.sticky)) owned = [opts.sticky, ...owned.filter((m) => m !== opts.sticky)];
  return [...hosted, ...owned];
}

// The JSON in a `claude plugin ... --json` output, which can have log lines before it.
export function parseCliJson<T>(text: string): T | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line) as T;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }
}

// One line describing a plugin command or skill: its frontmatter description, else its first line of text.
export function describeMarkdown(text: string): string {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const desc = fm ? /^description:\s*(.+)$/m.exec(fm[1])?.[1] : undefined;
  if (desc) return desc.trim().replace(/^["']|["']$/g, "").slice(0, 140);
  const body = text.replace(/^---[\s\S]*?\r?\n---/, "");
  return (body.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim().slice(0, 140);
}

// Quick edit asks for bare code, but models often wrap it in a ``` fence anyway; keep only what is inside.
export function stripFence(text: string): string {
  const m = /^\s*```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

// Declarations "@name" can point at: functions, classes, types and top-level values in common languages.
export const SYMBOL_KINDS = "function|class|interface|type|enum|def|fn|func|struct|trait|const|let|var";

// Turns `git grep -n` lines ("path:line:text") into symbols whose name starts with the query, best first.
export function parseSymbolHits(out: string, query: string, limit = 12) {
  const q = query.toLowerCase();
  const re = new RegExp(`(?:^|[^\\w$])(${SYMBOL_KINDS})\\s+\\*?([A-Za-z_$][\\w$]*)`);
  const seen = new Set<string>();
  const hits: Array<{ file: string; line: number; name: string; kind: string }> = [];
  for (const row of out.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row);
    const d = m && re.exec(m[3]);
    if (!m || !d || !d[2].toLowerCase().startsWith(q)) continue;
    const key = `${m[1]}:${d[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ file: m[1], line: Number(m[2]), name: d[2], kind: d[1] });
  }
  // Exact names first, then shorter names.
  return hits.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || a.name.length - b.name.length).slice(0, limit);
}

// host/owner/repo, lowercased, so the same remote matches on every computer. The owner can be several levels (GitLab subgroups). Azure DevOps' https, ssh and
// visualstudio.com forms of one repository give the same key: dev.azure.com/org/project/repo.
export function remoteKey(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const https = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  const scp = /^[\w.-]+@([^:/]+):(.+)$/i.exec(trimmed);
  const hit = https ?? scp;
  if (!hit) return null;
  let host = hit[1].toLowerCase().replace(/:\d+$/, "");
  let parts = hit[2].split("/");
  if (host === "ssh.dev.azure.com" && parts[0] === "v3") parts = parts.slice(1);
  const vs = /^([\w-]+)\.visualstudio\.com$/.exec(host);
  if (vs) parts = [vs[1], ...parts];
  if (host === "ssh.dev.azure.com" || vs) host = "dev.azure.com";
  if (host === "dev.azure.com") parts = parts.filter((p) => p !== "_git");
  const clean = parts.map((p) => p.replace(/[^\w.-]/g, "").toLowerCase());
  if (clean.length < 2 || clean.length > 10 || clean.some((p) => !p || p === "." || p === "..")) return null;
  return `${host}/${clean.join("/")}`;
}

// `git status --porcelain=v1 -b -z`: index (staged) and worktree (unstaged) letters per file; "?" is untracked.
export type GitFile = { path: string; from?: string; staged: string; unstaged: string };
export function parsePorcelain(out: string) {
  const parts = out.split("\0");
  const head = parts[0]?.startsWith("## ") ? parts.shift()!.slice(3) : "";
  const m = /^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
  const ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(m?.[3] ?? "")?.[1] ?? 0);
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1];
    const f: GitFile = { path: e.slice(3), staged: x === "?" || x === " " ? "" : x, unstaged: x === "?" ? "?" : y === " " ? "" : y };
    if (x === "R" || x === "C") f.from = parts[++i];
    files.push(f);
  }
  return { branch: m?.[1] === "HEAD (no branch)" ? "" : m?.[1] ?? "", upstream: m?.[2] ?? "", ahead, behind, files };
}

// The web pages of a remote on the four big hosts. Anything else (self-hosted) gets the repo page only.
export function remoteWeb(url: string): RemoteHost | null {
  const key = remoteKey(url);
  if (!key) return null;
  const [host, ...rest] = key.split("/");
  const kind = host === "github.com" ? "github" : host.includes("gitlab") ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : host === "dev.azure.com" ? "azure" : "other";
  const web = kind === "azure" && rest.length === 3 ? `https://${host}/${rest[0]}/${rest[1]}/_git/${rest[2]}` : `https://${key}`;
  return { kind, web, name: rest.join("/") };
}
export type { RemoteHost } from "./gitHosts";

// Sync travels over https or ssh. A local path or cleartext http URL is rejected.
export function allowedGitRemote(url: string): boolean {
  const s = url.trim();
  if (!remoteKey(s) || /[\s"'`]/.test(s) || s.startsWith("-")) return false;
  return /^https:\/\//i.test(s) || /^[\w.-]+@[^:/]+:/i.test(s) || /^ssh:\/\//i.test(s);
}

// A project's ID never changes. Folders are per computer, so they stay out of the sync repository.
export type SyncProject = { id: string; name: string; remotes: string[] };

export type SyncChat = {
  id: string;
  title: string;
  updatedAt: number;
  lastUsedAt?: number;
  projectId: string | null;
  projectMovedAt?: number;
  projectName: string;
  slug: string;
  pinned?: boolean;
  mode?: string;
  model?: string;
  parentId?: string;
  size: number;
};

// Layout and folder paths differ per computer. Everything else in settings can travel.
const SYNC_PREFS = ["windowFont", "itemFont", "hiddenChats", "showCode", "theme", "reviewer", "autoModels", "autocomplete", "privacy", "cursorIntegration"] as const;

export type CursorMode = "off" | "partial" | "full";

export type ChatStorage = "github" | "hybrid" | "local";

export function chatStorage(value: unknown): ChatStorage | "" {
  return value === "github" || value === "hybrid" || value === "local" ? value : "";
}

// What the Windows installer wrote. Anything else is ignored, so a bad file cannot pick a mode.
export function installChoices(
  raw: unknown,
): { storage: ChatStorage; importCursor: boolean; importTools: boolean; localModel: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const storage = chatStorage((raw as { storage?: unknown }).storage);
  if (!storage) return null;
  const flags = raw as { importCursor?: unknown; importTools?: unknown; localModel?: unknown };
  return { storage, importCursor: flags.importCursor === true, importTools: flags.importTools === true, localModel: flags.localModel === true };
}

export function cursorMode(value: unknown): CursorMode {
  return value === "partial" || value === "full" ? value : "off";
}

// Empties text copied from Cursor's own chat record so a new row does not carry the old chat.
export function blankValue(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map((item) => blankValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = blankValue(item);
    return out;
  }
  return value;
}

export type TranscriptMessage = { role: "user" | "assistant"; text: string };

export function cursorTranscript(jsonl: string): { title: string; messages: TranscriptMessage[] } {
  const messages: TranscriptMessage[] = [];
  let title = "Cursor chat";
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { role?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    try {
      row = JSON.parse(trimmed) as typeof row;
    } catch {
      continue;
    }
    const text = (row.message?.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
      .map((block) => (block.text ?? "").trim())
      .join("\n")
      .slice(0, 12_000);
    if (!text) continue;
    if (row.role === "user") {
      if (title === "Cursor chat") title = text.replace(/\s+/g, " ").slice(0, 80);
      messages.push({ role: "user", text });
    } else if (row.role === "assistant") messages.push({ role: "assistant", text });
    if (messages.length >= 200) break;
  }
  return { title, messages };
}

export function portablePrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SYNC_PREFS) if (key in prefs) out[key] = prefs[key];
  return out;
}

// A new remote goes last: after a repository changes owner, that is the address to clone. Known ones keep their
// place and spelling, so two computers settle on the same list.
export function mergeRemotes(a: string[] = [], b: string[] = []): string[] {
  const map = new Map<string, string>();
  for (const remote of [...a, ...b]) {
    const key = remoteKey(remote);
    if (key && !map.has(key)) map.set(key, remote);
  }
  return [...map.values()];
}

// The first name stands. A folder can have a different name on each computer, and last-wins would have them
// overwrite each other on every sync.
export function mergeProjects(a: SyncProject[], b: SyncProject[]): SyncProject[] {
  const map = new Map<string, SyncProject>();
  for (const project of [...a, ...b]) {
    if (!project.id) continue;
    const prev = map.get(project.id);
    map.set(project.id, {
      id: project.id,
      name: prev?.name || project.name || "",
      remotes: mergeRemotes(prev?.remotes, project.remotes),
    });
  }
  return [...map.values()];
}

// Pairs a local project that was never synced with the incoming one, when one remote says so without doubt.
// Two folders on one remote stay apart; the user picks with Locate folder.
export function matchSyncedProjects(local: Array<{ id: string; remotes?: string[] }>, incoming: SyncProject[]): Record<string, string> {
  const keys = (remotes: string[] = []) => remotes.map(remoteKey).filter(Boolean);
  const localIds = new Set(local.map((row) => row.id));
  const incomingIds = new Set(incoming.map((row) => row.id));
  const out: Record<string, string> = {};
  for (const project of incoming) {
    if (localIds.has(project.id)) continue;
    for (const key of keys(project.remotes)) {
      if (incoming.filter((row) => keys(row.remotes).includes(key)).length !== 1) continue;
      const found = local.filter((row) => !incomingIds.has(row.id) && !out[row.id] && keys(row.remotes).includes(key));
      if (found.length !== 1) continue;
      out[found[0].id] = project.id;
      break;
    }
  }
  return out;
}

export type CredKind = "password" | "token" | "ssh-key";
// passphrase: an SSH key that is locked with one. Its value is read under the name plus PASSPHRASE_OF.
export type CredMeta = { name: string; kind: CredKind; username: string; host: string; passphrase?: boolean };
export const PASSPHRASE_OF = "#passphrase";

export const credEnvName = (name: string) => `DESK_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

const CRED_TOOL = /(^|[\s;&|(])desk-(ssh|scp|sftp|git|telnet)[ \t]+([A-Za-z0-9][\w-]*)/g;
const CRED_ENV = /\bDESK_SECRET_[A-Z0-9_]+\b/g;

export function credNameRefusal(name: string, kept: CredMeta[]): string | null {
  if (!/^[A-Za-z0-9][\w-]{0,63}$/.test(name)) return "Use a name of letters, numbers, dashes or underscores, up to 64 characters.";
  const clash = kept.find((c) => c.name !== name && credEnvName(c.name) === credEnvName(name));
  return clash ? `That name is too close to ${clash.name}.` : null;
}

export type CredPlan = {
  names: string[];
  command: string;
  // Filled from a one-time file, so the value is never part of any command text.
  reads: Array<{ env: string; name: string }>;
  set: Array<[string, string]>;
  keys: string[];
};

// Turns a command that names saved logins into one that uses them. The command keeps names only; the secrets arrive
// through environment variables, for this command alone. Returns a message to give the agent when it cannot be done.
export function planCredentials(
  command: string,
  shell: "Bash" | "PowerShell",
  creds: CredMeta[],
  bin: { askpass: string; telnet: string; keyFile: (name: string) => string },
): CredPlan | { error: string } | null {
  const named = (name: string) => creds.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const tools = [...command.matchAll(CRED_TOOL)];
  const refs = [...new Set(command.match(CRED_ENV) ?? [])];
  if (!tools.length && !refs.length) return null;
  const list = creds.length ? creds.map((c) => c.name).join(", ") : "none saved";
  const plan: CredPlan = { names: [], command, reads: [], set: [], keys: [] };
  const use = (name: string) => {
    if (!plan.names.includes(name)) plan.names.push(name);
  };
  const read = (env: string, name: string) => {
    if (!plan.reads.some((r) => r.env === env)) plan.reads.push({ env, name });
  };
  const set = (key: string, value: string) => {
    if (!plan.set.some(([k]) => k === key)) plan.set.push([key, value]);
  };
  for (const env of refs) {
    const cred = creds.find((c) => credEnvName(c.name) === env);
    if (!cred) return { error: `No saved login matches ${env}. Saved logins: ${list}. The user adds them in Settings.` };
    use(cred.name);
    read(env, cred.name);
  }
  // One password per command: the helper that answers the prompt can only hold one.
  let answering = "";
  for (const [, , tool, name] of tools) {
    const cred = named(name);
    if (!cred) return { error: `No saved login named ${name}. Saved logins: ${list}. The user adds them in Settings.` };
    use(cred.name);
    if (cred.kind === "ssh-key") {
      if (tool === "telnet") return { error: `${cred.name} is an SSH key, so it cannot log in over telnet.` };
      if (!plan.keys.includes(cred.name)) plan.keys.push(cred.name);
      if (!cred.passphrase) continue;
    }
    if (answering && answering !== cred.name) return { error: `One command can use one saved password. Split the use of ${answering} and ${cred.name} into separate commands.` };
    answering = cred.name;
  }
  const quoteFile = (file: string) => `"${shell === "Bash" ? file.replace(/\\/g, "/") : file}"`;
  plan.command = command.replace(CRED_TOOL, (_m, lead: string, tool: string, name: string) => {
    const cred = named(name)!;
    if (tool === "telnet") {
      read("DESK_TELNET_SECRET", cred.name);
      if (cred.username) set("DESK_TELNET_USER", cred.username);
      return `${lead}${shell === "PowerShell" ? "& " : ""}${quoteFile(bin.telnet)}`;
    }
    // A function: asking for the path writes the key to its one-time file, which only a key may do.
    const keyFlags = () => `-i ${quoteFile(bin.keyFile(cred.name))} -o IdentitiesOnly=yes`;
    // ssh asks the helper for a key's passphrase the same way it asks for a password.
    if (cred.kind === "ssh-key" && cred.passphrase) {
      read("DESK_ASKPASS_SECRET", `${cred.name}${PASSPHRASE_OF}`);
      set("SSH_ASKPASS", bin.askpass);
      set("SSH_ASKPASS_REQUIRE", "force");
    }
    if (tool === "git") {
      if (cred.kind === "ssh-key") set("GIT_SSH_COMMAND", `ssh ${keyFlags()}`);
      else {
        read("DESK_ASKPASS_SECRET", cred.name);
        set("DESK_ASKPASS_USER", cred.username || "x-access-token");
        set("GIT_ASKPASS", bin.askpass);
        set("GIT_TERMINAL_PROMPT", "0");
      }
      return `${lead}git`;
    }
    if (cred.kind === "ssh-key") return `${lead}${tool} ${keyFlags()}`;
    read("DESK_ASKPASS_SECRET", cred.name);
    set("SSH_ASKPASS", bin.askpass);
    set("SSH_ASKPASS_REQUIRE", "force");
    // A wrong password tried once rather than three times, so it does not lock the account on network gear.
    return `${lead}${tool} -o NumberOfPasswordPrompts=1`;
  });
  return plan;
}

// The shell lines that load a one-time file into a variable and delete it, or set a plain value.
export function credLoadLine(shell: "Bash" | "PowerShell", env: string, file: string): string {
  if (shell === "Bash") {
    const f = file.replace(/\\/g, "/").replace(/'/g, `'\\''`);
    return `export ${env}="$(cat '${f}')"; rm -f '${f}'`;
  }
  const f = file.replace(/'/g, "''");
  return `$env:${env} = [IO.File]::ReadAllText('${f}'); Remove-Item -LiteralPath '${f}' -Force`;
}

export function credSetLine(shell: "Bash" | "PowerShell", key: string, value: string): string {
  return shell === "Bash" ? `export ${key}='${value.replace(/'/g, `'\\''`)}'` : `$env:${key} = '${value.replace(/'/g, "''")}'`;
}

// Pairs projects that have no folder here with git repositories found on this computer. Only a match without doubt
// links: a project on two found folders, or two projects on one remote, wait for the user.
export function matchLocalRepos(
  projects: Array<{ id: string; path: string; placed: boolean; remotes: string[] }>,
  found: Array<{ path: string; remote: string }>,
): { links: Array<{ id: string; path: string }>; unsure: string[] } {
  const keys = (remotes: string[]) => remotes.map(remoteKey).filter(Boolean);
  const taken = new Set(projects.filter((p) => p.placed).map((p) => p.path.toLowerCase()));
  const links: Array<{ id: string; path: string }> = [];
  const unsure: string[] = [];
  for (const project of projects) {
    if (project.placed) continue;
    const mine = keys(project.remotes);
    const paths = found.filter((f) => mine.includes(remoteKey(f.remote)) && !taken.has(f.path.toLowerCase())).map((f) => f.path);
    if (!paths.length) continue;
    const shared = projects.some((p) => p !== project && !p.placed && keys(p.remotes).some((k) => mine.includes(k)));
    if (shared || paths.length > 1) unsure.push(project.id);
    else links.push({ id: project.id, path: paths[0] });
  }
  return { links, unsure };
}

// A folder the sidebar must never offer to delete. Comparison ignores case and slash direction, as Windows does.
export function deleteFolderRefusal(
  target: string,
  guard: { home: string; keep: string[]; projects: string[]; running: boolean },
): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dir = norm(target);
  const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);
  if (!dir || !dir.includes("/") || /^[a-z]:$/.test(dir)) return "That is a whole drive, so it was not deleted.";
  if (holds(dir, norm(guard.home))) return "That folder holds your home folder, so it was not deleted.";
  if (guard.keep.some((k) => holds(dir, norm(k)))) return "AgenticOps Desk runs from or keeps its data in that folder, so it was not deleted.";
  const inside = guard.projects.filter((p) => norm(p) !== dir && holds(dir, norm(p)));
  if (inside.length) return `That folder holds ${inside.length} other project${inside.length === 1 ? "" : "s"}, so it was not deleted. Delete them one at a time.`;
  if (guard.running) return "A chat is running in that project. Stop it first.";
  return null;
}

// What would be lost with a folder if the Recycle Bin were emptied, in plain words for the confirmation.
export function deleteWarnings(state: { repo: boolean; remote: boolean; dirty: number; unpushed: number; stashed: number }): string[] {
  if (!state.repo) return ["It is not a git repository, so this may be the only copy."];
  const out: string[] = [];
  if (!state.remote) out.push("It has no remote, so this is the only copy of its history.");
  if (state.dirty) out.push(`${state.dirty} file${state.dirty === 1 ? " has" : "s have"} changes that are not committed.`);
  if (state.unpushed) out.push(`${state.unpushed} commit${state.unpushed === 1 ? " is" : "s are"} not pushed anywhere.`);
  if (state.stashed) out.push(`${state.stashed} stash${state.stashed === 1 ? " is" : "es are"} saved only here.`);
  return out;
}

// ---------- Saved logins in shell commands
// The agent writes a login's name; the value never enters the command text, where logs and quoting could get at it.
// Each value is read from a one-time file at the top of the command, into a variable only that command gets.

export type LoginRow = { name: string; kind: "password" | "token" | "ssh-key"; username: string };
export type LoginShell = "Bash" | "PowerShell";

export const LOGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOGIN_TOOL = /(?<![\w./\\-])desk-(ssh|scp|sftp|git|telnet)\s+([^\s"';&|()]+)/g;
const LOGIN_VAR = /\bDESK_SECRET_[A-Z0-9_]+\b/g;

export function loginVar(name: string): string {
  return `DESK_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function findLogins(command: string, rows: LoginRow[]): { names: string[]; missing: string[] } {
  const names = new Set<string>();
  const missing = new Set<string>();
  for (const match of command.matchAll(LOGIN_TOOL)) {
    const row = rows.find((r) => r.name === match[2]);
    if (row) names.add(row.name);
    else missing.add(match[2]);
  }
  for (const [word] of command.matchAll(LOGIN_VAR)) {
    const row = rows.find((r) => loginVar(r.name) === word);
    if (row) names.add(row.name);
    else missing.add(word);
  }
  return { names: [...names], missing: [...missing] };
}

export function rewriteLoginCommand(
  command: string,
  shell: LoginShell,
  rows: LoginRow[],
  helper: string,
  fileFor: (name: string) => string,
): { command: string } | { error: string } {
  const quote = (s: string) => (shell === "Bash" ? `'${s.replace(/'/g, `'\\''`)}'` : `'${s.replace(/'/g, "''")}'`);
  const set = (name: string, value: string) => (shell === "Bash" ? `export ${name}=${quote(value)}` : `$env:${name} = ${quote(value)}`);
  const read = (name: string, file: string) =>
    shell === "Bash"
      ? `export ${name}="$(cat ${quote(file)})"; rm -f ${quote(file)}`
      : `$env:${name} = Get-Content -Raw -Encoding UTF8 -LiteralPath ${quote(file)}; Remove-Item -LiteralPath ${quote(file)}`;
  const keyFiles = new Map<string, string>();
  const keyFile = (name: string) => keyFiles.get(name) ?? keyFiles.set(name, fileFor(name)).get(name)!;
  const prefix: string[] = [];
  let answering = "";
  let problem = "";
  const answerWith = (row: LoginRow) => {
    // The helper answers one login's prompts, so two would be ambiguous.
    if (answering && answering !== row.name) problem = "Use one saved login per command: run them as separate commands.";
    if (answering) return;
    answering = row.name;
    prefix.push(read("DESK_ASKPASS_SECRET", fileFor(row.name)), set("DESK_ASKPASS_USER", row.username));
  };
  const out = command.replace(LOGIN_TOOL, (whole, tool: string, name: string) => {
    const row = rows.find((r) => r.name === name);
    if (!row) return whole;
    const isKey = row.kind === "ssh-key";
    if (tool === "telnet") {
      if (isKey) problem = `${name} is an SSH key, which telnet cannot use.`;
      else answerWith(row);
      return `${shell === "Bash" ? "" : "& "}${quote(helper)} telnet`;
    }
    if (tool === "git") {
      if (isKey) prefix.push(set("GIT_SSH_COMMAND", `ssh -i "${keyFile(name)}" -o IdentitiesOnly=yes`));
      else {
        answerWith(row);
        prefix.push(set("GIT_ASKPASS", helper), set("GIT_TERMINAL_PROMPT", "0"));
      }
      // Cleared so a credential manager on this computer cannot answer with a different account.
      return `git -c credential.helper=`;
    }
    if (isKey) return `${tool} -i ${quote(keyFile(name))} -o IdentitiesOnly=yes`;
    answerWith(row);
    prefix.push(set("SSH_ASKPASS", helper), set("SSH_ASKPASS_REQUIRE", "force"));
    // One wrong try per connection, so a bad saved password cannot lock an account out.
    return `${tool} -o NumberOfPasswordPrompts=1`;
  });
  if (problem) return { error: problem };
  for (const [word] of new Set(out.matchAll(LOGIN_VAR))) {
    if (prefix.some((line) => line.includes(`${word}=`) || line.startsWith(`$env:${word} `))) continue;
    const row = rows.find((r) => loginVar(r.name) === word);
    if (row) prefix.push(read(word, fileFor(row.name)));
  }
  return { command: [...new Set(prefix), out].join("\n") };
}

export type CleanupRow = { id: string; name: string; path: string; exists: boolean; chats: number };
export type CleanupProposal = { from: CleanupRow; to: CleanupRow; bothExist: boolean };

// Same folder name in two places. A folder that is gone was probably moved. Two live folders may be separate copies,
// so those are only offered, for the user to decide.
export function cleanupProposals(rows: CleanupRow[]): CleanupProposal[] {
  const byName = new Map<string, CleanupRow[]>();
  for (const row of rows) {
    if (!row.path) continue;
    const name = row.path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  const out: CleanupProposal[] = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const live = group.filter((row) => row.exists).sort((a, b) => b.chats - a.chats);
    if (live.length === 1) {
      for (const row of group) if (!row.exists && row.chats) out.push({ from: row, to: live[0], bothExist: false });
    } else if (live.length === 2 && group.length === 2 && live[1].chats) {
      out.push({ from: live[1], to: live[0], bothExist: true });
    }
  }
  return out;
}

// A project with no folder and no chats is leftover from a scan. A live empty folder stays, so a new project can.
export function emptyGoneProjectIds(rows: Array<{ id: string; exists: boolean; chats: number }>): string[] {
  return rows.filter((row) => !row.exists && row.chats === 0).map((row) => row.id);
}

// Runs one at a time. Calls that arrive during a run share one follow-up run, which sees everything they wanted saved.
export function oneAtATime<T>(work: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const call = (): Promise<T> => {
    if (running) {
      next ??= running.then(
        () => ((next = null), call()),
        () => ((next = null), call()),
      );
      return next;
    }
    running = work().finally(() => {
      running = null;
    });
    return running;
  };
  return call;
}

// Why Cursor's folders can't be deleted right now, or null. A failed copy could mean losing the only one.
export function cursorRemovalRefusal(state: { mode: string; running: boolean; errors: string[] }): string | null {
  if (state.mode !== "github") return "Nothing was deleted, because Cursor keeps its files unless chats are set to GitHub.";
  if (state.errors.length) return `Nothing was deleted, because copying failed: ${state.errors.slice(0, 3).join("; ")}`;
  if (state.running) return "Nothing was deleted, because Cursor is still running. Close it and try again.";
  return null;
}

function versionParts(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((n) => Number(/^(\d+)/.exec(n)?.[1] ?? 0));
}

export function isNewerVersion(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// Plain v1.2.3 only: patch manifests carry a plain version. Beta is the prerelease flag on the GitHub release.
export function isReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

// Where a path lands after shortcuts. A file that does not exist yet keeps its name under the nearest real parent,
// so creating notes\new.txt through a link is judged by where that link points.
function landed(target: string): string {
  let cur = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.push(path.basename(cur));
    cur = parent;
  }
  try {
    cur = realpathSync(cur);
  } catch {
    /* gone between the exists check and the resolve */
  }
  return rest.length ? path.join(cur, ...rest.reverse()) : cur;
}

// True when target is root, or a file inside it, after links and junctions are followed.
export function staysInside(root: string, target: string, allowRoot = true): boolean {
  if (!root || !target) return false;
  const rel = path.relative(landed(root), landed(target));
  if (rel === "") return allowRoot;
  // A folder named "..x" is inside; only ".." itself or "../" leaves.
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// The newest vX.Y.Z tag after current. Annotated tags arrive twice; the peeled name is the same tag.
export function newestTag(refs: string[], current: string): string | null {
  const here = current.startsWith("v") ? current : `v${current}`;
  let best = "";
  const seen = new Set<string>();
  for (const ref of refs) {
    const tag = ref.trim().replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (!isReleaseTag(tag) || seen.has(tag)) continue;
    seen.add(tag);
    if (!isNewerVersion(tag, here)) continue;
    if (!best || isNewerVersion(tag, best)) best = tag;
  }
  return best || null;
}

// The command that starts a project's dev server: its dev, start or serve script, run by the package manager
// its lockfile names.
export function devServerCommand(pkg: unknown, files: string[]): string | null {
  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const name = ["dev", "start", "serve"].find((s) => typeof scripts[s] === "string");
  if (!name) return null;
  const has = (f: string) => files.includes(f);
  if (has("pnpm-lock.yaml")) return `pnpm run ${name}`;
  if (has("yarn.lock")) return `yarn ${name}`;
  if (has("bun.lockb") || has("bun.lock")) return `bun run ${name}`;
  return `npm run ${name}`;
}

// One chat changed on two computers. local is this computer's thread, localHidden the same with secrets hidden as the
// repository holds it, remote the repository's copy. One side extending the other takes the extension when it is
// newer and keeps local otherwise (a rewind here). Two sides that both added keep both, local first.
export function mergeThreads(local: unknown[], localHidden: unknown[], remote: unknown[], remoteNewer: boolean): unknown[] {
  const key = (m: unknown) => {
    const { role, text } = (m ?? {}) as { role?: unknown; text?: unknown };
    return JSON.stringify([role, text]);
  };
  let p = 0;
  while (p < localHidden.length && p < remote.length && key(localHidden[p]) === key(remote[p])) p++;
  if (p === localHidden.length && p === remote.length) return local;
  if (p === localHidden.length) return remoteNewer ? [...local.slice(0, p), ...remote.slice(p)] : local;
  if (p === remote.length) return remoteNewer ? local.slice(0, p) : local;
  return [...local, ...remote.slice(p)];
}

export type ImportedChat = { id: string; cwd: string; title: string; updatedAt: number; messages: Array<{ role: "user" | "assistant"; text: string }> };

function pushTurn(messages: ImportedChat["messages"], role: "user" | "assistant", text: string) {
  const clean = text.trim();
  if (!clean) return;
  const last = messages[messages.length - 1];
  if (last?.role === role) last.text += `\n\n${clean}`;
  else messages.push({ role, text: clean });
}

// A Claude Code session file (one JSON object per line). Only sessions typed in the terminal (entrypoint "cli") count:
// SDK sessions belong to the app that ran them, this one included.
export function parseClaudeSession(lines: string[]): ImportedChat | null {
  let id = "";
  let cwd = "";
  let entrypoint = "";
  let aiTitle = "";
  let customTitle = "";
  let updatedAt = 0;
  const messages: ImportedChat["messages"] = [];
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string") aiTitle = row.aiTitle;
    if (row.type === "custom-title" && typeof row.customTitle === "string") customTitle = row.customTitle;
    if ((row.type !== "user" && row.type !== "assistant") || row.isSidechain || row.isMeta) continue;
    if (typeof row.sessionId === "string") id ||= row.sessionId;
    if (typeof row.cwd === "string") cwd ||= row.cwd;
    if (typeof row.entrypoint === "string") entrypoint ||= row.entrypoint;
    const at = Date.parse(String(row.timestamp ?? ""));
    if (at > updatedAt) updatedAt = at;
    const content = (row.message as { content?: unknown } | undefined)?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
          : "";
    if (row.type === "user" && /^<(command-|local-command-)/.test(text.trim())) continue;
    pushTurn(messages, row.type, text);
  }
  if (!id || !cwd || entrypoint !== "cli" || !messages.length) return null;
  const first = messages.find((m) => m.role === "user")?.text ?? "Claude Code session";
  return { id, cwd, title: (customTitle || aiTitle || first).slice(0, 80), updatedAt, messages };
}

// A VS Code chat session file (chatSessions/*.json). Responses are lists of parts; only text parts are kept.
export function parseCopilotSession(json: unknown, cwd: string, fallbackId: string): ImportedChat | null {
  if (!json || typeof json !== "object") return null;
  const s = json as { sessionId?: unknown; customTitle?: unknown; lastMessageDate?: unknown; creationDate?: unknown; requests?: unknown };
  if (!Array.isArray(s.requests)) return null;
  const messages: ImportedChat["messages"] = [];
  for (const req of s.requests as Array<Record<string, unknown>>) {
    const asked = (req?.message as { text?: unknown } | undefined)?.text;
    pushTurn(messages, "user", typeof asked === "string" ? asked : "");
    const parts = Array.isArray(req?.response) ? (req.response as Array<Record<string, unknown>>) : [];
    const answer = parts
      .map((p) => (typeof p?.value === "string" ? p.value : typeof (p?.content as { value?: unknown })?.value === "string" ? String((p.content as { value: string }).value) : ""))
      .join("");
    pushTurn(messages, "assistant", answer);
  }
  if (!messages.length) return null;
  const id = typeof s.sessionId === "string" && s.sessionId ? s.sessionId : fallbackId;
  const first = messages.find((m) => m.role === "user")?.text ?? "Copilot chat";
  const updatedAt = Number(s.lastMessageDate) || Number(s.creationDate) || 0;
  return { id, cwd, title: (typeof s.customTitle === "string" && s.customTitle ? s.customTitle : first).slice(0, 80), updatedAt, messages };
}

export type McpServerConfig = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

// The mcpServers object of a .mcp.json or ~/.claude.json, keeping only entries that can be started or reached.
export function mcpServersIn(json: unknown): Record<string, McpServerConfig> {
  const raw = json && typeof json === "object" ? (json as { mcpServers?: unknown }).mcpServers : null;
  const out: Record<string, McpServerConfig> = {};
  if (!raw || typeof raw !== "object") return out;
  const strings = (v: unknown) => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, s]) => typeof s === "string")) : undefined);
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w.-]{1,40}$/.test(name) || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.command === "string" && v.command.trim()) {
      out[name] = {
        command: v.command,
        args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [],
        env: strings(v.env) as Record<string, string> | undefined,
      };
    } else if (typeof v.url === "string" && /^https?:\/\//i.test(v.url)) {
      out[name] = { type: v.type === "sse" ? "sse" : "http", url: v.url, headers: strings(v.headers) as Record<string, string> | undefined };
    }
  }
  return out;
}

// ${VAR} and ${VAR:-default}, as in Claude Code's MCP config.
export function expandMcpEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => env[name] ?? fallback ?? "");
}

// mcp__server__tool, within the 64 characters and character set every provider accepts.
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

// ops_triage runs without a permission prompt, so it takes only commands that can't change anything or read
// outside the repository. Returns the argument list, or null to refuse.
const BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--verbose", "--show-current"]);
const GIT_UNSAFE = /^--(?:output|no-index|ext-diff|textconv)(?:=|$)/i;
export function readOnlyOpsCommand(command: string): string[] | null {
  const cmd = command.trim();
  if (!cmd || cmd.length > 400 || /[;&|`<>$\r\n]/.test(cmd)) return null;
  const args = cmd.split(/\s+/);
  const [bin, sub, sub2] = args.map((a) => a.toLowerCase());
  if (args.some((a) => /^[^a-zA-Z0-9._\/=:@~^-]/.test(a))) return null;
  if (bin === "git") {
    // A path outside the repository makes git diff compare any two files, as --no-index does.
    const outside = (a: string) => /^(?:[\\/~]|[a-z]:)/i.test(a) || /(?:^|[\\/=])\.\.(?:[\\/]|$)/.test(a);
    if (args.slice(1).some((a) => GIT_UNSAFE.test(a) || outside(a))) return null;
    if (["status", "log", "show", "diff", "rev-parse"].includes(sub)) return args;
    if (sub === "stash" && sub2 === "list") return args;
    if (sub === "remote") return args.length === 3 && sub2 === "-v" ? args : null;
    if (sub === "branch") return args.slice(2).every((a) => BRANCH_FLAGS.has(a)) ? args : null;
    return null;
  }
  if (bin !== "gh") return null;
  if (args.some((a) => /^(?:-t|--show-token|--hostname)/i.test(a))) return null;
  if (sub === "status" && !sub2) return args;
  if (sub === "auth" && sub2 === "status") return args;
  if ((sub === "run" && (sub2 === "list" || sub2 === "view")) || (sub === "release" && sub2 === "list")) return args;
  if (sub === "api" && /^repos?\/[^/]+\/[^/]+\/actions\/runs(?:\/\d+(?:\/jobs)?)?(?:\?[\w=&.-]*)?$/i.test(args[2] ?? "")) {
    // GET only: no method, fields or input. --jq takes one expression after it.
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--paginate") continue;
      if ((args[i] === "--jq" || args[i] === "-q") && args[i + 1] && !args[i + 1].startsWith("-")) {
        i++;
        continue;
      }
      return null;
    }
    return args;
  }
  return null;
}

export type PatchManifest = {
  version: string;
  shell: string;
  tar: string;
  files: Array<{ path: string; sha256: string }>;
  // Setup file name -> SHA-256. The setups aren't code-signed, so this signed list is what vouches for them.
  installers?: Record<string, string>;
};

// The setup for this chip in a signed manifest for tag, or a reason it can't be used.
export function installerFor(manifest: PatchManifest, tag: string, arch: string): { name: string; sha256: string } | string {
  if (`v${manifest.version}` !== tag || !isReleaseTag(tag)) return "The update's manifest is for another version.";
  const name = `AgenticOps-Desk-${manifest.version}-win-${arch}-setup.exe`;
  const sha256 = manifest.installers?.[name];
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return `${tag} has no installer for this computer. Download it from the release page.`;
  return { name, sha256 };
}

// A patch only replaces code, so Electron and the installed packages have to be what it was built against.
export function patchShell(electron: string, dependencies: Record<string, string>): string {
  return `${electron}|${JSON.stringify(dependencies)}`;
}

// Why this signed manifest can't be applied, or null. Signed or not, nothing may write outside the patch's own folder.
export function patchRefusal(manifest: PatchManifest, here: { current: string; shell: string; bad: string[] }): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !isNewerVersion(manifest.version, here.current)) return "This copy is already up to date.";
  if (here.bad.includes(manifest.version)) return `Update ${manifest.version} failed to start here earlier.`;
  if (manifest.shell !== here.shell) return "The update changes more than the app's own code.";
  const entry = /^dist-electron\/main\.js$/;
  const safe = (p: string) => /^(dist|dist-electron)\/[\w.@~+/-]+$/.test(p) && !p.split("/").includes("..");
  const bad = manifest.files.find((f) => !safe(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256));
  if (bad) return `The update lists an unsafe file: ${bad.path}.`;
  if (!manifest.files.some((f) => entry.test(f.path))) return "The update is missing the app's entry file.";
  return null;
}

export function slugFromResolved(resolved: string): string {
  return resolved.replace(/^[A-Za-z]:/, (m) => m[0].toLowerCase()).replace(/[^A-Za-z0-9]+/g, "-");
}

// Deletions carry the time they happened; the newest timestamp wins for the same id. Formats without a time are
// treated as now. `a` is local, `b` is the remote copy.
export function mergeDeleted(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = new Map<string, number>();
  for (const [id, at] of Object.entries(a)) if (id && ((out.get(id) ?? 0) < at)) out.set(id, at);
  for (const [id, at] of Object.entries(b)) if (id && ((out.get(id) ?? 0) < at)) out.set(id, at);
  return Object.fromEntries(out);
}

// Accepts the older deleted.json shape (a plain list of ids) for backward compatibility.
export function asDeleted(raw: unknown): Record<string, number> {
  if (Array.isArray(raw)) {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const id of raw) if (typeof id === "string" && id) out[id] = now;
    return out;
  }
  if (raw && typeof raw === "object") {
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(raw)) if (id && typeof at === "number" && at > 0) out[id] = at;
    return out;
  }
  return {};
}

// Newer updatedAt wins, except the project: only a move changes that, so using a chat on an old computer can't undo one.
// A deleted id stays deleted on every computer, whatever its updatedAt: ids are never reused, so this can't hide a new chat.
export function mergeChats(local: SyncChat[], incoming: SyncChat[], deleted: Record<string, number>): SyncChat[] {
  const gone = new Set(Object.keys(deleted));
  const map = new Map<string, SyncChat>();
  for (const chat of [...local, ...incoming]) {
    if (!chat?.id || gone.has(chat.id)) continue;
    const prev = map.get(chat.id);
    if (!prev) {
      map.set(chat.id, chat);
      continue;
    }
    const [older, newer] = (chat.updatedAt ?? 0) >= (prev.updatedAt ?? 0) ? [prev, chat] : [chat, prev];
    const [earlier, moved] = (chat.projectMovedAt ?? 0) >= (prev.projectMovedAt ?? 0) ? [prev, chat] : [chat, prev];
    map.set(chat.id, {
      ...older,
      ...newer,
      title: newer.title || older.title || "",
      projectId: moved.projectId ?? earlier.projectId ?? null,
      projectMovedAt: moved.projectMovedAt ?? earlier.projectMovedAt,
      projectName: moved.projectName || earlier.projectName || "",
    });
  }
  return [...map.values()];
}

// Chat models from a provider's /models list. Drops embeddings, images, audio and the rest.
// shortcut: first 20 only, raise the cap if the menu needs the long tail.
// Gemini streams a function call without OpenAI's index. A later piece of the same call has no name.
export function streamToolIndex(index: number | undefined, hasName: boolean, open: number): number {
  if (typeof index === "number" && index >= 0) return index;
  return hasName || open === 0 ? open : open - 1;
}

export function chatModelIds(ids: string[], limit = 20): string[] {
  const skip = /embed|whisper|tts|dall-e|moderation|transcri|realtime|\baudio\b|\bimage\b|\bspeech\b|\bsora\b/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().replace(/^models\//, "");
    if (!id || id.length > 80 || seen.has(id) || skip.test(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

// Names the model menu shows before a provider's own list replaces them.
export const PROVIDER_CATALOGS: Record<string, Array<{ id: string; name: string }>> = {
  openai: [
    { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
    { id: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
  ],
  gemini: [
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "gemini-4-neon", name: "Gemini 4 Neon" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ],
  xai: [{ id: "grok-4.7", name: "Grok 4.7" }],
  mistral: [
    { id: "mistral-large-4", name: "Mistral Large 4" },
    { id: "codestral-2508", name: "Codestral" },
  ],
  qwen: [{ id: "qwen4-max", name: "Qwen4 Max" }],
};

export function isCustomProviderId(id: string): boolean {
  return /^u[a-z0-9]{4,12}$/.test(id);
}

// Old DeepSeek turns stored a chain of thought. Sending it back makes every later command slower.
export function stripDeepSeekReasoning(messages: Array<{ reasoning_content?: string }>): void {
  for (const message of messages) delete message.reasoning_content;
}

// Commits made from AgenticOps Desk carry the git login plus where they came from ("me-desktop"), not the agent's name.
// The email stays the user's own (or their GitHub no-reply address), so the host still links the commit to them.
export function deviceGitIdentity(login: string, email: string, device: "desktop" | "mobile", githubId?: string): { name: string; email: string } {
  const base = login.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  const mail = email.trim() || (githubId ? `${githubId}+${base}@users.noreply.github.com` : `${base}+${device}@users.noreply.github.com`);
  return { name: `${base}-${device}`, email: mail };
}

// A message typed on the phone (inbox/<id>.json on a project's desk-chats branch). It runs on this computer, so anything
// malformed is refused. No chat = start a new chat with that title. host = the computer it is meant for; empty = any.
export type PhoneMessage = { chat?: string; title?: string; text: string; host?: string };
export function parsePhoneMessage(value: unknown): PhoneMessage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const text = typeof v.text === "string" ? v.text.trim() : "";
  if (!text || text.length > 50_000) return null;
  const chat = typeof v.chat === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(v.chat) ? v.chat : undefined;
  if (v.chat !== undefined && !chat) return null;
  const title = typeof v.title === "string" ? v.title.trim().slice(0, 80) || undefined : undefined;
  const host = typeof v.host === "string" && /^[\w.-]{1,100}$/.test(v.host) ? v.host : undefined;
  return { chat, title, text, host };
}

// Phone pairing second factor: the QR holds the token encrypted under a one-time 8-digit code that only the desk screen shows,
// so a photo of the QR alone is useless. Format: "ADPAIR2 <login> <id> <salt>.<iv>.<ciphertext+tag>" (base64url); opened in mobile/github.ts.
// shortcut: the code is on the same screen as the QR, so a photo of both defeats it; upgrade to a TOTP the phone enrolls once.
export const PAIR_KDF_ROUNDS = 300_000;
// The sealed text is the token, then (if any) a newline and the space-separated owner/name repos the phone should show.
export function sealPairing(login: string, id: string, token: string, code: string, repos: string[] = []): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(code, salt, PAIR_KDF_ROUNDS, 32, "sha256");
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(repos.length ? `${token}\n${repos.join(" ")}` : token, "utf8"), c.final(), c.getAuthTag()]);
  return `ADPAIR2 ${login} ${id} ${[salt, iv, ct].map((b) => b.toString("base64url")).join(".")}`;
}
export function newPairCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}
