// A collapsed project shows its most recently used chats plus any that must stay in view, in the project's own order.
export function collapsedChats<T extends { id: string; updatedAt: number; lastUsedAt?: number }>(
  chats: T[],
  limit: number,
  mustShow: (chat: T) => boolean,
): T[] {
  const used = (c: T) => c.lastUsedAt ?? c.updatedAt;
  const recent = new Set([...chats].sort((a, b) => used(b) - used(a)).slice(0, limit).map((c) => c.id));
  return chats.filter((c) => recent.has(c.id) || mustShow(c));
}

// How many rounds of a chat to show. A new round stays in view once everything is showing, and an empty chat
// never lowers the count below a page: at 0, every chat opened after it would show nothing.
export function roundsToShow(count: number, rounds: number, page: number): number {
  return count >= rounds - 1 ? Math.max(page, rounds) : count;
}
