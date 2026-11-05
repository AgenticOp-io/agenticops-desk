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
  const older = { id: "a", title: "Old", updatedAt: 1, projectId: "p1", projectName: "R", slug: "", size: 0 };
  const newer = { id: "a", title: "New", updatedAt: 2, projectId: null, projectName: "", slug: "", size: 0 };
  const merged = mergeChats([older], [newer], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "New");
  assert.equal(merged[0].projectId, "p1");
  assert.deepEqual(mergeChats([older], [newer], ["a"]), []);
  assert.deepEqual(mergeDeleted(["a"], ["a", "b"]), ["a", "b"]);
  const projects = mergeProjects(
    [{ id: "p1", remotes: ["https://github.com/O/R.git"], name: "R" }],
    [{ id: "p1", remotes: ["git@github.com:o/r.git", "https://github.com/N/R.git"], name: "R2" }],
  );
  assert.equal(projects.length, 1);
  // Each computer merges what came down with its own, so the result must not depend on who ran last.
  assert.equal(projects[0].name, "R");
  assert.deepEqual(projects[0].remotes, ["https://github.com/O/R.git", "https://github.com/N/R.git"]);
  assert.deepEqual(mergeProjects(projects, [{ id: "p1", remotes: ["git@github.com:o/r.git"], name: "other-folder" }]), projects);
});

test("using a chat on an old computer does not undo a move", async () => {
  const { mergeChats } = await import("./pureFeatures.ts");
  const moved = { id: "a", title: "T", updatedAt: 5, projectId: "new", projectMovedAt: 5, projectName: "New", slug: "", size: 0 };
  const used = { id: "a", title: "T2", updatedAt: 9, projectId: "old", projectName: "Old", slug: "", size: 0 };
  for (const merged of [mergeChats([moved], [used], []), mergeChats([used], [moved], [])]) {
    assert.equal(merged[0].projectId, "new");
    assert.equal(merged[0].projectName, "New");
    assert.equal(merged[0].title, "T2");
    assert.equal(merged[0].updatedAt, 9);
  }
});

test("synced projects attach by remote only when there is no doubt", async () => {
  const { matchSyncedProjects } = await import("./pureFeatures.ts");
  const remote = "https://github.com/o/r.git";
  assert.deepEqual(matchSyncedProjects([{ id: "l", remotes: [remote] }], [{ id: "x", name: "R", remotes: ["git@github.com:o/r.git"] }]), { l: "x" });
  // Two incoming projects on one remote: this computer's single clone could be either.
  assert.deepEqual(
    matchSyncedProjects([{ id: "l", remotes: [remote] }], [
      { id: "x", name: "A", remotes: [remote] },
      { id: "y", name: "B", remotes: [remote] },
    ]),
    {},
  );
  // Two local folders on one remote stay separate.
  assert.deepEqual(matchSyncedProjects([{ id: "l", remotes: [remote] }, { id: "m", remotes: [remote] }], [{ id: "x", name: "R", remotes: [remote] }]), {});
  // A project both sides already know is left alone.
  assert.deepEqual(matchSyncedProjects([{ id: "x", remotes: [remote] }], [{ id: "x", name: "R", remotes: [remote] }]), {});
  assert.deepEqual(matchSyncedProjects([{ id: "l" }], [{ id: "x", name: "R", remotes: [] }]), {});
});

test("cleanup proposes moved folders and only offers live duplicates", async () => {
  const { cleanupProposals } = await import("./pureFeatures.ts");
  const row = (id: string, p: string, exists: boolean, chats: number) => ({ id, name: id, path: p, exists, chats });
  const plan = cleanupProposals([
    row("gone", "C:\\Downloads\\AppOne", false, 42),
    row("live", "C:\\products\\appone", true, 2),
    row("a", "C:\\one\\apptwo", true, 13),
    row("b", "C:\\two\\apptwo", true, 2),
    row("empty", "C:\\Downloads\\appthree", false, 0),
    row("target", "C:\\products\\appthree", true, 0),
    row("alone", "C:\\Downloads\\solo", false, 9),
    row("g1", "C:\\x\\twice", false, 1),
    row("g2", "C:\\y\\twice", false, 1),
  ]);
  assert.deepEqual(plan.map((p) => [p.from.id, p.to.id, p.bothExist]), [
    ["gone", "live", false],
    ["b", "a", true],
  ]);
});

test("overlapping sync requests share one follow-up and then stop", async () => {
  const { oneAtATime } = await import("./pureFeatures.ts");
  let runs = 0;
  const sync = oneAtATime(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return runs;
  });
  const results = await Promise.all([sync(), sync(), sync()]);
  assert.deepEqual(results, [1, 2, 2]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 2);
  assert.equal(await sync(), 3);
  const failing = oneAtATime(async () => {
    throw new Error("no");
  });
  await assert.rejects(Promise.all([failing(), failing()]));
});

test("a patch must be newer, match this install and stay in its folder", async () => {
  const { isNewerVersion, patchRefusal, patchShell } = await import("./pureFeatures.ts");
  assert.equal(isNewerVersion("v0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.6", "0.1.6"), false);
  assert.equal(isNewerVersion("0.1.5", "0.2.0"), false);
  const shell = patchShell("36.9.5", { sdk: "1" });
  const here = { current: "0.1.6", shell, bad: [] as string[] };
  const main = { path: "dist-electron/main.js", sha256: "a".repeat(64) };
  const good = { version: "0.1.7", shell, tar: "", files: [main] };
  assert.equal(patchRefusal(good, here), null);
  assert.match(patchRefusal({ ...good, version: "0.1.6" }, here)!, /up to date/);
  assert.match(patchRefusal(good, { ...here, bad: ["0.1.7"] })!, /failed/);
  assert.match(patchRefusal({ ...good, shell: patchShell("37.0.0", { sdk: "1" }) }, here)!, /more than/);
  assert.match(patchRefusal({ ...good, files: [] }, here)!, /entry/);
  for (const p of ["../evil.js", "dist/../../evil.js", "dist\\..\\evil.js", "C:/evil.js", "node_modules/x.js", "boot/boot.mjs"]) {
    assert.match(patchRefusal({ ...good, files: [main, { path: p, sha256: "a".repeat(64) }] }, here)!, /unsafe/, p);
  }
});

test("a project folder has Cursor's transcript folder name", async () => {
  const { slugFromResolved } = await import("./pureFeatures.ts");
  assert.equal(slugFromResolved("C:\\Users\\user\\Downloads\\My_converter"), "c-Users-user-Downloads-My-converter");
  assert.equal(slugFromResolved("C:\\Users\\user\\Downloads\\Some_Tool_1.2"), "c-Users-user-Downloads-Some-Tool-1-2");
  assert.equal(slugFromResolved("C:\\Users\\user\\Downloads\\Data Extract"), "c-Users-user-Downloads-Data-Extract");
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
