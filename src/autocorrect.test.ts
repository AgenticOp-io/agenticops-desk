import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptCorrection, finishedWord, typoDistance } from "./autocorrect.ts";

test("finishedWord picks the word a separator just ended", () => {
  assert.deepEqual(finishedWord("fix wrod, ", 9), { start: 4, end: 8, word: "wrod" });
  assert.equal(finishedWord("fix wrod", 8), null); // still typing
  assert.equal(finishedWord("run `npm tset ", 14), null); // inside code
  assert.equal(finishedWord("open myVar ", 11), null); // not a plain lowercase word
  assert.equal(finishedWord("see src/foo ", 12), null);
  assert.equal(finishedWord("run npm ", 8), null); // short words are left alone
});

test("acceptCorrection takes near misses only", () => {
  assert.equal(typoDistance("teh", "the"), 1);
  assert.equal(acceptCorrection("recieve", "receive"), "receive");
  assert.equal(acceptCorrection("kubectl", "subject"), null); // different first letter
  assert.equal(acceptCorrection("confg", "configure"), null); // too far: a different word
  assert.equal(acceptCorrection("dont", "don't"), "don't");
  assert.equal(acceptCorrection("foo", null), null);
  assert.equal(acceptCorrection("wrod", "Word"), "word");
});
