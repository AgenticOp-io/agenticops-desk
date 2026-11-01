import { contextBridge, ipcRenderer } from "electron";

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
  getWorkspace: () => ipcRenderer.invoke("workspace:get") as Promise<string>,
  openFolder: () => ipcRenderer.invoke("workspace:open") as Promise<string>,
  setWorkspace: (dir: string) => ipcRenderer.invoke("workspace:set", dir) as Promise<string>,
  listDir: (dir: string) =>
    ipcRenderer.invoke("fs:list", dir) as Promise<
      Array<{ name: string; path: string; isDir: boolean }>
    >,
  readFile: (filePath: string) => ipcRenderer.invoke("fs:read", filePath) as Promise<string>,
  writeFile: (filePath: string, contents: string) =>
    ipcRenderer.invoke("fs:write", filePath, contents) as Promise<boolean>,
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
  saveThread: (chatId: string, messages: unknown[]) =>
    ipcRenderer.invoke("thread:save", chatId, messages) as Promise<void>,
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
  listProviders: () => ipcRenderer.invoke("providers:list"),
  setProvider: (id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) =>
    ipcRenderer.invoke("providers:set", id, patch),
  changedFiles: (chatId: string) => ipcRenderer.invoke("claude:changes", chatId) as Promise<string[]>,
  changeBase: (chatId: string, filePath: string) =>
    ipcRenderer.invoke("claude:changeBase", chatId, filePath) as Promise<string | null>,
  revertChanges: (chatId: string, paths?: string[]) =>
    ipcRenderer.invoke("claude:revert", chatId, paths) as Promise<string[]>,
  keepChanges: (chatId: string, paths?: string[]) => ipcRenderer.invoke("claude:keep", chatId, paths) as Promise<string[]>,
  createPath: (target: string, isDir: boolean) => ipcRenderer.invoke("fs:create", target, isDir) as Promise<boolean>,
  renamePath: (from: string, to: string) => ipcRenderer.invoke("fs:rename", from, to) as Promise<boolean>,
  deletePath: (target: string) => ipcRenderer.invoke("fs:delete", target) as Promise<boolean>,
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
  forgetSession: (chatId: string) => ipcRenderer.invoke("claude:forget", chatId) as Promise<boolean>,
  patchChat: (id: string, patch: Partial<CursorChat>) => ipcRenderer.invoke("chats:patch", id, patch) as Promise<CursorChat | null>,
  deleteChat: (id: string) => ipcRenderer.invoke("chats:delete", id) as Promise<void>,
  searchMessages: (query: string) => ipcRenderer.invoke("chats:search", query) as Promise<string[]>,
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke("git:status", cwd) as Promise<{ ok: boolean; branch: string; lines: string; diff: string }>,
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke("git:commit", cwd, message) as Promise<{ ok: boolean; output: string }>,
  gitPullRequest: (cwd: string, title: string, body: string) =>
    ipcRenderer.invoke("git:pr", cwd, title, body) as Promise<{ ok: boolean; output: string }>,
  readProjectDoc: (cwd: string, name: string) => ipcRenderer.invoke("project:read", cwd, name) as Promise<string>,
  writeProjectDoc: (cwd: string, name: string, contents: string) =>
    ipcRenderer.invoke("project:write", cwd, name, contents) as Promise<boolean>,
  openShell: (cwd: string) => ipcRenderer.invoke("shell:open", cwd) as Promise<{ id: string; backlog: string }>,
  restartShell: (cwd: string) => ipcRenderer.invoke("shell:restart", cwd) as Promise<{ id: string; backlog: string }>,
  writeShell: (id: string, text: string) => ipcRenderer.invoke("shell:write", id, text) as Promise<boolean>,
  closeShell: (id: string) => ipcRenderer.invoke("shell:close", id) as Promise<boolean>,
  onShellData: (cb: (payload: { cwd: string; chunk: string }) => void) => {
    const listener = (_: unknown, payload: { cwd: string; chunk: string }) => cb(payload);
    ipcRenderer.on("shell:data", listener);
    return () => ipcRenderer.removeListener("shell:data", listener);
  },
  checkForUpdate: () =>
    ipcRenderer.invoke("updates:check") as Promise<{ current: string; latest: string | null; url: string | null; note: string }>,
});
