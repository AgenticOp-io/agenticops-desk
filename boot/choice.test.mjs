import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseBoot, rollback } from "./choice.mjs";

test("no patch runs the installed code", () => {
  assert.deepEqual(chooseBoot(null), { run: null, state: null });
  assert.deepEqual(chooseBoot({ version: null, bad: ["0.1.7"] }), { run: null, state: null });
});

test("a proven patch runs and changes nothing", () => {
  assert.deepEqual(chooseBoot({ version: "0.1.7", trial: false }), { run: "0.1.7", state: null });
});

test("a patch on trial gets one start, then goes back and is not tried again", () => {
  const first = chooseBoot({ version: "0.1.8", previous: "0.1.7", trial: true, tried: false });
  assert.equal(first.run, "0.1.8");
  assert.equal(first.state.tried, true);
  const second = chooseBoot(first.state);
  assert.equal(second.run, "0.1.7");
  assert.deepEqual(second.state.bad, ["0.1.8"]);
  assert.equal(second.state.trial, false);
  assert.deepEqual(chooseBoot(second.state), { run: "0.1.7", state: null });
});

test("going back from the first patch lands on the installed code", () => {
  const back = rollback({ version: "0.1.7", previous: null, bad: ["0.1.6"] });
  assert.equal(back.version, null);
  assert.deepEqual(back.bad, ["0.1.6", "0.1.7"]);
});
