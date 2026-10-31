import { contextBridge, ipcRenderer } from "electron";

export type ClaudeEvent = {
  kind: "status" | "line" | "tool" | "error" | "done" | "approval" | "approval_done";
  text?: string;
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
    ipcRenderer.invoke("cursor:catchup", chat) as Promise<{
      file: string;
      title: string;
      fileName: string;
      chatId: string;
    }>,
  touchChat: (chatId: string, projectPath?: string | null) =>
    ipcRenderer.invoke("cursor:touch", chatId, projectPath) as Promise<void>,
  upsertChat: (chat: CursorChat) => ipcRenderer.invoke("cursor:upsert", chat) as Promise<void>,
  saveThread: (chatId: string, messages: unknown[]) =>
    ipcRenderer.invoke("thread:save", chatId, messages) as Promise<void>,
  probeClaude: () =>
    ipcRenderer.invoke("claude:probe") as Promise<{ found: boolean; path: string }>,
  authStatus: () =>
    ipcRenderer.invoke("claude:auth") as Promise<{ ok: boolean; raw: string }>,
  runClaude: (payload: {
    prompt: string;
    resume?: boolean;
    permissionMode?: string;
    history?: Array<{ role: string; text: string }>;
    chatId: string;
    workspace?: string;
  }) => ipcRenderer.invoke("claude:run", payload) as Promise<boolean>,
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
  onWorkspaceChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
});
