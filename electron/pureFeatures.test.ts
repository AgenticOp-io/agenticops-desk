import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModelIds, globToRegExp, lineDiff, ownerFromRemote } from "./pureFeatures.ts";

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

test("duplicate chats keep the one used last, and an empty folder that is gone can leave", async () => {
  const { copiesToDrop, emptyGoneProjectIds } = await import("./pureFeatures.ts");
  assert.deepEqual(copiesToDrop([
    { id: "old", key: "same", at: 1 },
    { id: "new", key: "same", at: 5 },
    { id: "only", key: "other", at: 1 },
    { id: "blank", key: "", at: 9 },
  ]), ["old"]);
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

test("a collapsed project shows the last used chat, plus any that must stay in view", async () => {
  const { collapsedChats } = await import("../src/sideChats.ts");
  const chats = [
    { id: "pinned-old", updatedAt: 1 },
    { id: "newest-update", updatedAt: 50, lastUsedAt: 2 },
    { id: "last-used", updatedAt: 3, lastUsedAt: 90 },
    { id: "running", updatedAt: 4 },
  ];
  const ids = (limit: number, must: string[] = []) => collapsedChats(chats, limit, (c) => must.includes(c.id)).map((c) => c.id);
  assert.deepEqual(ids(1), ["last-used"]);
  assert.deepEqual(ids(1, ["running"]), ["last-used", "running"]);
  assert.deepEqual(ids(5), ["pinned-old", "newest-update", "last-used", "running"]);
  assert.deepEqual(collapsedChats([], 1, () => true), []);
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
  assert.deepEqual(installChoices({ storage: "github", importCursor: true }), { storage: "github", importCursor: true });
  assert.deepEqual(installChoices({ storage: "hybrid", importCursor: false }), { storage: "hybrid", importCursor: false });
  assert.deepEqual(installChoices({ storage: "local" }), { storage: "local", importCursor: false });
  assert.equal(installChoices({ storage: "cloud", importCursor: true }), null);
  assert.equal(installChoices(null), null);
});

test("the newest tag is the highest release", async () => {
  const { newestTag } = await import("./pureFeatures.ts");
  assert.equal(newestTag(["refs/tags/v0.1.16", "refs/tags/v0.1.18", "refs/tags/v0.1.18^{}", "refs/tags/v0.1.17"], "0.1.17"), "v0.1.18");
  assert.equal(newestTag(["refs/tags/v0.1.16"], "0.1.17"), null);
  assert.equal(newestTag(["refs/tags/v0.1.18-beta"], "0.1.17"), "v0.1.18-beta");
  assert.equal(newestTag(["refs/tags/v0.1.18", "refs/tags/v0.1.18-beta"], "0.1.17"), "v0.1.18");
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
