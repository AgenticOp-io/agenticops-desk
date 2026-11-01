import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionGateFor, riskKeys } from "./gate.ts";

test("ordinary commands have no extra risk", () => {
  assert.deepEqual(riskKeys("npm test && git status"), []);
});

test("format, administrator, and shutdown are separate risks", () => {
  assert.deepEqual(riskKeys("format d:"), ["format"]);
  assert.deepEqual(riskKeys("sudo rm -rf /"), ["sudo"]);
  assert.deepEqual(riskKeys("shutdown /s"), ["shutdown"]);
  assert.deepEqual(riskKeys("git status\nsudo true"), ["sudo"]);
});

test("an untrusted folder asks before any work", () => {
  const gate = permissionGateFor(undefined, "C:\\work\\demo", "Bash", { command: "npm test" });
  assert.equal(gate.ask, true);
  if (gate.ask && gate.kind === "trust") assert.equal(gate.summary, "Let Claude work in demo");
  else assert.fail("expected a trust prompt");
});

test("a trusted folder lets ordinary commands run", () => {
  const gate = permissionGateFor({ trusted: true, risks: [] }, "C:\\work\\demo", "Edit", {});
  assert.deepEqual(gate, { ask: false });
});

test("a trusted folder still asks for a new risky command", () => {
  const gate = permissionGateFor({ trusted: true, risks: [] }, "C:\\work\\demo", "PowerShell", { command: "format e:" });
  assert.equal(gate.ask, true);
  if (gate.ask && gate.kind === "risk") assert.deepEqual(gate.risks, ["format"]);
  else assert.fail("expected a risk prompt");
});

test("a remembered risk does not ask again", () => {
  const gate = permissionGateFor({ trusted: true, risks: ["sudo"] }, "C:\\work\\demo", "Bash", { command: "sudo npm test" });
  assert.deepEqual(gate, { ask: false });
});

test("trust never answers a question or a plan", () => {
  const trusted = { trusted: true, risks: ["sudo", "format", "shutdown"] };
  for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
    const gate = permissionGateFor(trusted, "C:\\work\\demo", tool, {});
    assert.equal(gate.ask && gate.kind, "question");
  }
});
