import { contextBridge, ipcRenderer, webFrame } from "electron";

type PrivacyStatus = ReturnType<typeof import("./privacy").privacyStatus>;
type CanvasDoc = { chatId: string; title: string; kind: "html" | "svg" | "markdown"; content: string };
type TeamOrder = { id: string; managerId?: string; title?: string; prompt?: string; model?: string; text?: string };

export type ClaudeEvent = {
  kind: "status" | "line" | "tool" | "error" | "done" | "approval" | "approval_done" | "todos" | "plan";
  text?: string;
  todos?: Array<{ content: string; status: string }>;
  sessionId?: string;
  running?: boolean;
  phase?: "starting" | "thinking" | "tool" | "writing" | "pushing" | "approval";
  chatId?: string;
  id?: string;
  approval?: {
    requestId: string;
    toolName: string;
    summary: string;
    detail: string;
    reason?: string;
    questions?: Array<{
      question: string;
      header?: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
    canAlways?: boolean;
  };
};

export type CursorProject = {
  name: string;
  path: string;
  slug: string;
  exists: boolean;
  chatCount: number;
  lastChatAt: number | null;
  lastUsedAt?: number;
  remote?: string;
};

export type CursorChat = {
  id: string;
  slug: string;
  projectPath: string | null;
  projectName: string;
  title: string;
  updatedAt: number;
  lastUsedAt?: number;
  size: number;
  pinned?: boolean;
  mode?: string;
  model?: string;
  parentId?: string;
};

export type CursorChatDetail = CursorChat & {
  messages: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  files: string[];
};

contextBridge.exposeInMainWorld("desk", {
  // The spell checker's best guess for a misspelled word, or null when it is spelled right.
  spellGuess: (word: string) => (webFrame.isWordMisspelled(word) ? webFrame.getWordSuggestions(word)[0] ?? null : null),
  getWorkspace: () => ipcRenderer.invoke("workspace:get") as Promise<string>,
  openFolder: () => ipcRenderer.invoke("workspace:open") as Promise<string>,
  setWorkspace: (dir: string) => ipcRenderer.invoke("workspace:set", dir) as Promise<string>,
  listDir: (dir: string) =>
    ipcRenderer.invoke("fs:list", dir) as Promise<
      Array<{ name: string; path: string; isDir: boolean }>
    >,
  openWork: (workspace: string) => ipcRenderer.invoke("openWork:read", workspace) as Promise<string[]>,
  readFile: (filePath: string) => ipcRenderer.invoke("fs:read", filePath) as Promise<string>,
  writeFile: (filePath: string, contents: string) =>
    ipcRenderer.invoke("fs:write", filePath, contents) as Promise<boolean>,
  searchSymbols: (query: string) => ipcRenderer.invoke("fs:symbols", query),
  searchFiles: (query: string) =>
    ipcRenderer.invoke("fs:search", query) as Promise<Array<{ name: string; path: string; rel: string }>>,
  pickFile: () => ipcRenderer.invoke("fs:pickFile") as Promise<string | null>,
  revealInFolder: (filePath: string) => ipcRenderer.invoke("fs:reveal", filePath) as Promise<boolean>,
  listCursorProjects: () => ipcRenderer.invoke("cursor:projects") as Promise<CursorProject[]>,
  addProject: () => ipcRenderer.invoke("projects:add") as Promise<CursorProject[]>,
  removeProject: (dir: string) => ipcRenderer.invoke("projects:remove", dir) as Promise<CursorProject[]>,
  listCursorChats: (projectPath?: string) =>
    ipcRenderer.invoke("cursor:chats", projectPath) as Promise<CursorChat[]>,
  readCursorChat: (slug: string, id: string) =>
    ipcRenderer.invoke("cursor:chat", slug, id) as Promise<CursorChatDetail | null>,
  catchClaudeUp: (chat?: { slug?: string; id?: string; workspace?: string } | null) =>
    ipcRenderer.invoke("cursor:catchup", chat) as Promise<{ title: string; chatId: string }>,
  touchChat: (chatId: string, projectPath?: string | null) =>
    ipcRenderer.invoke("cursor:touch", chatId, projectPath) as Promise<void>,
  upsertChat: (chat: CursorChat) => ipcRenderer.invoke("cursor:upsert", chat) as Promise<void>,
  saveThread: (chatId: string, messages: unknown[], entered?: boolean) =>
    ipcRenderer.invoke("thread:save", chatId, messages, entered) as Promise<void>,
  probeClaude: () =>
    ipcRenderer.invoke("claude:probe") as Promise<{ found: boolean; path: string; bundled: boolean }>,
  authStatus: () =>
    ipcRenderer.invoke("claude:auth") as Promise<{ ok: boolean; raw: string }>,
  runClaude: (payload: {
    prompt: string;
    resume?: boolean;
    permissionMode?: string;
    history?: Array<{ role: string; text: string }>;
    chatId: string;
    workspace?: string;
    model?: string;
    images?: Array<{ mediaType: string; data: string; name?: string }>;
  }) => ipcRenderer.invoke("claude:run", payload) as Promise<boolean>,
  listModels: () =>
    ipcRenderer.invoke("claude:models") as Promise<
      Array<{ value: string; displayName: string; description?: string; group?: string }>
    >,
  signIn: () => ipcRenderer.invoke("claude:login") as Promise<boolean>,
  quickEdit: (req: unknown) => ipcRenderer.invoke("edit:quick", req),
  completeAt: (req: unknown) => ipcRenderer.invoke("edit:complete", req),
  listPlugins: (refresh?: boolean) => ipcRenderer.invoke("plugins:list", refresh),
  listMarketplaces: () => ipcRenderer.invoke("plugins:marketplaces"),
  addMarketplace: (source: string) => ipcRenderer.invoke("plugins:addMarketplace", source),
  removeMarketplace: (name: string) => ipcRenderer.invoke("plugins:removeMarketplace", name),
  installPlugin: (id: string, acceptSha?: string) => ipcRenderer.invoke("plugins:install", id, acceptSha),
  uninstallPlugin: (id: string) => ipcRenderer.invoke("plugins:uninstall", id),
  enablePlugin: (id: string, on: boolean) => ipcRenderer.invoke("plugins:enable", id, on),
  updatePlugin: (id: string) => ipcRenderer.invoke("plugins:update", id),
  pluginDetails: (id: string) => ipcRenderer.invoke("plugins:details", id),
  pluginCommands: (all?: boolean) => ipcRenderer.invoke("plugins:commands", all),
  updateMarketplace: (name?: string) => ipcRenderer.invoke("plugins:updateMarketplace", name),
  autoStatus: () => ipcRenderer.invoke("auto:status"),
  wakeAuto: (model?: string) => ipcRenderer.invoke("auto:wake", model),
  usageReport: () => ipcRenderer.invoke("usage:get"),
  activityReport: () => ipcRenderer.invoke("activity:get"),
  opsTriage: (command: string) =>
    ipcRenderer.invoke("ops:triage", command) as Promise<{ ok: boolean; command: string; summary: string | null; raw: string }>,
  describeImage: (img: { mediaType: string; data: string; name?: string }) =>
    ipcRenderer.invoke("image:describe", img) as Promise<string | null>,
  refreshPlanLimits: () => ipcRenderer.invoke("usage:plan"),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  setProvider: (id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) =>
    ipcRenderer.invoke("providers:set", id, patch),
  loadProviderModels: (id: string) => ipcRenderer.invoke("providers:load", id),
  addProvider: (input: { label: string; baseUrl: string }) => ipcRenderer.invoke("providers:add", input),
  removeProvider: (id: string) => ipcRenderer.invoke("providers:remove", id),
  localModelStatus: () => ipcRenderer.invoke("localModel:status"),
  setupLocalModel: () => ipcRenderer.invoke("localModel:setup"),
  onLocalModel: (cb: (s: { running: boolean; text: string; ok?: boolean }) => void) => {
    const listener = (_: unknown, s: { running: boolean; text: string; ok?: boolean }) => cb(s);
    ipcRenderer.on("localModel:status", listener);
    return () => ipcRenderer.removeListener("localModel:status", listener);
  },
  changedFiles: (chatId: string) => ipcRenderer.invoke("claude:changes", chatId) as Promise<string[]>,
  changeBase: (chatId: string, filePath: string) =>
    ipcRenderer.invoke("claude:changeBase", chatId, filePath) as Promise<string | null>,
  revertChanges: (chatId: string, paths?: string[]) =>
    ipcRenderer.invoke("claude:revert", chatId, paths) as Promise<string[]>,
  keepChanges: (chatId: string, paths?: string[]) => ipcRenderer.invoke("claude:keep", chatId, paths) as Promise<string[]>,
  createPath: (target: string, isDir: boolean) => ipcRenderer.invoke("fs:create", target, isDir) as Promise<boolean>,
  renamePath: (from: string, to: string) => ipcRenderer.invoke("fs:rename", from, to) as Promise<boolean>,
  deletePath: (target: string) => ipcRenderer.invoke("fs:delete", target) as Promise<boolean>,
  runningChats: () => ipcRenderer.invoke("claude:running") as Promise<string[]>,
  stopClaude: (chatId?: string) => ipcRenderer.invoke("claude:stop", chatId) as Promise<boolean>,
  answerApproval: (payload: {
    chatId: string;
    requestId: string;
    allow: boolean;
    always?: boolean;
    answers?: Record<string, string>;
    message?: string;
  }) => ipcRenderer.invoke("claude:approve", payload) as Promise<boolean>,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (prefs: unknown) => ipcRenderer.invoke("settings:set", prefs),
  listCredentials: () => ipcRenderer.invoke("creds:list") as Promise<ReturnType<typeof import("./credentials").listCredentials>>,
  saveCredential: (input: { name: string; kind: string; username: string; host: string; secret: string; passphrase?: string }) =>
    ipcRenderer.invoke("creds:save", input) as Promise<{ ok: boolean; note: string }>,
  removeCredential: (name: string) => ipcRenderer.invoke("creds:remove", name) as Promise<{ ok: boolean; note: string }>,
  privacyStatus: () => ipcRenderer.invoke("privacy:status") as Promise<PrivacyStatus>,
  pinSecret: (value: string) => ipcRenderer.invoke("privacy:pin", value) as Promise<PrivacyStatus>,
  unpinSecret: (index: number) => ipcRenderer.invoke("privacy:unpin", index) as Promise<PrivacyStatus>,
  forgetPlaceholders: () => ipcRenderer.invoke("privacy:forget") as Promise<PrivacyStatus>,
  onClaudeEvent: (cb: (event: ClaudeEvent) => void) => {
    const listener = (_: unknown, event: ClaudeEvent) => cb(event);
    ipcRenderer.on("claude:event", listener);
    return () => ipcRenderer.removeListener("claude:event", listener);
  },
  onSetup: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: string) => cb(text);
    ipcRenderer.on("claude:setup", listener);
    return () => ipcRenderer.removeListener("claude:setup", listener);
  },
  onWorkspaceChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  onFlushThreads: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("desk:flush-threads", listener);
    return () => ipcRenderer.removeListener("desk:flush-threads", listener);
  },
  threadsFlushed: () => ipcRenderer.send("thread:flushed"),
  forgetSession: (chatId: string) => ipcRenderer.invoke("claude:forget", chatId) as Promise<boolean>,
  patchChat: (id: string, patch: Partial<CursorChat>) => ipcRenderer.invoke("chats:patch", id, patch) as Promise<CursorChat | null>,
  deleteChat: (id: string) => ipcRenderer.invoke("chats:delete", id) as Promise<void>,
  searchMessages: (query: string) => ipcRenderer.invoke("chats:search", query) as Promise<string[]>,
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke("git:status", cwd) as Promise<{ ok: boolean; branch: string; lines: string; diff: string }>,
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke("git:commit", cwd, message) as Promise<{ ok: boolean; output: string }>,
  gitFetch: (cwd: string) => ipcRenderer.invoke("git:fetch", cwd) as Promise<{ ok: boolean; output: string }>,
  gitPull: (cwd: string) => ipcRenderer.invoke("git:pull", cwd) as Promise<{ ok: boolean; output: string }>,
  gitPush: (cwd: string) => ipcRenderer.invoke("git:push", cwd) as Promise<{ ok: boolean; output: string }>,
  gitHistory: (cwd: string) => ipcRenderer.invoke("git:history", cwd) as Promise<{ ok: boolean; output: string }>,
  gitCheckout: (cwd: string, branch: string) =>
    ipcRenderer.invoke("git:checkout", cwd, branch) as Promise<{ ok: boolean; output: string }>,
  gitPullRequest: (cwd: string, title: string, body: string) =>
    ipcRenderer.invoke("git:pr", cwd, title, body) as Promise<{ ok: boolean; output: string }>,
  // Types for these live in src/vite-env.d.ts.
  gitChanges: (cwd: string) => ipcRenderer.invoke("git:changes", cwd),
  gitStage: (cwd: string, paths: string[]) => ipcRenderer.invoke("git:stage", cwd, paths),
  gitUnstage: (cwd: string, paths: string[]) => ipcRenderer.invoke("git:unstage", cwd, paths),
  gitResolve: (cwd: string, paths: string[], side: "ours" | "theirs") => ipcRenderer.invoke("git:resolve", cwd, paths, side),
  gitDiscard: (cwd: string, paths: string[], untracked: boolean) => ipcRenderer.invoke("git:discard", cwd, paths, untracked),
  gitShowHead: (cwd: string, file: string) => ipcRenderer.invoke("git:show-head", cwd, file),
  gitBranches: (cwd: string) => ipcRenderer.invoke("git:branches", cwd),
  gitLog: (cwd: string) => ipcRenderer.invoke("git:log", cwd),
  gitCommitWith: (cwd: string, message: string, opts: { all?: boolean; amend?: boolean }) => ipcRenderer.invoke("git:commit-with", cwd, message, opts),
  gitPublish: (cwd: string) => ipcRenderer.invoke("git:publish", cwd),
  gitNewBranch: (cwd: string, name: string) => ipcRenderer.invoke("git:new-branch", cwd, name),
  gitPrs: (cwd: string, kind: string) => ipcRenderer.invoke("git:prs", cwd, kind),
  gitPrCheckout: (cwd: string, kind: string, num: number) => ipcRenderer.invoke("git:pr-checkout", cwd, kind, num),
  gitRepos: () => ipcRenderer.invoke("git:repos"),
  gitClone: (remote: string) => ipcRenderer.invoke("git:clone", remote),
  syncStatus: () =>
    ipcRenderer.invoke("sync:status") as Promise<{
      url: string;
      ok: boolean;
      note: string;
      cursor: "off" | "partial" | "full";
      projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
    }>,
  setSyncUrl: (url: string) =>
    ipcRenderer.invoke("sync:set", url) as Promise<{
      url: string;
      ok: boolean;
      note: string;
      cursor: "off" | "partial" | "full";
      projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
    }>,
  createSyncRepo: () =>
    ipcRenderer.invoke("sync:create") as Promise<{
      url: string;
      ok: boolean;
      note: string;
      cursor: "off" | "partial" | "full";
      projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
    }>,
  setCursorIntegration: (mode: "off" | "partial" | "full") =>
    ipcRenderer.invoke("sync:cursor", mode) as Promise<{
      url: string;
      ok: boolean;
      note: string;
      cursor: "off" | "partial" | "full";
      projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
    }>,
  syncNow: () =>
    ipcRenderer.invoke("sync:now") as Promise<{
      url: string;
      ok: boolean;
      note: string;
      cursor: "off" | "partial" | "full";
      projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
    }>,
  chatFolder: (chatId: string) => ipcRenderer.invoke("chat:folder", chatId) as Promise<{ folder: string; changed: boolean } | null>,
  moveChat: (chatId: string, projectId: string | null) => ipcRenderer.invoke("chat:move", chatId, projectId),
  locateProject: (projectId: string) => ipcRenderer.invoke("project:locate", projectId) as Promise<boolean>,
  trashProject: (dir: string) => ipcRenderer.invoke("project:trash", dir) as Promise<{ ok: boolean; note: string } | null>,
  cloneMissingRepos: () => ipcRenderer.invoke("sync:clone-all") as Promise<{ ok: boolean; output: string }>,
  phoneRepos: () => ipcRenderer.invoke("sync:phone-repos") as Promise<Array<{ repo: string; on: boolean; added: boolean }>>,
  setPhoneRepo: (repo: string, action: "on" | "off" | "add" | "remove") =>
    ipcRenderer.invoke("sync:phone-repo-set", repo, action) as Promise<Array<{ repo: string; on: boolean; added: boolean }>>,
  phonePairQr: () => ipcRenderer.invoke("sync:phone-qr") as Promise<{ ok: boolean; image?: string; login?: string; code?: string; error?: string }>,
  findLocalRepos: () => ipcRenderer.invoke("sync:find-repos") as Promise<{ ok: boolean; output: string }>,
  storageStatus: () => ipcRenderer.invoke("storage:status"),
  setChatStorage: (mode: string) => ipcRenderer.invoke("storage:set", mode),
  reviewCursorRemoval: () => ipcRenderer.invoke("cursor:review-removal"),
  removeCursorFolders: () => ipcRenderer.invoke("cursor:remove-folders"),
  projectCleanupPlan: () => ipcRenderer.invoke("cleanup:plan"),
  applyProjectCleanup: (merges: Array<{ from: string; to: string }>) =>
    ipcRenderer.invoke("cleanup:apply", merges) as Promise<{ moved: number; backup: string }>,
  cloneSyncedProject: (remote: string, projectId: string) =>
    ipcRenderer.invoke("sync:clone", remote, projectId) as Promise<{ ok: boolean; output: string; path?: string }>,
  readProjectDoc: (cwd: string, name: string) => ipcRenderer.invoke("project:read", cwd, name) as Promise<string>,
  writeProjectDoc: (cwd: string, name: string, contents: string) =>
    ipcRenderer.invoke("project:write", cwd, name, contents) as Promise<boolean>,
  openShell: (cwd: string) => ipcRenderer.invoke("shell:open", cwd) as Promise<{ id: string; backlog: string }>,
  restartShell: (cwd: string) => ipcRenderer.invoke("shell:restart", cwd) as Promise<{ id: string; backlog: string }>,
  writeShell: (id: string, text: string) => ipcRenderer.invoke("shell:write", id, text) as Promise<boolean>,
  closeShell: (id: string) => ipcRenderer.invoke("shell:close", id) as Promise<boolean>,
  focusPopout: (name: string) => ipcRenderer.invoke("popout:focus", name) as Promise<boolean>,
  // Synchronous, so main knows before window.open arrives. Frames inside the page can't call this.
  expectPopout: (frameName: string) => void ipcRenderer.sendSync("popout:expect", frameName),
  onShellData: (cb: (payload: { cwd: string; chunk: string }) => void) => {
    const listener = (_: unknown, payload: { cwd: string; chunk: string }) => cb(payload);
    ipcRenderer.on("shell:data", listener);
    return () => ipcRenderer.removeListener("shell:data", listener);
  },
  checkForUpdate: () =>
    ipcRenderer.invoke("updates:check") as Promise<{
      current: string;
      latest: string | null;
      url: string | null;
      note: string;
      patch: { ready: boolean; note: string };
      canInstall: boolean;
    }>,
  restartForUpdate: () => ipcRenderer.invoke("updates:restart") as Promise<void>,
  onUpdateStep: (cb: (step: string) => void) => {
    const listener = (_: unknown, step: string) => cb(step);
    ipcRenderer.on("updates:step", listener);
    return () => ipcRenderer.removeListener("updates:step", listener);
  },
  installUpdate: () => ipcRenderer.invoke("updates:install") as Promise<string | null>,
  previewCommand: (cwd: string) => ipcRenderer.invoke("preview:command", cwd) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url) as Promise<boolean>,
  importOtherTools: () => ipcRenderer.invoke("tools:import") as Promise<{ claudeCode: number; vscode: number }>,
  worktreeGet: (chatId: string, folder: string) => ipcRenderer.invoke("worktree:get", chatId, folder),
  worktreeCreate: (chatId: string, folder: string) => ipcRenderer.invoke("worktree:create", chatId, folder),
  worktreeMerge: (chatId: string) => ipcRenderer.invoke("worktree:merge", chatId),
  worktreeRemove: (chatId: string) => ipcRenderer.invoke("worktree:remove", chatId),
  getOrders: (cwd: string) => ipcRenderer.invoke("orders:get", cwd),
  setOrders: (cwd: string, next: unknown) => ipcRenderer.invoke("orders:set", cwd, next),
  originsOf: (file: string) => ipcRenderer.invoke("provenance:get", file),
  briefing: (sinceMs: number) => ipcRenderer.invoke("briefing:get", sinceMs),
  getTeam: () => ipcRenderer.invoke("team:get"),
  setManager: (chatId: string, on: boolean) => ipcRenderer.invoke("team:manager", chatId, on),
  onWorkerRetired: (cb: (id: string) => void) => {
    const h = (_: unknown, id: string) => cb(id);
    ipcRenderer.on("team:retired", h);
    return () => ipcRenderer.removeListener("team:retired", h);
  },
  onCanvas: (cb: (doc: CanvasDoc | null) => void) => {
    const h = (_: unknown, doc: CanvasDoc | null) => cb(doc);
    ipcRenderer.on("canvas:show", h);
    return () => ipcRenderer.removeListener("canvas:show", h);
  },
  canvasOpen: (chatId: string) => ipcRenderer.invoke("canvas:open", chatId) as Promise<void>,
  codeOpen: (file?: string) => ipcRenderer.invoke("code:open", file) as Promise<void>,
  codePush: (s: unknown) => ipcRenderer.send("code:push", s),
  codeState: () => ipcRenderer.invoke("code:state") as Promise<unknown>,
  onCodeState: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on("code:state", h);
    return () => ipcRenderer.removeListener("code:state", h);
  },
  codeAct: (a: unknown) => ipcRenderer.send("code:act", a),
  onCodeAct: (cb: (a: unknown) => void) => {
    const h = (_e: unknown, a: unknown) => cb(a);
    ipcRenderer.on("code:act", h);
    return () => ipcRenderer.removeListener("code:act", h);
  },
  codeTake: () => ipcRenderer.invoke("code:take") as Promise<string>,
  onCodeFile: (cb: (p: string) => void) => {
    const h = (_e: unknown, p: string) => cb(p);
    ipcRenderer.on("code:file", h);
    return () => ipcRenderer.removeListener("code:file", h);
  },
  canvasGet: (chatId: string) => ipcRenderer.invoke("canvas:get", chatId) as Promise<CanvasDoc | null>,
  canvasExport: (format: "pdf" | "png", html: string, name: string) => ipcRenderer.invoke("canvas:export", format, html, name) as Promise<boolean>,
  // A manager chat asks the window to start or message a worker chat, so it runs like any chat the user starts.
  onTeam: (cb: (kind: "start" | "send", payload: TeamOrder) => void) => {
    const start = (_: unknown, p: TeamOrder) => cb("start", p);
    const send = (_: unknown, p: TeamOrder) => cb("send", p);
    ipcRenderer.on("team:start", start);
    ipcRenderer.on("team:send", send);
    return () => {
      ipcRenderer.removeListener("team:start", start);
      ipcRenderer.removeListener("team:send", send);
    };
  },
  listWatches: (chatId?: string) => ipcRenderer.invoke("watch:list", chatId),
  addWatch: (chatId: string) => ipcRenderer.invoke("watch:add", chatId),
  removeWatch: (chatId: string, file: string) => ipcRenderer.invoke("watch:remove", chatId, file),
});
