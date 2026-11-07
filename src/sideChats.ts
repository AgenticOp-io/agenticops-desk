// An open project shows its most recently used chats plus any that must stay in view, in the project's own order.
export function collapsedChats<T extends { id: string; updatedAt: number; lastUsedAt?: number }>(
  chats: T[],
  limit: number,
  mustShow: (chat: T) => boolean,
): T[] {
  const used = (c: T) => c.lastUsedAt ?? c.updatedAt;
  const recent = new Set([...chats].sort((a, b) => used(b) - used(a)).slice(0, limit).map((c) => c.id));
  return chats.filter((c) => recent.has(c.id) || mustShow(c));
}

// Unopened for about three months: its project moves to the archive row in the sidebar.
export function isStale(lastUsedAt: number, now: number): boolean {
  return now - lastUsedAt > 90 * 86_400_000;
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
