import assert from "node:assert/strict";
import { test } from "node:test";
import { healHistory } from "./healHistory.ts";

test("healHistory fills missing tool results in both shapes", () => {
  const a: any[] = [{ role: "assistant", content: [{ type: "tool_use", id: "t1" }, { type: "tool_use", id: "t2" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] }];
  healHistory(a);
  assert.deepEqual(a[1].content.map((b: any) => b.tool_use_id), ["t1", "t2"]);
  const b: any[] = [{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] }];
  healHistory(b);
  assert.equal(b[1].content[0].tool_use_id, "t1");
  const o: any[] = [{ role: "assistant", tool_calls: [{ id: "c1" }, { id: "c2" }] }, { role: "tool", tool_call_id: "c1", content: "x" }, { role: "user", content: "hi" }];
  healHistory(o);
  assert.deepEqual(o.map((m) => m.tool_call_id ?? m.role), ["assistant", "c1", "c2", "user"]);
  healHistory(o);
  assert.equal(o.length, 4);
});
