// Same folder, whatever slash or trailing separator the two sides used.
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

// A chat stays on the project it was filed under. The path is only a fallback, and a slug is used only when one
// project has it: two checkouts of the same name must not steal each other's chats.
export function projectForChat<T extends { id?: string; path: string; slug: string }>(
  projects: T[],
  chat: { projectId?: string; projectPath?: string | null; slug: string },
): T | undefined {
  const id = chat.projectId?.toLowerCase();
  if (id) {
    const hit = projects.find((p) => p.id?.toLowerCase() === id);
    if (hit) return hit;
  }
  if (chat.projectPath) {
    const key = normPath(chat.projectPath);
    const hit = projects.find((p) => p.path && normPath(p.path) === key);
    if (hit) return hit;
  }
  const slug = chat.slug.toLowerCase();
  if (!slug) return undefined;
  const hits = projects.filter((p) => p.slug.toLowerCase() === slug);
  return hits.length === 1 ? hits[0] : undefined;
}

// Unopened for about three months: its project moves to the archive row in the sidebar.
export function isStale(lastUsedAt: number, now: number): boolean {
  return now - lastUsedAt > 90 * 86_400_000;
}

// Chats in one project that fold into its "older chats" row: unused for `days`, never the first (main) chat, a
// pinned one, or one `keep` holds out (open now, running). `chats` is in sidebar order. 0 days is off.
export function olderChats<T extends { id: string; updatedAt: number; pinned?: boolean }>(
  chats: T[],
  days: number,
  now: number,
  keep: (chat: T) => boolean,
): Set<string> {
  const old = new Set<string>();
  if (days <= 0) return old;
  chats.forEach((c, i) => {
    if (i > 0 && !c.pinned && !keep(c) && now - c.updatedAt > days * 86_400_000) old.add(c.id);
  });
  return old;
}

// How many rounds of a chat to show. A new round stays in view once everything is showing, and an empty chat
// never lowers the count below a page: at 0, every chat opened after it would show nothing.
export function roundsToShow(count: number, rounds: number, page: number): number {
  return count >= rounds - 1 ? Math.max(page, rounds) : count;
}

// Rows keep the place they got when first seen, so nothing moves under the pointer while agents work.
// Anything new goes on top. The order is worked out afresh the next time the app starts.
export function stableOrder<T>(items: T[], keyOf: (item: T) => string, places: Map<string, number>): T[] {
  let top = Math.min(0, ...places.values());
  const first = places.size === 0;
  items.forEach((item, index) => {
    if (!places.has(keyOf(item))) places.set(keyOf(item), first ? index : --top);
  });
  return [...items].sort((a, b) => places.get(keyOf(a))! - places.get(keyOf(b))!);
}
