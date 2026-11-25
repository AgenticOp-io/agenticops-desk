import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, fold, scrub } from "./chats.mjs";

test("scrub masks keys and keeps the label", () => {
  const key = "sk-ant-" + "x".repeat(30);
  assert.equal(scrub(`use ${key} now`), "use <secret> now");
  assert.equal(scrub("password=hunter2hunter"), "password=<secret>");
  assert.equal(scrub("Authorization: Bearer " + "a".repeat(30)), "Authorization: Bearer <secret>");
  assert.equal(scrub("plain text stays"), "plain text stays");
});

test("fold merges same-role turns, strips harness tags, starts on a user turn", () => {
  const msgs = fold([
    { role: "assistant", content: "orphan" },
    { role: "user", content: "<timestamp>Mon</timestamp>\n<user_query>\nfix it\n</user_query>" },
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "<system-reminder>x</system-reminder>" },
  ]);
  assert.deepEqual(msgs, [{ role: "user", content: "fix it" }, { role: "assistant", content: "a\n\nb" }]);
});

test("chunk splits at exchanges and drops ones too long", () => {
  const ex = (n) => [{ role: "user", content: "u".repeat(n) }, { role: "assistant", content: "a" }];
  const pieces = chunk([...ex(5), ...ex(5), ...ex(50), ...ex(5)], 12);
  assert.deepEqual(pieces.map((p) => p.length), [4, 2]);
});
