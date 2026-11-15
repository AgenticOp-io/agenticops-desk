import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModelIds, globToRegExp, lineDiff, ownerFromRemote } from "./pureFeatures.ts";

test("run capsules: only checked work, dropped once its files change", async () => {
  const { capsuleBrief, gateCommand, gatePassed, makeCapsule } = await import("./pureFeatures.ts");
  assert.equal(gatePassed({ is_error: true, content: "x" }), false);
  assert.equal(gatePassed({ content: "ok\n[exit code: 2]" }), false);
  assert.equal(gatePassed({ content: [{ type: "text", text: "Found 0 errors\n[exit code: 0]" }] }), true);
  assert.equal(gatePassed({ content: "plain output" }), true);
  assert.equal(gateCommand("PowerShell", { command: "npx tsc --noEmit; npm test" }), "tsc");
  assert.equal(gateCommand("Bash", { command: "git commit -m x" }), "git commit");
  assert.equal(gateCommand("Bash", { command: "ls -la" }), null);
  assert.equal(gateCommand("Read", { command: "tsc" }), null);
  assert.equal(makeCapsule({ at: 1, request: "fix it", outcome: "done", gates: [], files: [] }), null);
  const a = makeCapsule({ at: 1, request: "fix resume", outcome: "Fixed in 0.1.26", gates: ["tsc", "tsc"], files: [{ path: "C:/r/a.ts", digest: "d1" }] })!;
  const b = makeCapsule({ at: 2, request: "add reasoning", outcome: "Streams now", gates: ["node --test"], files: [{ path: "C:/r/b.ts", digest: "d2" }] })!;
  assert.deepEqual(a.gates, ["tsc"]);
  const disk: Record<string, string> = { "C:/r/a.ts": "d1", "C:/r/b.ts": "d2" };
  const brief = capsuleBrief([a, b], (f) => disk[f] ?? null);
  assert.ok(brief.indexOf("fix resume") < brief.indexOf("add reasoning"));
  assert.match(brief, /Files: a\.ts/);
  disk["C:/r/a.ts"] = "changed";
  const after = capsuleBrief([a, b], (f) => disk[f] ?? null);
  assert.ok(!after.includes("fix resume") && after.includes("add reasoning"));
  assert.ok(capsuleBrief([a, b], (f) => disk[f] ?? null, 10) === "");
});

test("deepseek drops stored reasoning before the next command", async () => {
  const { stripDeepSeekReasoning } = await import("./pureFeatures.ts");
  const messages = [
    { role: "assistant", content: "done", reasoning_content: "looked" },
    { role: "user", content: "hi" },
  ];
  stripDeepSeekReasoning(messages);
  assert.equal("reasoning_content" in messages[0], false);
  assert.equal(messages[1].content, "hi");
});

test("handoff only past the budget and only with a transcript to carry", async () => {
  const { shouldHandOff, HANDOFF_TOKENS, RESUME_TTL_MS } = await import("./pureFeatures.ts");
  assert.equal(shouldHandOff(HANDOFF_TOKENS + 1, 4), true);
  assert.equal(shouldHandOff(HANDOFF_TOKENS, 4), false);
  assert.equal(shouldHandOff(undefined, 4), false);
  // Review rounds and resumed runs pass no history: never drop their session.
  assert.equal(shouldHandOff(900_000, 0), false);
  assert.equal(shouldHandOff(1_000, 2, HANDOFF_TOKENS, RESUME_TTL_MS + 1), true);
  assert.equal(shouldHandOff(1_000, 2, HANDOFF_TOKENS, RESUME_TTL_MS), false);
  assert.equal(shouldHandOff(1_000, 0, HANDOFF_TOKENS, RESUME_TTL_MS + 1), false);
});

test("a session that has re-read its history, or a hot 5-hour window, hands off early", async () => {
  const { shouldHandOff, handoffBudget, HANDOFF_TOKENS, HOT_HANDOFF_TOKENS, REREAD_TOKENS } = await import("./pureFeatures.ts");
  assert.equal(shouldHandOff(1_000, 2, HANDOFF_TOKENS, 0, REREAD_TOKENS), false);
  assert.equal(shouldHandOff(1_000, 2, HANDOFF_TOKENS, 0, REREAD_TOKENS + 1), true);
  assert.equal(shouldHandOff(1_000, 0, HANDOFF_TOKENS, 0, REREAD_TOKENS + 1), false);
  assert.equal(handoffBudget(79), HANDOFF_TOKENS);
  assert.equal(handoffBudget(80), HOT_HANDOFF_TOKENS);
  assert.equal(handoffBudget(null), HANDOFF_TOKENS);
  assert.equal(shouldHandOff(HOT_HANDOFF_TOKENS + 1, 2, handoffBudget(100)), true);
  assert.equal(shouldHandOff(HOT_HANDOFF_TOKENS, 2, handoffBudget(100)), false);
});

test("usage adds up per model, by day, and old days drop out", async () => {
  const { addUsage, summarizeUsage, percentUsed, USAGE_DAYS } = await import("./pureFeatures.ts");
  const now = new Date(2026, 10, 11, 22).getTime();
  const day = 86_400_000;
  const log = { days: {} };
  addUsage(log, now - (USAGE_DAYS + 5) * day, "claude-code", "claude-fable-5-1", { input: 999 });
  addUsage(log, now - 3 * day, "claude-code", "claude-fable-5-1", { cacheWrite: 240_000, output: 8_000, costUsd: 2 });
  addUsage(log, now, "claude-code", "claude-fable-5-1", { cacheRead: 300_000 });
  addUsage(log, now, "openai", "gpt-5", { input: 10, output: 5 });
  assert.equal(Object.keys(log.days).length, 2, "a day older than the window is removed");
  const rows = summarizeUsage(log, now);
  const fable = rows.find((r) => r.model === "claude-fable-5-1")!;
  assert.equal(rows[0], fable, "the busiest model comes first");
  assert.equal(fable.today.cacheRead, 300_000);
  assert.equal(fable.week.cacheWrite, 240_000);
  assert.equal(fable.month.costUsd, 2);
  assert.equal(fable.daily.at(-1), 300_000);
  assert.equal(fable.daily.at(-4), 248_000);
  assert.equal(rows.find((r) => r.source === "openai")!.today.calls, 1);
  assert.equal(percentUsed(0.42, "fraction"), 42);
  assert.equal(percentUsed(1, "percent"), 1);
  assert.equal(percentUsed(140, "percent"), 100);
  assert.equal(percentUsed(null, "percent"), null);
});

test("a session brief keeps the ask and the latest reply, and stays short", async () => {
  const { sessionBrief } = await import("./pureFeatures.ts");
  const history = [
    { role: "user", text: "Solve the monotonicity proof" },
    { role: "assistant", text: "x".repeat(5_000) },
    { role: "user", text: "keep going" },
    { role: "assistant", text: "The proof holds for n > 1." },
    { role: "user", text: "did we fix all of this?" },
  ];
  const brief = sessionBrief(history, 2_000);
  assert.match(brief, /Solve the monotonicity proof/);
  assert.match(brief, /did we fix all of this\?/);
  assert.ok(brief.length <= 2_000);
  assert.equal(sessionBrief([]), "");
});

test("a transcript's last real context survives a trailing empty usage", async () => {
  const { latestContextTokens } = await import("./pureFeatures.ts");
  const usage = (n: number) =>
    `{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":${n},"output_tokens":10,"cache_creation":{"ephemeral_1h_input_tokens":${n},"ephemeral_5m_input_tokens":0}}`;
  const echo = `${"x".repeat(2100)} "usage":{"input_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}`;
  const transcript = [
    `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","model":"claude-fable-5-1","usage":${usage(241755)}}}`,
    `{"type":"user","message":{"role":"user","content":${JSON.stringify(echo)}}}`,
    `{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{"role":"assistant","usage":${usage(900000)}}}`,
    `{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}`,
  ].join("\n");
  assert.equal(latestContextTokens(transcript), 241757);
  assert.equal(latestContextTokens(""), undefined);
});

test("every Claude API model has a price, or the spending cap never counts its cost", async () => {
  const { readFileSync } = await import("node:fs");
  const presets = readFileSync(new URL("./providers.ts", import.meta.url), "utf8");
  const direct = readFileSync(new URL("./direct.ts", import.meta.url), "utf8");
  const ids = [...presets.matchAll(/id: "(claude-[\w-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, "the model list was not found");
  assert.ok(!ids.some((id) => id.includes("mythos")), "Mythos was removed on purpose");
  for (const id of ids) assert.ok(direct.includes(`"${id}": {`), `${id} has no price in direct.ts`);
});

test("chat model ids drop embeddings and cap the list", () => {
  const ids = chatModelIds([" deepseek-flash ", "text-embedding-3-small", "whisper-1", "deepseek-flash", "dall-e-3", "gpt-image-1"]);
  assert.deepEqual(ids, ["deepseek-flash"]);
  assert.equal(chatModelIds(Array.from({ length: 30 }, (_, i) => `m${i}`)).length, 20);
});

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
  const { allowedGitRemote, asDeleted, blankValue, cursorMode, cursorTranscript, mergeChats, mergeDeleted, mergeProjects, portablePrefs, remoteKey } = await import("./pureFeatures.ts");
  assert.equal(remoteKey("https://github.com/AgenticOp-io/agenticops-desk.git"), "github.com/agenticop-io/agenticops-desk");
  assert.equal(remoteKey("git@github.com:AgenticOp-io/agenticops-desk.git"), "github.com/agenticop-io/agenticops-desk");
  assert.equal(remoteKey("C:\\repos\\local"), null);
  assert.equal(allowedGitRemote("https://github.com/AgenticOp-io/desk-sync.git"), true);
  assert.equal(allowedGitRemote("http://github.com/AgenticOp-io/desk-sync.git"), false);
  assert.equal(allowedGitRemote("git@github.com:AgenticOp-io/desk-sync.git"), true);
  assert.equal(remoteKey("https://gitlab.com/team/sub/deep/desk-sync.git"), "gitlab.com/team/sub/deep/desk-sync");
  assert.equal(remoteKey("git@gitlab.com:team/sub/desk-sync.git"), "gitlab.com/team/sub/desk-sync");
  const azure = "dev.azure.com/org/proj/desk-sync";
  assert.equal(remoteKey("https://org@dev.azure.com/org/proj/_git/desk-sync"), azure);
  assert.equal(remoteKey("git@ssh.dev.azure.com:v3/org/proj/desk-sync"), azure);
  assert.equal(remoteKey("https://org.visualstudio.com/proj/_git/desk-sync"), azure);
  assert.equal(allowedGitRemote("git@ssh.dev.azure.com:v3/org/proj/desk-sync"), true);
  assert.equal(remoteKey("https://github.com/only-owner"), null);
  assert.equal(remoteKey("https://github.com/a/../b"), null);
  assert.equal(allowedGitRemote("-https://github.com/a/b"), false);
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
  const merged = mergeChats([older], [newer], {});
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "New");
  assert.equal(merged[0].projectId, "p1");
  assert.deepEqual(mergeChats([older], [newer], { a: 1 }), []);
  assert.deepEqual(mergeDeleted({ a: 1 }, { a: 2, b: 3 }), { a: 2, b: 3 });
  assert.deepEqual(Object.keys(asDeleted(["a", "b"])).sort(), ["a", "b"]);
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
  for (const merged of [mergeChats([moved], [used], {}), mergeChats([used], [moved], {})]) {
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

test("an empty folder that is gone can leave, and one that still has chats stays", async () => {
  const { emptyGoneProjectIds } = await import("./pureFeatures.ts");
  assert.deepEqual(emptyGoneProjectIds([
    { id: "ghost", exists: false, chats: 0 },
    { id: "kept", exists: false, chats: 2 },
    { id: "live", exists: true, chats: 0 },
  ]), ["ghost"]);
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

test("Cursor's folders stay unless every copy worked and Cursor is closed", async () => {
  const { cursorRemovalRefusal } = await import("./pureFeatures.ts");
  assert.equal(cursorRemovalRefusal({ mode: "github", running: false, errors: [] }), null);
  for (const mode of ["hybrid", "local", ""]) assert.match(cursorRemovalRefusal({ mode, running: false, errors: [] })!, /keeps its files/);
  assert.match(cursorRemovalRefusal({ mode: "github", running: true, errors: [] })!, /running/);
  assert.match(cursorRemovalRefusal({ mode: "github", running: false, errors: ["chat: disk full"] })!, /disk full/);
});

test("a chat stays on its project even when the path spelling differs", async () => {
  const { projectForChat } = await import("../src/sideChats.ts");
  const projects = [
    { id: "desk", path: "C:\\Users\\user\\projects\\my-app", slug: "c-users-user-projects-my-app" },
    { id: "other-work", path: "C:\\Users\\user\\work\\other-app", slug: "c-work-other" },
    { id: "other-projects", path: "C:\\Users\\user\\projects\\other-app", slug: "c-projects-other" },
  ];
  assert.equal(projectForChat(projects, { projectId: "desk", projectPath: "C:/Users/user/projects/my-app/", slug: "other" })?.id, "desk");
  assert.equal(projectForChat(projects, { projectPath: "c:/users/user/projects/my-app", slug: "c-projects-other" })?.id, "desk");
  assert.equal(projectForChat(projects, { slug: "c-work-other" })?.id, "other-work");
  assert.equal(
    projectForChat([...projects, { id: "copy", path: "D:\\other-app", slug: "c-work-other" }], { slug: "c-work-other" }),
    undefined,
  );
  assert.equal(projectForChat(projects, { projectId: "missing", projectPath: null, slug: "" }), undefined);
});

test("a chat opened after an empty one still shows its rounds", async () => {
  const { roundsToShow } = await import("../src/sideChats.ts");
  assert.equal(roundsToShow(12, 0, 12), 12);
  assert.equal(roundsToShow(roundsToShow(12, 0, 12), 21, 12), 12);
  assert.equal(roundsToShow(12, 13, 12), 13);
  assert.equal(roundsToShow(13, 14, 12), 14);
  assert.equal(roundsToShow(24, 40, 12), 24);
});

test("a command names a saved login, and the secret stays out of its text", async () => {
  const { credEnvName, credNameRefusal, planCredentials } = await import("./pureFeatures.ts");
  const creds = [
    { name: "core-router", kind: "password" as const, username: "admin", host: "10.0.0.1" },
    { name: "gh", kind: "token" as const, username: "", host: "" },
    { name: "deploy", kind: "ssh-key" as const, username: "ops", host: "" },
  ];
  const wroteKeyFor: string[] = [];
  const bin = { askpass: "C:\\d\\desk-askpass.cmd", telnet: "C:\\d\\desk-telnet.cmd", keyFile: (name: string) => (wroteKeyFor.push(name), `C:\\run\\${name}`) };
  const plan = (cmd: string, shell: "Bash" | "PowerShell" = "PowerShell") => planCredentials(cmd, shell, creds, bin) as Exclude<ReturnType<typeof planCredentials>, null | { error: string }>;

  assert.equal(planCredentials("git status", "Bash", creds, bin), null);

  const ssh = plan(`cd x; desk-ssh core-router admin@10.0.0.1 "uptime"`);
  assert.equal(ssh.command, `cd x; ssh -o NumberOfPasswordPrompts=1 admin@10.0.0.1 "uptime"`);
  assert.deepEqual(ssh.reads, [{ env: "DESK_ASKPASS_SECRET", name: "core-router" }]);
  assert.ok(ssh.set.some(([k, v]) => k === "SSH_ASKPASS" && v === bin.askpass));
  assert.deepEqual(wroteKeyFor, [], "a password never gets a key file");

  const key = plan("desk-scp deploy a.txt ops@h:/tmp", "Bash");
  assert.equal(key.command, `scp -i "C:/run/deploy" -o IdentitiesOnly=yes a.txt ops@h:/tmp`);
  assert.deepEqual(key.reads, []);

  const locked = [...creds, { name: "vault", kind: "ssh-key" as const, username: "", host: "", passphrase: true }];
  const unlock = planCredentials("desk-ssh vault ops@h uptime", "Bash", locked, bin) as typeof key;
  assert.equal(unlock.command, `ssh -i "C:/run/vault" -o IdentitiesOnly=yes ops@h uptime`);
  assert.deepEqual(unlock.reads, [{ env: "DESK_ASKPASS_SECRET", name: "vault#passphrase" }]);
  assert.ok(unlock.set.some(([k]) => k === "SSH_ASKPASS"));
  assert.ok("error" in planCredentials("desk-ssh vault h; desk-ssh core-router h", "Bash", locked, bin)!);

  const telnet = plan(`desk-telnet core-router 10.0.0.1 --run "show ver"`);
  assert.equal(telnet.command, `& "C:\\d\\desk-telnet.cmd" 10.0.0.1 --run "show ver"`);
  assert.ok(telnet.set.some(([k, v]) => k === "DESK_TELNET_USER" && v === "admin"));
  assert.ok("error" in planCredentials("desk-telnet deploy h", "Bash", creds, bin)!);

  const git = plan("desk-git gh push origin main");
  assert.equal(git.command, "git push origin main");
  assert.ok(git.set.some(([k, v]) => k === "DESK_ASKPASS_USER" && v === "x-access-token"));

  const env = plan(`curl -H "Authorization: Bearer $DESK_SECRET_GH" https://api.example.com`, "Bash");
  assert.deepEqual(env.names, ["gh"]);
  assert.deepEqual(env.reads, [{ env: credEnvName("gh"), name: "gh" }]);

  assert.match((planCredentials("desk-ssh nope h", "Bash", creds, bin) as { error: string }).error, /No saved login named nope.*core-router/);
  assert.match((planCredentials("echo $DESK_SECRET_NOPE", "Bash", creds, bin) as { error: string }).error, /No saved login matches/);
  assert.match((planCredentials("desk-ssh core-router a; desk-ssh gh b", "Bash", creds, bin) as { error: string }).error, /one saved password/);
  // A word that only ends the same is not the command.
  assert.equal(planCredentials("my-desk-ssh core-router a", "Bash", creds, bin), null);

  assert.equal(credNameRefusal("core-router", creds), null);
  assert.match(credNameRefusal("core_router", creds)!, /too close/);
  assert.match(credNameRefusal("bad name", creds)!, /letters/);
});

test("repos on a new computer link only when there is no doubt", async () => {
  const { matchLocalRepos } = await import("./pureFeatures.ts");
  const p = (id: string, remote: string, placedAt = "") => ({ id, path: placedAt, placed: Boolean(placedAt), remotes: remote ? [remote] : [] });
  const https = (r: string) => `https://github.com/o/${r}.git`;
  // Same repo written the other way still matches.
  assert.deepEqual(matchLocalRepos([p("a", https("a"))], [{ path: "C:/x/a", remote: "git@github.com:O/a.git" }]), { links: [{ id: "a", path: "C:/x/a" }], unsure: [] });
  // Two clones of one repo: the user picks.
  assert.deepEqual(matchLocalRepos([p("a", https("a"))], [{ path: "C:/x/a", remote: https("a") }, { path: "C:/y/a", remote: https("a") }]), { links: [], unsure: ["a"] });
  // Two projects on one repo: the user picks.
  assert.deepEqual(matchLocalRepos([p("a", https("a")), p("b", https("a"))], [{ path: "C:/x/a", remote: https("a") }]), { links: [], unsure: ["a", "b"] });
  // A folder already in use by a placed project is not offered again, and a project with no remote or no clone stays as it is.
  assert.deepEqual(matchLocalRepos([p("a", https("a"), "C:/x/a"), p("b", https("a")), p("c", ""), p("d", https("d"))], [{ path: "c:/X/a", remote: https("a") }]), { links: [], unsure: [] });
});

test("the sidebar refuses to delete anything that holds more than the project", async () => {
  const { deleteFolderRefusal } = await import("./pureFeatures.ts");
  const guard = { home: "C:\\Users\\me", keep: ["C:\\Users\\me\\AppData\\Roaming\\Desk", "C:\\Users\\me\\projects\\desk"], projects: ["C:\\Users\\me\\work\\one", "C:\\Users\\me\\work\\group\\two"], running: false };
  assert.equal(deleteFolderRefusal("C:\\Users\\me\\work\\one", guard), null);
  assert.equal(deleteFolderRefusal("c:/users/me/WORK/one/", guard), null);
  assert.match(deleteFolderRefusal("C:\\", guard)!, /drive/);
  assert.match(deleteFolderRefusal("C:\\Users\\me", guard)!, /home/);
  assert.match(deleteFolderRefusal("C:\\Users", guard)!, /home/);
  assert.match(deleteFolderRefusal("C:\\Users\\me\\AppData", guard)!, /data/);
  assert.match(deleteFolderRefusal("C:\\Users\\me\\projects\\desk", guard)!, /runs from/);
  assert.match(deleteFolderRefusal("C:\\Users\\me\\work\\group", guard)!, /1 other project\b/);
  assert.match(deleteFolderRefusal("C:\\Users\\me\\work", guard)!, /2 other projects/);
  assert.match(deleteFolderRefusal("C:\\Users\\me\\work\\one", { ...guard, running: true })!, /running/);
  // A sibling whose name only starts the same is not inside it.
  assert.equal(deleteFolderRefusal("C:\\Users\\me\\work\\on", guard), null);
});

test("the delete confirmation says what is only here", async () => {
  const { deleteWarnings } = await import("./pureFeatures.ts");
  const clean = { repo: true, remote: true, dirty: 0, unpushed: 0, stashed: 0 };
  assert.deepEqual(deleteWarnings(clean), []);
  assert.match(deleteWarnings({ ...clean, repo: false })[0], /only copy/);
  assert.match(deleteWarnings({ ...clean, remote: false })[0], /no remote/);
  assert.deepEqual(deleteWarnings({ ...clean, dirty: 1, unpushed: 2, stashed: 1 }), [
    "1 file has changes that are not committed.",
    "2 commits are not pushed anywhere.",
    "1 stash is saved only here.",
  ]);
});

test("a project moves to the archive after three months unopened", async () => {
  const { isStale } = await import("../src/sideChats.ts");
  const day = 86_400_000;
  const now = 1000 * day;
  assert.equal(isStale(now - 89 * day, now), false);
  assert.equal(isStale(now - 90 * day, now), false);
  assert.equal(isStale(now - 91 * day, now), true);
  assert.equal(isStale(0, now), true);
});

test("old chats fold away, but never the main, pinned, open or running one", async () => {
  const { olderChats } = await import("../src/sideChats.ts");
  const day = 86_400_000;
  const now = 1000 * day;
  const chats = [
    { id: "main", updatedAt: now - 50 * day },
    { id: "fresh", updatedAt: now - 2 * day },
    { id: "old", updatedAt: now - 20 * day },
    { id: "pinned", updatedAt: now - 20 * day, pinned: true },
    { id: "open", updatedAt: now - 20 * day },
  ];
  const keep = (c: { id: string }) => c.id === "open";
  assert.deepEqual([...olderChats(chats, 14, now, keep)], ["old"]);
  assert.equal(olderChats(chats, 0, now, keep).size, 0);

  // "Used" means last used (lastUsedAt), not last edited: a chat reopened recently stays out even if updatedAt is old.
  const used = [
    { id: "main", updatedAt: now - 30 * day, lastUsedAt: now - 1 * day },
    { id: "stale", updatedAt: now - 30 * day, lastUsedAt: now - 20 * day },
  ];
  assert.deepEqual([...olderChats(used, 14, now, () => false)], ["stale"]);
});

test("hidden chats stay out of the main list and search still shows them", async () => {
  const { sidebarHidesChat } = await import("../src/sideChats.ts");
  assert.equal(sidebarHidesChat(true, false, false), true);
  assert.equal(sidebarHidesChat(false, true, false), true);
  assert.equal(sidebarHidesChat(false, false, false), false);
  assert.equal(sidebarHidesChat(true, true, true), false);
});

test("rows keep their place, and new ones go on top", async () => {
  const { stableOrder } = await import("../src/sideChats.ts");
  const places = new Map<string, number>();
  const same = (x: string) => x;
  assert.deepEqual(stableOrder(["a", "b", "c"], same, places), ["a", "b", "c"]);
  assert.deepEqual(stableOrder(["c", "a", "b"], same, places), ["a", "b", "c"]);
  assert.deepEqual(stableOrder(["c", "new", "a", "b"], same, places), ["new", "a", "b", "c"]);
  assert.deepEqual(stableOrder(["newer", "new", "a", "b", "c"], same, places), ["newer", "new", "a", "b", "c"]);
  assert.deepEqual(stableOrder(["b"], same, places), ["b"]);
});

test("Preview finds the dev script and the address it prints", async () => {
  const { devServerCommand } = await import("./pureFeatures.ts");
  const { localServerUrl } = await import("../src/preview.ts");
  assert.equal(devServerCommand({ scripts: { dev: "vite", start: "x" } }, ["package-lock.json"]), "npm run dev");
  assert.equal(devServerCommand({ scripts: { start: "next start" } }, ["pnpm-lock.yaml"]), "pnpm run start");
  assert.equal(devServerCommand({ scripts: { serve: "x" } }, ["yarn.lock"]), "yarn serve");
  assert.equal(devServerCommand({ scripts: { build: "x" } }, []), null);
  assert.equal(devServerCommand(null, []), null);
  assert.equal(localServerUrl("  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m"), "http://localhost:5173/");
  assert.equal(localServerUrl("  ➜  Local:   http://localhost:5173/\n"), "http://localhost:5173/");
  assert.equal(localServerUrl("ready on http://0.0.0.0:3000."), "http://localhost:3000");
  assert.equal(localServerUrl("see https://example.com:443/"), null);
});

test("a chat changed on two computers merges by message", async () => {
  const { mergeThreads } = await import("./pureFeatures.ts");
  const m = (role: string, text: string) => ({ role, text });
  const base = [m("user", "token abc123"), m("assistant", "ok")];
  const hidden = [m("user", "token [hidden]"), m("assistant", "ok")];
  // The other computer added a turn: take it, and keep this computer's unhidden prefix.
  assert.deepEqual(mergeThreads(base, hidden, [...hidden, m("user", "next")], true), [...base, m("user", "next")]);
  // This computer is ahead: keep it.
  assert.deepEqual(mergeThreads([...base, m("user", "mine")], [...hidden, m("user", "mine")], hidden, false), [...base, m("user", "mine")]);
  // Rewound here and newer here: the rewind stands.
  assert.deepEqual(mergeThreads(base.slice(0, 1), hidden.slice(0, 1), hidden, false), base.slice(0, 1));
  // Rewound on the other computer, which is newer: follow it.
  assert.deepEqual(mergeThreads(base, hidden, hidden.slice(0, 1), true), base.slice(0, 1));
  // Both added: both kept, this computer's first.
  assert.deepEqual(mergeThreads([...base, m("user", "a")], [...hidden, m("user", "a")], [...hidden, m("user", "b")], true), [
    ...base,
    m("user", "a"),
    m("user", "b"),
  ]);
  const same = [...base];
  assert.equal(mergeThreads(same, hidden, hidden, true), same);
});

test("terminal Claude Code sessions and VS Code chats import as plain turns", async () => {
  const { parseClaudeSession, parseCopilotSession } = await import("./pureFeatures.ts");
  const row = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "s1", cwd: "C:\\p", entrypoint: "cli", timestamp: "2026-11-01T00:00:00Z", ...o });
  const lines = [
    row({ type: "user", message: { content: "fix the bug" } }),
    row({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Looking." }] } }),
    row({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    row({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] }, timestamp: "2026-11-02T00:00:00Z" }),
    row({ type: "user", isMeta: true, message: { content: "meta" } }),
    row({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "ai-title", aiTitle: "Bug fix" }),
    "not json",
  ];
  const chat = parseClaudeSession(lines)!;
  assert.equal(chat.title, "Bug fix");
  assert.equal(chat.cwd, "C:\\p");
  assert.equal(chat.updatedAt, Date.parse("2026-11-02T00:00:00Z"));
  assert.deepEqual(chat.messages, [
    { role: "user", text: "fix the bug" },
    { role: "assistant", text: "Looking.\n\nFixed." },
  ]);
  assert.equal(parseClaudeSession(lines.map((l) => l.replace('"cli"', '"sdk-ts"'))), null);

  const copilot = parseCopilotSession(
    { sessionId: "v1", lastMessageDate: 5, requests: [{ message: { text: "hi" }, response: [{ value: "Hello" }, { kind: "x" }, { content: { value: " there" } }] }] },
    "C:\\q",
    "file",
  )!;
  assert.deepEqual(copilot.messages, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello there" },
  ]);
  assert.equal(copilot.id, "v1");
  assert.equal(parseCopilotSession({ requests: [] }, "C:\\q", "f"), null);
});

test("MCP config keeps startable servers and makes provider-safe tool names", async () => {
  const { expandMcpEnv, mcpServersIn, mcpToolName } = await import("./pureFeatures.ts");
  const servers = mcpServersIn({
    mcpServers: {
      db: { command: "npx", args: ["-y", "pg-mcp", 3], env: { URL: "${PG:-local}", N: 1 } },
      web: { type: "sse", url: "https://example.com/sse", headers: { A: "b" } },
      bad: { url: "file:///etc/passwd" },
      "no spaces allowed": { command: "x" },
      empty: { command: " " },
    },
  });
  assert.deepEqual(Object.keys(servers), ["db", "web"]);
  assert.deepEqual(servers.db, { command: "npx", args: ["-y", "pg-mcp"], env: { URL: "${PG:-local}" } });
  assert.equal(servers.web.type, "sse");
  assert.deepEqual(mcpServersIn(null), {});
  assert.equal(expandMcpEnv("${PG:-local}/${HOME}", { HOME: "/h" }), "local//h");
  assert.equal(expandMcpEnv("${PG:-local}", { PG: "x" }), "x");
  assert.equal(mcpToolName("my.server", "run query"), "mcp__my_server__run_query");
  assert.ok(mcpToolName("s", "t".repeat(100)).length <= 64);
});

test("the full installer is the signed one for this version and chip", async () => {
  const { installerFor } = await import("./pureFeatures.ts");
  const name = "AgenticOps-Desk-0.1.21-win-arm64-setup.exe";
  const manifest = { version: "0.1.21", shell: "", tar: "", files: [], installers: { [name]: "b".repeat(64) } };
  assert.deepEqual(installerFor(manifest, "v0.1.21", "arm64"), { name, sha256: "b".repeat(64) });
  assert.match(installerFor(manifest, "v0.1.21", "x64") as string, /no installer/);
  assert.match(installerFor(manifest, "v0.1.22", "arm64") as string, /another version/);
  assert.match(installerFor({ ...manifest, installers: { [name]: "nope" } }, "v0.1.21", "arm64") as string, /no installer/);
  assert.match(installerFor({ ...manifest, installers: undefined }, "v0.1.21", "arm64") as string, /no installer/);
});

test("a patch must be newer, match this install and stay in its folder", async () => {
  const { isNewerVersion, patchRefusal, patchShell } = await import("./pureFeatures.ts");
  assert.equal(isNewerVersion("v0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.6", "0.1.6"), false);
  assert.equal(isNewerVersion("0.1.5", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.19-beta", "0.1.18"), true);
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

test("a shortcut inside the folder cannot point a file outside it", async () => {
  const { staysInside } = await import("./pureFeatures.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "desk-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    fs.writeFileSync(path.join(root, "real.txt"), "y");
    fs.symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(staysInside(root, path.join(root, "real.txt")), true);
    assert.equal(staysInside(root, path.join(root, "new.txt")), true);
    assert.equal(staysInside(root, root, false), false);
    assert.equal(staysInside(root, path.join(root, "link", "secret.txt")), false);
    assert.equal(staysInside(root, path.join(root, "link", "new.txt")), false);
    assert.equal(staysInside(root, path.join(root, "..", "secret.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the installer choice is Git, Local, or Hybrid, and import is only an explicit yes", async () => {
  const { installChoices } = await import("./pureFeatures.ts");
  assert.deepEqual(installChoices({ storage: "github", importCursor: true }), { storage: "github", importCursor: true, importTools: false, localModel: false });
  assert.deepEqual(installChoices({ storage: "hybrid", importCursor: false, importTools: true }), { storage: "hybrid", importCursor: false, importTools: true, localModel: false });
  assert.deepEqual(installChoices({ storage: "local", localModel: true }), { storage: "local", importCursor: false, importTools: false, localModel: true });
  assert.deepEqual(installChoices({ storage: "local", localModel: "yes" }), { storage: "local", importCursor: false, importTools: false, localModel: false });
  assert.equal(installChoices({ storage: "cloud", importCursor: true }), null);
  assert.equal(installChoices(null), null);
});

test("the newest tag is the highest release", async () => {
  const { newestTag } = await import("./pureFeatures.ts");
  assert.equal(newestTag(["refs/tags/v0.1.16", "refs/tags/v0.1.18", "refs/tags/v0.1.18^{}", "refs/tags/v0.1.17"], "0.1.17"), "v0.1.18");
  assert.equal(newestTag(["refs/tags/v0.1.16"], "0.1.17"), null);
  assert.equal(newestTag(["refs/tags/v0.1.18-beta"], "0.1.17"), null);
  assert.equal(newestTag(["refs/tags/v0.1.18", "refs/tags/v0.1.19-beta"], "0.1.17"), "v0.1.18");
});

