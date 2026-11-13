import assert from "node:assert/strict";
import test from "node:test";
import { helpParts } from "./helpText.ts";

test("help text marks settings places, keys and slash commands, and leaves paths alone", () => {
  assert.deepEqual(helpParts("Settings › AI models › Spending cap stops a run. Press Ctrl+I or /plugins."), [
    { kind: "place", text: "Settings › AI models › Spending cap" },
    { kind: "text", text: " stops a run. Press " },
    { kind: "key", text: "Ctrl+I" },
    { kind: "text", text: " or " },
    { kind: "command", text: "/plugins" },
    { kind: "text", text: "." },
  ]);
  // A page name that isn't listed stops the place there instead of swallowing the sentence.
  assert.deepEqual(helpParts("Settings › Updates looks now"), [
    { kind: "place", text: "Settings › Updates" },
    { kind: "text", text: " looks now" },
  ]);
  assert.deepEqual(helpParts("owner/repo and .agenticops/orders.json"), [{ kind: "text", text: "owner/repo and .agenticops/orders.json" }]);
  assert.deepEqual(helpParts("F1 or Ctrl+/"), [
    { kind: "key", text: "F1" },
    { kind: "text", text: " or " },
    { kind: "key", text: "Ctrl+/" },
  ]);
});
