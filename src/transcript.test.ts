import assert from "node:assert/strict";
import test from "node:test";
import { appendText, appendThinking, type TranscriptMsg } from "./transcript.ts";

test("thinking streams beside the reply and stays out of it", () => {
  const start: TranscriptMsg[] = [{ role: "user", text: "go" }];
  const thought = appendThinking(appendThinking(start, "The "), "term is huge.");
  const reply = appendText(thought, "Done.");
  const last = reply[reply.length - 1];
  assert.equal(last.text, "Done.");
  assert.deepEqual(last.parts, [
    { kind: "thinking", text: "The term is huge." },
    { kind: "text", text: "Done." },
  ]);
  const again = appendThinking(reply, "More.");
  assert.equal(again[again.length - 1].text, "Done.");
  assert.equal(again[again.length - 1].parts?.at(-1)?.text, "More.");
  assert.equal(appendThinking(start, ""), start);
});
