// A stopped or crashed run can leave an assistant tool call without its result; the API then rejects every later turn.
// This adds a "Stopped" result for each call that has none. Works on both the Anthropic and OpenAI message shapes.
const STOPPED = "Stopped before this ran.";
type Msg = { role?: string; content?: unknown; tool_calls?: Array<{ id?: string }>; tool_call_id?: string };

export function healHistory(messages: unknown[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Msg;
    if (m?.role !== "assistant") continue;
    const next = messages[i + 1] as Msg | undefined;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      let end = i + 1;
      const have = new Set<string>();
      while ((messages[end] as Msg | undefined)?.role === "tool") have.add(String((messages[end++] as Msg).tool_call_id));
      const missing = m.tool_calls.filter((c) => c.id && !have.has(c.id)).map((c) => ({ role: "tool", tool_call_id: c.id, content: STOPPED }));
      messages.splice(end, 0, ...missing);
      i = end + missing.length - 1;
    } else if (Array.isArray(m.content)) {
      const uses = (m.content as Array<{ type?: string; id?: string }>).filter((b) => b?.type === "tool_use" && b.id);
      if (!uses.length) continue;
      const parts = next?.role === "user" && Array.isArray(next.content) ? (next.content as Array<{ type?: string; tool_use_id?: string }>) : null;
      const have = new Set(parts?.filter((b) => b?.type === "tool_result").map((b) => b.tool_use_id));
      const missing = uses.filter((b) => !have.has(b.id!)).map((b) => ({ type: "tool_result", tool_use_id: b.id, content: STOPPED, is_error: true }));
      if (!missing.length) continue;
      if (parts) parts.unshift(...missing);
      else messages.splice(i + 1, 0, { role: "user", content: missing });
    }
  }
}
