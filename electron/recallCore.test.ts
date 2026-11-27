import assert from "node:assert/strict";
import { test } from "node:test";
import { DIM, normalize, rank, readVectors, RECORD, toPiece, writeVector } from "./recallCore.ts";

const piece = (user: string, assistant: string, at = 1) => toPiece({ src: "claude", file: `/t/${user}.jsonl`, at, user, assistant });

test("vector records round-trip and a short trailing record is ignored", () => {
  const v = normalize(Array.from({ length: DIM }, (_, i) => i % 7));
  const buf = Buffer.concat([writeVector("abcdef0123456789", v), Buffer.alloc(RECORD - 1)]);
  const back = readVectors(buf);
  assert.equal(back.size, 1);
  assert.ok(Math.abs(back.get("abcdef0123456789")![3] - v[3]) < 1e-6);
});

test("keywords rank the exchange naming the rare term first", () => {
  const ps = [piece("fix the build", "ran tsc"), piece("why does sessionBrief drop turns", "it keeps the first request"), piece("build again", "ok")];
  const hits = rank(ps, ps.map((p) => p.text.toLowerCase()), "sessionBrief build", {});
  assert.match(hits[0].p.text, /sessionBrief/);
});

test("meaning wins over a weak keyword match when both have vectors", () => {
  const a = piece("alpha words", "nothing");
  const b = piece("beta words", "nothing");
  const unit = (i: number) => Float32Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0));
  const vectors = new Map([[a.id, unit(0)], [b.id, unit(1)]]);
  const hits = rank([a, b], [a, b].map((p) => p.text.toLowerCase()), "alpha", { qvec: unit(1), vectors });
  assert.equal(hits[0].p.id, b.id);
});

test("continue and compact prompts keep only the user's own words", async () => {
  const { ownWords } = await import("./recallCore.ts");
  assert.equal(ownWords("This continues an earlier session.\n<verified>lots</verified>\nTreat that as where the work stands. Reply to the user's new message:\n\nfix the tunnel"), "fix the tunnel");
  assert.equal(ownWords("This run was compacted so the earlier tool output is not sent again.\n\nRequest:\nadd recall\n\nSteps already taken:\nx"), "add recall");
  assert.equal(ownWords("  plain ask "), "plain ask");
});

test("no match returns nothing", () => {
  const ps = [piece("hello", "there")];
  assert.equal(rank(ps, ps.map((p) => p.text.toLowerCase()), "zzzunrelated", {}).length, 0);
});
