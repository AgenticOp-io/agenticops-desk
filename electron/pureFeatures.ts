import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

// Electron-free helpers for standing orders, org memory and the second opinion, so plain Node can test them.

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
  /\b(?:api error|status|error|http)\W{0,3}(?:429|5\d\d)\b|rate.?limit|usage limit|overloaded|quota|credit balance|billing|insufficient|too many requests|capacity|rejected the api key|invalid api key|add an api key|not logged in|\/login|authentication|unauthori[sz]ed|declined this request|connection error|could not connect|econnrefused|econnreset|enotfound|etimedout|fetch failed|network error|timed out|stalled|no (claude code|agent engine) build|(claude code|agent engine) (was )?not found|model\b.*\b(not found|does not exist|not available)|local only is on/i;

export function shouldFailOver(error: string): boolean {
  return FAILOVER.test(error);
}

// What Auto does with one event of a run it routes: let it through, hide a provider error so the next AI
// can try, end the run, or hand the message over (the run ended after a hidden error).
export function autoStep(
  run: { queue: string[]; failed?: string; erred?: boolean },
  kind: string,
  text = "",
): "pass" | "swallow" | "finish" | "handover" {
  if (kind === "error" && text && !run.failed && run.queue.length && shouldFailOver(text)) {
    run.failed = text;
    return "swallow";
  }
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
  return /429|rate.?limit|usage limit|quota|credit balance|too many requests/i.test(error) ? 5 * 60_000 : 60_000;
}

// The order Auto tries models in: the chat's last good one first (keeps its context), then the user's
// order. Models resting after a failure go last instead of being dropped, so Auto never has nothing to try.
export function autoOrder(opts: {
  chosen: string[];
  available: string[];
  sticky?: string;
  restingUntil: Record<string, number>;
  now: number;
}): string[] {
  const avail = new Set(opts.available);
  const base = (opts.chosen.length ? opts.chosen : opts.available).filter((m) => avail.has(m));
  const list = [...new Set(opts.sticky && base.includes(opts.sticky) ? [opts.sticky, ...base] : base)];
  const resting = (m: string) => (opts.restingUntil[m] ?? 0) > opts.now;
  return [...list.filter((m) => !resting(m)), ...list.filter(resting)];
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
  return !rel.startsWith("..") && !path.isAbsolute(rel);
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

// Deletions carry the time they happened, so a stale deletion on one computer cannot wipe a chat that was
// updated after it. The newest timestamp wins for the same id; formats without a time are treated as now
// (still destructive, but only for genuinely fresh deletions). `a` is local, `b` is the remote copy.
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
// A deleted id stays deleted on every computer, but only a deletion newer than the chat itself removes it.
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
export function chatModelIds(ids: string[]): string[] {
  const skip = /embed|whisper|tts|dall-e|moderation|transcri|realtime|\baudio\b|\bimage\b|\bspeech\b|\bsora\b/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || id.length > 80 || seen.has(id) || skip.test(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

// Old DeepSeek turns stored a chain of thought. Sending it back makes every later command slower.
export function stripDeepSeekReasoning(messages: Array<{ reasoning_content?: string }>): void {
  for (const message of messages) delete message.reasoning_content;
}
