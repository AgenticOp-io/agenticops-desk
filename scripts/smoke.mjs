// Click-through check of the built app (run `npx vite build` first): it starts, opens Help, Settings and a file,
// and the composer takes text. Uses a throwaway data folder and never sends anything to an AI.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const data = mkdtempSync(path.join(os.tmpdir(), "desk-smoke-"));
const ws = path.join(data, "ws");
writeFileSync(path.join(data, "cursor-import.json"), "{}");
const { mkdirSync } = await import("node:fs");
mkdirSync(ws);
writeFileSync(path.join(ws, "demo.js"), "function add(a, b) {\n  return a + b;\n}\n");
writeFileSync(path.join(data, "settings.json"), JSON.stringify({ lastWorkspace: ws, showCode: true }));

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITE_|CLAUDE)/.test(k)));
env.AGENTICOPS_DESK_DATA = data;
// A fresh home folder too, so the app doesn't pick up this computer's Cursor or Claude Code projects.
env.USERPROFILE = env.HOME = env.APPDATA = data;
const app = await _electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector("textarea", { timeout: 30_000 });
  assert.equal(await page.title(), "AgenticOps Desk");

  await page.keyboard.press("F1");
  await page.getByText("Start here", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await page.locator('button[title="Settings"]').click();
  await page.locator("#settings-auto").waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);

  await page.keyboard.press("Control+p");
  await page.waitForTimeout(400);
  await page.keyboard.type("demo.js");
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page
    .locator(".monaco-editor .view-lines")
    .waitFor({ timeout: 30_000 })
    .catch(async (err) => {
      await page.screenshot({ path: path.join(os.tmpdir(), "desk-smoke-fail.png") });
      throw err;
    });
  // Monaco renders spaces as non-breaking spaces.
  assert.ok((await page.locator(".monaco-editor .view-lines").innerText()).replaceAll(String.fromCharCode(160), " ").includes("return a + b"));

  const box = page.locator(".composer textarea");
  await box.fill("hello");
  assert.equal(await box.inputValue(), "hello");
  assert.deepEqual(errors, [], "no page errors");
  console.log("smoke: ok");
} finally {
  await app.close();
  rmSync(data, { recursive: true, force: true });
}
