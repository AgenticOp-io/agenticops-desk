import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { serialized } from "./jsonStore";

// A single, append-only activity log: the who/what/when of agent runs, tool and git operations, approvals and
// errors. It is the ground truth for debugging, auditing, and later features (an event stream for the
// coordinator, a "recent activity" timeline, analytics). Nothing sensitive is stored: no prompts, replies,
// command bodies, or secrets — only labels, outcomes and counts.

type EventKind = "run" | "tool" | "git" | "approval" | "error" | "system";
export type ActivityEvent = {
  at: number;
  kind: EventKind;
  chatId?: string;
  title?: string;
  model?: string;
  action?: string;
  outcome: "started" | "ok" | "failed" | "denied" | "info";
  note?: string;
};

const MAX_EVENTS = 10_000;
const FLUSH_EVERY = 20;

let pending: ActivityEvent[] = [];
let flushing: Promise<void> | null = null;

function file() {
  return path.join(app.getPath("userData"), "activity.jsonl");
}

// One writer, so concurrent runs never interleave half-lines. The buffer batches writes; a crash at most loses
// the last unflushed batch, and a line is only ever written whole (JSONL is append-only).
export function recordActivity(event: Omit<ActivityEvent, "at">) {
  pending.push({ ...event, at: Date.now() });
  if (pending.length >= FLUSH_EVERY) void flush();
}

export async function flush(): Promise<void> {
  if (flushing) return flushing;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  flushing = serialized("activity", async () => {
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.appendFile(file(), lines, "utf8");
  }).finally(() => {
    flushing = null;
  });
  return flushing;
}

// Newest first, capped. Reads the whole file but only keeps the tail, so a long history stays cheap to show.
export async function recentActivity(limit = 200): Promise<ActivityEvent[]> {
  await flush();
  let text = "";
  try {
    text = await fs.readFile(file(), "utf8");
  } catch {
    return [];
  }
  const out: ActivityEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as ActivityEvent;
      if (e && typeof e.at === "number" && typeof e.kind === "string") out.push(e);
    } catch {
      /* skip a torn or foreign line */
    }
  }
  // Trim to the cap, then return newest first so the UI can show recent activity at the top.
  const tail = out.slice(-Math.max(0, MAX_EVENTS), -0).slice(-limit);
  return tail.reverse();
}
