import { loadThread, rememberedChats } from "./library";

// "While you were away": where every recently used chat stands, built from what AgenticOps Desk already
// saved. No model call, so it is instant and free.
export type BriefingItem = {
  chatId: string;
  title: string;
  project: string;
  lastUsedAt: number;
  state: "running" | "waiting" | "error" | "done";
  asked: string;
  answer: string;
  changes: number;
};

type Msg = { role?: string; text?: string };

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export async function buildBriefing(opts: {
  sinceMs: number;
  running: (chatId: string) => boolean;
  waiting: (chatId: string) => boolean;
  changes: (chatId: string) => number;
}): Promise<BriefingItem[]> {
  const chats = (await rememberedChats())
    .filter((c) => (c.lastUsedAt ?? c.updatedAt ?? 0) >= opts.sinceMs)
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? 0) - (a.lastUsedAt ?? a.updatedAt ?? 0))
    .slice(0, 20);
  const items: BriefingItem[] = [];
  for (const c of chats) {
    const msgs = ((await loadThread(c.id)) ?? []) as Msg[];
    if (!msgs.length) continue;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.text ?? "";
    const lastAnswer = [...msgs].reverse().find((m) => m.role === "assistant")?.text ?? "";
    const lastError = msgs.at(-1)?.role === "error";
    const state = opts.waiting(c.id) ? "waiting" : opts.running(c.id) ? "running" : lastError ? "error" : "done";
    items.push({
      chatId: c.id,
      title: c.title,
      project: c.projectName || "",
      lastUsedAt: c.lastUsedAt ?? c.updatedAt ?? 0,
      state,
      asked: clip(lastUser, 160),
      answer: clip(lastAnswer.split(/\n\n/).filter(Boolean).at(-1) ?? "", 280),
      changes: opts.changes(c.id),
    });
  }
  return items;
}
