import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, lineDiff, ownerFromRemote } from "./pureFeatures.ts";

test("protected-path globs", () => {
  assert.ok(globToRegExp("migrations/**").test("migrations/0001_init.sql"));
  assert.ok(globToRegExp("migrations/").test("migrations/deep/x.sql"));
  assert.ok(!globToRegExp("migrations/**").test("src/migrations.ts"));
  assert.ok(globToRegExp("*.lock").test("package-lock.lock"));
  assert.ok(globToRegExp("*.lock").test("sub/yarn.lock"));
  assert.ok(!globToRegExp("*.lock").test("sub/yarn.lockfile"));
  assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
  assert.ok(globToRegExp("src/config.ts").test("SRC/Config.ts"));
  assert.ok(!globToRegExp("src/config.ts").test("src/config.tsx"));
  assert.ok(globToRegExp("src\\**\\*.sql").test("src/a/b/c.sql"));
});

test("org name from a git remote", () => {
  assert.equal(ownerFromRemote("https://github.com/AgenticOp-io/agenticops-desk.git\n"), "AgenticOp-io");
  assert.equal(ownerFromRemote("git@github.com:AgenticOp-io/other-repo.git"), "AgenticOp-io");
  assert.equal(ownerFromRemote("ssh://git@gitlab.example.com/team/repo.git"), "team");
  assert.equal(ownerFromRemote("C:\\repos\\local"), null);
  assert.equal(ownerFromRemote(""), null);
});

test("line diff shows only the changed middle", () => {
  const d = lineDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  assert.match(d, /- c/);
  assert.match(d, /\+ X/);
  assert.ok(!d.includes("- a"));
  assert.equal(lineDiff("same", "same").split("\n").length >= 1, true);
});

test("Auto fails over only on provider trouble", async () => {
  const { shouldFailOver, coolDownMs } = await import("./pureFeatures.ts");
  assert.ok(shouldFailOver("API Error: 429 rate_limit_error"));
  assert.ok(shouldFailOver("Claude AI usage limit reached|1767000000"));
  assert.ok(shouldFailOver("OpenAI: 429 You exceeded your current quota"));
  assert.ok(shouldFailOver("API Error: 529 Overloaded"));
  assert.ok(shouldFailOver("Google Gemini rejected the API key. Check it in Settings."));
  assert.ok(shouldFailOver("Ollama (local): Connection error. fetch failed"));
  assert.ok(shouldFailOver("Ollama (local): Connection error."));
  assert.ok(shouldFailOver("Claude declined this request."));
  assert.ok(!shouldFailOver("Standing-order check still fails after 3 fix attempts: npm test"));
  assert.ok(!shouldFailOver("The reply hit the length limit in the middle of a tool call."));
  assert.equal(coolDownMs("429 Too Many Requests"), 300_000);
  assert.equal(coolDownMs("fetch failed"), 60_000);
});

test("Auto ignores numbers and words that only look like provider trouble", async () => {
  const { shouldFailOver } = await import("./pureFeatures.ts");
  assert.ok(!shouldFailOver("Standing-order check still fails after 3 fix attempts: npm run network-test"));
  assert.ok(!shouldFailOver("SyntaxError in src/a.ts at line 503"));
  assert.ok(shouldFailOver("Request failed with status 503"));
});

test("Auto hands over only after a hidden provider error", async () => {
  const { autoStep } = await import("./pureFeatures.ts");
  const run = { queue: ["next"] as string[], failed: undefined as string | undefined, erred: false };
  assert.equal(autoStep(run, "line", "hi"), "pass");
  assert.equal(autoStep(run, "error", "API Error: 429 rate_limit_error"), "swallow");
  assert.equal(autoStep(run, "error", "API Error: 529 Overloaded"), "pass", "a second error is shown, not hidden");
  assert.equal(autoStep(run, "done", "Done."), "handover");

  const plain = { queue: ["next"], failed: undefined, erred: false };
  assert.equal(autoStep(plain, "error", "tests failed"), "pass");
  assert.equal(plain.erred, true);
  assert.equal(autoStep(plain, "done", "Done."), "finish");

  const last = { queue: [] as string[], failed: undefined, erred: false };
  assert.equal(autoStep(last, "error", "429 Too Many Requests"), "pass", "nothing left to try, so the user sees it");
  assert.equal(autoStep(last, "done", "Stopped."), "finish");
});

test("safe sync save writes, overwrites and leaves no temp file", async () => {
  const { writeJsonAtomicSync } = await import("./jsonStore.ts");
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-json-"));
  try {
    const file = path.join(dir, "sub", "a.json");
    writeJsonAtomicSync(file, { a: 1 });
    writeJsonAtomicSync(file, { a: 2 }, false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
    assert.deepEqual(readdirSync(path.dirname(file)), ["a.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quick edit keeps only the code inside a fence", async () => {
  const { stripFence } = await import("./pureFeatures.ts");
  assert.equal(stripFence("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(stripFence("```\r\n  x()\r\n```\n"), "  x()");
  assert.equal(stripFence("  plain()  "), "  plain()  ");
  assert.equal(stripFence("text ```not a fence``` here"), "text ```not a fence``` here");
});

test("symbols from git grep output", async () => {
  const { parseSymbolHits } = await import("./pureFeatures.ts");
  const out = [
    "src/auth.ts:12:export async function handleLogin(req) {",
    "src/auth.ts:40:  const handleLoginError = (e) => log(e);",
    "src/ui.tsx:7:// calls handleLogin from the form",
    "app/views.py:3:def handle_logout(request):",
    "src/auth.ts:90:export function handleLogin() {}",
    "weird line without numbers",
  ].join("\n");
  const hits = parseSymbolHits(out, "handlel");
  assert.deepEqual(hits.map((h) => `${h.name}@${h.line}:${h.kind}`), ["handleLogin@12:function", "handleLoginError@40:const"]);
  assert.deepEqual(parseSymbolHits(out, "handle_").map((h) => h.name), ["handle_logout"]);
  assert.deepEqual(parseSymbolHits(out, "handlelogin")[0].name, "handleLogin");
});

test("Auto order: sticky first, resting last, unknown dropped", async () => {
  const { autoOrder } = await import("./pureFeatures.ts");
  const available = ["default", "direct:openai:gpt-5", "direct:ollama:qwen3"];
  assert.deepEqual(autoOrder({ chosen: [], available, restingUntil: {}, now: 0 }), available);
  assert.deepEqual(
    autoOrder({ chosen: ["direct:ollama:qwen3", "gone", "default"], available, sticky: "default", restingUntil: {}, now: 0 }),
    ["default", "direct:ollama:qwen3"],
  );
  assert.deepEqual(
    autoOrder({ chosen: [], available, sticky: "default", restingUntil: { default: 100 }, now: 50 }),
    ["direct:openai:gpt-5", "direct:ollama:qwen3", "default"],
  );
});

test("plugin CLI output and command descriptions", async () => {
  const { parseCliJson, describeMarkdown } = await import("./pureFeatures.ts");
  assert.deepEqual(parseCliJson<{ a: number }>('{"a":1}'), { a: 1 });
  assert.deepEqual(parseCliJson<unknown[]>("Updating marketplace…\n[1,2]"), [1, 2]);
  assert.deepEqual(parseCliJson<{ ok: boolean }>('log {not json\n{"ok":true}'), { ok: true });
  assert.equal(parseCliJson("nothing here"), null);
  assert.equal(describeMarkdown('---\nname: x\ndescription: "Review the diff"\n---\n# Title'), "Review the diff");
  assert.equal(describeMarkdown("---\r\nname: x\r\n---\r\n\r\n# Audit the code\r\nmore"), "Audit the code");
  assert.equal(describeMarkdown("Plain first line"), "Plain first line");
});

test("a git remote has one key on every computer", async () => {
  const { allowedGitRemote, blankValue, cursorMode, cursorTranscript, mergeChats, mergeDeleted, mergeProjects, portablePrefs, remoteKey } = await import("./pureFeatures.ts");
  assert.equal(remoteKey("https://github.com/AgenticOp-io/agenticops-desk.git"), "github.com/agenticop-io/agenticops-desk");
  assert.equal(remoteKey("git@github.com:AgenticOp-io/agenticops-desk.git"), "github.com/agenticop-io/agenticops-desk");
  assert.equal(remoteKey("C:\\repos\\local"), null);
  assert.equal(allowedGitRemote("https://github.com/AgenticOp-io/desk-sync.git"), true);
  assert.equal(allowedGitRemote("http://github.com/AgenticOp-io/desk-sync.git"), false);
  assert.equal(allowedGitRemote("git@github.com:AgenticOp-io/desk-sync.git"), true);
  const prefs = portablePrefs({ theme: "light", lastWorkspace: "C:\\secret", openFiles: ["a"], windowFont: 18, cursorIntegration: "partial" });
  assert.equal(prefs.theme, "light");
  assert.equal(prefs.windowFont, 18);
  assert.equal(prefs.cursorIntegration, "partial");
  assert.equal("lastWorkspace" in prefs, false);
  assert.equal(cursorMode("full"), "full");
  assert.equal(cursorMode("nope"), "off");
  const blank = blankValue({ name: "secret", n: 1, nested: { a: "b" }, list: ["x"] }) as {
    name: string;
    n: number;
    nested: { a: string };
    list: string[];
  };
  assert.equal(blank.name, "");
  assert.equal(blank.n, 1);
  assert.equal(blank.nested.a, "");
  assert.deepEqual(blank.list, [""]);
  const transcript = cursorTranscript(
    '{"role":"user","message":{"content":[{"type":"text","text":"Hello there"}]}}\n{"role":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}\n',
  );
  assert.equal(transcript.title, "Hello there");
  assert.equal(transcript.messages.length, 2);
  assert.equal("openFiles" in prefs, false);
  const older = { id: "a", title: "Old", updatedAt: 1, projectRemote: "https://github.com/o/r.git", projectName: "R" };
  const newer = { id: "a", title: "New", updatedAt: 2, projectRemote: null, projectName: "" };
  const merged = mergeChats([older], [newer], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "New");
  assert.equal(merged[0].projectRemote, "https://github.com/o/r.git");
  assert.deepEqual(mergeChats([older], [newer], ["a"]), []);
  assert.deepEqual(mergeDeleted(["a"], ["a", "b"]), ["a", "b"]);
  const projects = mergeProjects(
    [{ remote: "https://github.com/O/R.git", name: "R" }],
    [{ remote: "git@github.com:o/r.git", name: "R2", branch: "dev" }],
  );
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "R2");
  assert.equal(projects[0].branch, "dev");
});

test("a run stays open while background tasks can still report", async () => {
  const { turnIsOver } = await import("./pureFeatures.ts");
  assert.equal(turnIsOver({ type: "result" }, 0), true);
  assert.equal(turnIsOver({ type: "result" }, 2), false);
  assert.equal(turnIsOver({ type: "system", subtype: "session_state_changed", state: "idle" }, 2), true);
  assert.equal(turnIsOver({ type: "system", subtype: "session_state_changed", state: "running" }, 0), false);
  assert.equal(turnIsOver({ type: "assistant" }, 0), false);
});

test("SDK version is found by walking up from its entry file", async () => {
  const { sdkVersionFrom } = await import("./pureFeatures.ts");
  const path = await import("node:path");
  const root = path.join("x", "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const files: Record<string, string> = {
    [path.join(root, "package.json")]: JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.314" }),
    [path.join(root, "dist", "package.json")]: JSON.stringify({ type: "module" }),
  };
  assert.equal(sdkVersionFrom(path.join(root, "dist", "index.js"), (f) => files[f] ?? null), "0.3.314");
  assert.equal(sdkVersionFrom(path.join("y", "index.js"), () => null), null);
});
