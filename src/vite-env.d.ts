/// <reference types="vite/client" />

export type RunPhase = "starting" | "thinking" | "tool" | "writing" | "pushing" | "approval";

export type ApprovalQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

export type ApprovalRequest = {
  requestId: string;
  toolName: string;
  summary: string;
  detail: string;
  reason?: string;
  questions?: ApprovalQuestion[];
  canAlways?: boolean;
  remember?: boolean;
};

export type UsageInfo = { costUsd: number; contextTokens: number; contextWindow: number; model?: string };
export type ModelOption = { value: string; displayName: string; description?: string };
export type ImageAttachment = { mediaType: string; data: string; name?: string };

export type ClaudeEvent = {
  kind: "status" | "line" | "tool" | "error" | "done" | "approval" | "approval_done" | "changes" | "usage" | "models";
  // "changes": files Claude edited in this chat that the user has not kept or undone yet.
  files?: string[];
  usage?: UsageInfo;
  models?: ModelOption[];
  text?: string;
  sessionId?: string;
  running?: boolean;
  phase?: RunPhase;
  chatId?: string;
  id?: string;
  approval?: ApprovalRequest;
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

declare global {
  interface Window {
    desk: {
      getWorkspace: () => Promise<string>;
      openFolder: () => Promise<string>;
      setWorkspace: (dir: string) => Promise<string>;
      listDir: (dir: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
      readFile: (filePath: string) => Promise<string>;
      writeFile: (filePath: string, contents: string) => Promise<boolean>;
      searchFiles: (query: string) => Promise<Array<{ name: string; path: string; rel: string }>>;
      pickFile: () => Promise<string | null>;
      revealInFolder: (filePath: string) => Promise<boolean>;
      listCursorProjects: () => Promise<CursorProject[]>;
      addProject: () => Promise<CursorProject[]>;
      removeProject: (dir: string) => Promise<CursorProject[]>;
      listCursorChats: (projectPath?: string) => Promise<CursorChat[]>;
      readCursorChat: (slug: string, id: string) => Promise<CursorChatDetail | null>;
      catchClaudeUp: (chat?: { slug?: string; id?: string; workspace?: string } | null) => Promise<{
        title: string;
        chatId: string;
      }>;
      touchChat: (chatId: string, projectPath?: string | null) => Promise<void>;
      upsertChat: (chat: CursorChat) => Promise<void>;
      saveThread: (chatId: string, messages: unknown[]) => Promise<void>;
      probeClaude: () => Promise<{ found: boolean; path: string }>;
      authStatus: () => Promise<{ ok: boolean; raw: string }>;
      runClaude: (payload: {
        prompt: string;
        resume?: boolean;
        permissionMode?: string;
        history?: Array<{ role: string; text: string }>;
        chatId: string;
        workspace?: string;
        model?: string;
        images?: ImageAttachment[];
      }) => Promise<boolean>;
      listModels: () => Promise<ModelOption[]>;
      changedFiles: (chatId: string) => Promise<string[]>;
      // Contents before Claude's first edit in this chat; null when Claude created the file.
      changeBase: (chatId: string, filePath: string) => Promise<string | null>;
      revertChanges: (chatId: string, paths?: string[]) => Promise<string[]>;
      keepChanges: (chatId: string, paths?: string[]) => Promise<string[]>;
      createPath: (target: string, isDir: boolean) => Promise<boolean>;
      renamePath: (from: string, to: string) => Promise<boolean>;
      deletePath: (target: string) => Promise<boolean>;
      stopClaude: (chatId?: string) => Promise<boolean>;
      answerApproval: (payload: {
        chatId: string;
        requestId: string;
        allow: boolean;
        always?: boolean;
        answers?: Record<string, string>;
        message?: string;
      }) => Promise<boolean>;
      getSettings: () => Promise<import("./prefs").UiPrefs>;
      saveSettings: (prefs: Partial<import("./prefs").UiPrefs>) => Promise<import("./prefs").UiPrefs>;
      onClaudeEvent: (cb: (event: ClaudeEvent) => void) => () => void;
      onWorkspaceChanged: (cb: () => void) => () => void;
    };
  }
}
