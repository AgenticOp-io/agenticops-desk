import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyEdits, hunksToBlocks, parseEdits } from "./lib.mjs";

test("a diff turned into edit blocks rebuilds the new file from the old one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-hunk-"));
  writeFileSync(path.join(dir, "f.js"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
  const diff = ["diff --git a/f.js b/f.js", "--- a/f.js", "+++ b/f.js", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -8,3 +8,4 @@", " h", " i", "+i2", " j", ""].join("\n");
  assert.equal(applyEdits(dir, parseEdits(hunksToBlocks("f.js", diff)), new Set()), "");
  assert.equal(readFileSync(path.join(dir, "f.js"), "utf8"), "a\nB\nc\nd\ne\nf\ng\nh\ni\ni2\nj\n");
});

test("edit blocks parse, apply with CRLF kept, and stay inside the repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-lib-"));
  writeFileSync(path.join(dir, "a.ts"), "const x = 1;\r\nconst y = 2;\r\n");
  const reply = [
    "Here you go:",
    "FILE: a.ts",
    "```ts",
    "<<<<<<< SEARCH",
    "const y = 2;",
    "=======",
    "const y = 3;",
    ">>>>>>> REPLACE",
    "```",
    "FILE: new/b.ts",
    "<<<<<<< SEARCH",
    "=======",
    "export const b = 1;",
    ">>>>>>> REPLACE",
    "FILE: ../escape.ts",
    "<<<<<<< SEARCH",
    "=======",
    "bad",
    ">>>>>>> REPLACE",
    "FILE: a.test.ts",
    "<<<<<<< SEARCH",
    "=======",
    "cheat",
    ">>>>>>> REPLACE",
  ].join("\n");
  const edits = parseEdits(reply);
  assert.equal(edits.length, 4);
  const err = applyEdits(dir, edits, new Set(["a.test.ts"]));
  assert.equal(readFileSync(path.join(dir, "a.ts"), "utf8"), "const x = 1;\r\nconst y = 3;\r\n");
  assert.equal(readFileSync(path.join(dir, "new/b.ts"), "utf8"), "export const b = 1;\n");
  assert.match(err, /escape\.ts: outside the repo/);
  assert.match(err, /a\.test\.ts: test files may not be changed/);
  assert.match(applyEdits(dir, parseEdits("FILE: a.ts\n<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE"), new Set()), /not found/);
});
