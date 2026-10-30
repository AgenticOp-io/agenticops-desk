/// <reference types="vite/client" />

export type RunPhase = "starting" | "thinking" | "tool" | "writing" | "pushing";

export type ClaudeEvent = {
  kind: "status" | "line" | "tool" | "error" | "done";
  text?: string;
  sessionId?: string;
  running?: boolean;
  phase?: RunPhase;
  chatId?: string;
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
        file: string;
        title: string;
        fileName: string;
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
        chatId: string;
        workspace?: string;
      }) => Promise<boolean>;
      stopClaude: (chatId?: string) => Promise<boolean>;
      getSettings: () => Promise<import("./prefs").UiPrefs>;
      saveSettings: (prefs: Partial<import("./prefs").UiPrefs>) => Promise<import("./prefs").UiPrefs>;
      onClaudeEvent: (cb: (event: ClaudeEvent) => void) => () => void;
      onWorkspaceChanged: (cb: () => void) => () => void;
    };
  }
}
