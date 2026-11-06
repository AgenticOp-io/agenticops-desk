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
