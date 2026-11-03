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
  /\b(429|5\d\d)\b|rate.?limit|usage limit|overloaded|quota|credit balance|billing|insufficient|too many requests|capacity|rejected the api key|invalid api key|add an api key|not logged in|\/login|authentication|unauthori[sz]ed|declined this request|connection error|could not connect|econnrefused|econnreset|enotfound|etimedout|fetch failed|network|timed out|stalled|no (claude code|agent engine) build|(claude code|agent engine) (was )?not found|model\b.*\b(not found|does not exist|not available)|local only is on/i;

export function shouldFailOver(error: string): boolean {
  return FAILOVER.test(error);
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
