import path from "node:path";

// Electron-free helpers for standing orders, org memory and the second opinion, so plain Node can test them.

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

// host/owner/repo, lowercased, so the same remote matches on every computer.
export function remoteKey(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const https = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  const scp = /^git@([^:]+):([^/]+)\/([^/]+)$/i.exec(trimmed);
  const hit = https
    ? { host: https[1], owner: https[2], repo: https[3] }
    : scp
      ? { host: scp[1], owner: scp[2], repo: scp[3] }
      : null;
  if (!hit) return null;
  const host = hit.host.toLowerCase();
  const owner = hit.owner.replace(/[^\w.-]/g, "").toLowerCase();
  const repo = hit.repo.replace(/[^\w.-]/g, "").toLowerCase();
  if (!host || !owner || !repo) return null;
  return `${host}/${owner}/${repo}`;
}

// Sync travels over https or ssh. A local path or cleartext http URL is rejected.
export function allowedGitRemote(url: string): boolean {
  const s = url.trim();
  if (!remoteKey(s) || /[\s"'`]/.test(s) || s.startsWith("-")) return false;
  return /^https:\/\//i.test(s) || /^git@/i.test(s) || /^ssh:\/\//i.test(s);
}

export type SyncProject = { remote: string; name: string; branch?: string };

export type SyncChat = {
  id: string;
  title: string;
  updatedAt: number;
  lastUsedAt?: number;
  projectRemote: string | null;
  projectName: string;
  slug?: string;
  pinned?: boolean;
  mode?: string;
  model?: string;
  parentId?: string;
  size?: number;
};

// Layout and folder paths differ per computer. Everything else in settings can travel.
const SYNC_PREFS = ["windowFont", "itemFont", "hiddenChats", "showCode", "theme", "reviewer", "autoModels", "autocomplete", "privacy"] as const;

export function portablePrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SYNC_PREFS) if (key in prefs) out[key] = prefs[key];
  return out;
}

export function mergeProjects(a: SyncProject[], b: SyncProject[]): SyncProject[] {
  const map = new Map<string, SyncProject>();
  for (const project of [...a, ...b]) {
    const key = remoteKey(project.remote);
    if (!key || !project.remote) continue;
    const prev = map.get(key);
    map.set(key, prev ? { remote: project.remote || prev.remote, name: project.name || prev.name, branch: project.branch || prev.branch } : project);
  }
  return [...map.values()];
}

export function mergeDeleted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b].filter((id) => typeof id === "string" && id.length > 0))];
}

// Newer updatedAt wins. A deleted id stays deleted on every computer.
export function mergeChats(local: SyncChat[], incoming: SyncChat[], deleted: string[]): SyncChat[] {
  const gone = new Set(deleted);
  const map = new Map<string, SyncChat>();
  for (const chat of [...local, ...incoming]) {
    if (!chat?.id || gone.has(chat.id)) continue;
    const prev = map.get(chat.id);
    if (!prev || (chat.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      map.set(chat.id, {
        ...prev,
        ...chat,
        title: chat.title || prev?.title || "",
        projectRemote: chat.projectRemote || prev?.projectRemote || null,
        projectName: chat.projectName || prev?.projectName || "",
      });
    }
  }
  return [...map.values()];
}

// Walks up from a file inside the SDK to its package.json. Separate so it can be tested without Electron.
export function sdkVersionFrom(entry: string, read: (file: string) => string | null): string | null {
  let dir = path.dirname(entry);
  for (let i = 0; i < 6; i++) {
    const text = read(path.join(dir, "package.json"));
    if (text) {
      try {
        const pkg = JSON.parse(text) as { name?: string; version?: string };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk" && pkg.version) return pkg.version;
      } catch {
        /* not this one */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
