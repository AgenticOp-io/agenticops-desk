import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { claudeMemoryDir, encodeProjectPath } from "./memoryPath.ts";

test("project folder names keep only letters and digits", () => {
  assert.equal(encodeProjectPath("C:\\Users\\user\\my_app.v2"), "C--Users-user-my-app-v2");
});

// Drive letters only exist on Windows; path.resolve on Linux or macOS treats "C:\..." as a relative name.
test("the memory folder uses a lowercase drive and prefers a folder that already exists", { skip: process.platform !== "win32" }, () => {
  const home = "C:\\Users\\user";
  const workspace = "C:\\Users\\user\\projects\\my-app";
  const projects = path.join(home, ".claude", "projects");
  const resolved = path.resolve(workspace);
  // The colon is removed with the drive letter, so it does not become a second dash.
  const lower = encodeProjectPath(resolved.replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase()));
  const upper = encodeProjectPath(resolved);
  assert.equal(lower.startsWith("c-"), true);
  assert.equal(lower.startsWith("c--"), false);
  assert.notEqual(lower, upper);

  const fresh = claudeMemoryDir(workspace, home, () => false);
  assert.equal(fresh, path.join(projects, lower, "memory"));

  const existing = claudeMemoryDir(workspace, home, (dir) => dir === path.join(projects, upper));
  assert.equal(existing, path.join(projects, upper, "memory"));
});
