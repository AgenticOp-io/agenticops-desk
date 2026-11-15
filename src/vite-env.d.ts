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

export type UsageInfo = {
  costUsd: number;
  contextTokens: number;
  contextWindow: number;
  model?: string;
  sessionPercent?: number | null;
  sessionResetsAt?: number | null;
};
export type UsageTally = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; calls: number };
export type UsageRow = { source: string; model: string; today: UsageTally; week: UsageTally; month: UsageTally; daily: number[] };
export type PlanWindow = { id: string; label: string; percent: number | null; resetsAt: number | null };
export type PlanLimits = { updatedAt: number; subscription: string | null; windows: PlanWindow[]; note?: string };
export type UsageReport = { rows: UsageRow[]; plan: PlanLimits | null };
export type ActivityEvent = {
  at: number;
  kind: "run" | "tool" | "git" | "approval" | "error" | "system";
  chatId?: string;
  title?: string;
  model?: string;
  action?: string;
  outcome: "started" | "ok" | "failed" | "denied" | "info";
  note?: string;
};
export type ModelOption = {
  value: string;
  displayName: string;
  description?: string;
  group?: string;
  family?: string;
  needsSetup?: "key" | "models";
  pinned?: boolean;
};
export type ProviderStatus = {
  id: string;
  label: string;
  hasKey: boolean;
  needsKey: boolean;
  keyHint: string;
  baseUrl: string;
  editableModels: boolean;
  models: string[];
  ready: boolean;
};
export type ImageAttachment = { mediaType: string; data: string; name?: string };
export type InstalledPlugin = { id: string; version?: string; scope?: string; enabled: boolean; installPath?: string };
export type AvailablePlugin = { pluginId: string; name: string; description?: string; marketplaceName: string; installCount?: number };
export type Marketplace = { name: string; source?: string; repo?: string; url?: string };
export type PluginCommand = {
  command: string;
  plugin: string;
  pluginId: string;
  kind: "command" | "skill";
  description: string;
  enabled: boolean;
};
export type AutoStatus = {
  order: Array<{ value: string; label: string; restingUntil?: number; reason?: string }>;
  chats: Record<string, string>;
};
export type PluginResult = { ok: boolean; output: string; confirm?: { command: string; sha256: string } };
export type PrivacyStatus = {
  mode: "standard" | "protect" | "local";
  stored: number;
  encrypted: boolean;
  pinned: Array<{ index: number; masked: string }>;
};

export type Orders = {
  rules: string[];
  protect: string[];
  checks: string[];
  maxFixes: number;
  // Read-only, from the repo's .agenticops/orders.json; only on what orders:get returns.
  team?: { rules: string[]; protect: string[] };
};
export type WatchInfo = { chatId: string; file: string; pattern: string };
// Manager chats, and each worker chat's manager (electron/team.ts).
export type Team = { managers: string[]; workers: Record<string, string> };
export type TeamOrder = { id: string; managerId?: string; title?: string; prompt?: string; model?: string; text?: string };

export type BriefingItem = {
  chatId: string;
  title: string;
  project: string;
  lastUsedAt: number;
  state: "running" | "waiting" | "error" | "done";
  asked: string;
  answer: string;
  changes: number;
};

export type ClaudeEvent = {
  kind: "status" | "line" | "thinking" | "tool" | "error" | "done" | "approval" | "approval_done" | "changes" | "usage" | "models" | "todos" | "plan" | "note" | "route";
  model?: string;
  todos?: Array<{ content: string; status: string }>;
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
  id?: string;
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
  projectId?: string;
  projectMovedAt?: number;
  title: string;
  updatedAt: number;
  lastUsedAt?: number;
  size: number;
  pinned?: boolean;
  mode?: string;
  model?: string;
  parentId?: string;
};

export type CleanupRow = { id: string; name: string; path: string; exists: boolean; chats: number };
export type CleanupProposal = { from: CleanupRow; to: CleanupRow; bothExist: boolean };

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
      // Declarations named like the query (git repos only): "@handleLogin" → src/auth.ts line 12.
      searchSymbols: (query: string) => Promise<Array<{ name: string; kind: string; line: number; path: string; rel: string }>>;
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
      saveThread: (chatId: string, messages: unknown[], entered?: boolean) => Promise<void>;
      probeClaude: () => Promise<{ found: boolean; path: string; bundled: boolean }>;
      onSetup: (cb: (text: string) => void) => () => void;
      signIn: () => Promise<boolean>;
      completeAt: (req: { model: string; file: string; language: string; before: string; after: string }) => Promise<string>;
      quickEdit: (req: {
        file: string;
        language: string;
        before: string;
        selection: string;
        after: string;
        instruction: string;
      }) => Promise<{ text: string; model: string }>;
      listPlugins: (refresh?: boolean) => Promise<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }>;
      listMarketplaces: () => Promise<Marketplace[]>;
      addMarketplace: (source: string) => Promise<PluginResult>;
      removeMarketplace: (name: string) => Promise<PluginResult>;
      installPlugin: (id: string, acceptSha?: string) => Promise<PluginResult>;
      uninstallPlugin: (id: string) => Promise<PluginResult>;
      enablePlugin: (id: string, on: boolean) => Promise<PluginResult>;
      updatePlugin: (id: string) => Promise<PluginResult>;
      pluginDetails: (id: string) => Promise<string>;
      pluginCommands: (all?: boolean) => Promise<PluginCommand[]>;
      updateMarketplace: (name?: string) => Promise<PluginResult>;
      autoStatus: () => Promise<AutoStatus>;
      wakeAuto: (model?: string) => Promise<AutoStatus>;
      usageReport: () => Promise<UsageReport>;
      activityReport: () => Promise<ActivityEvent[]>;
      opsTriage: (command: string) => Promise<{ ok: boolean; command: string; summary: string | null; raw: string }>;
      describeImage: (img: { mediaType: string; data: string; name?: string }) => Promise<string | null>;
      refreshPlanLimits: () => Promise<PlanLimits | null>;
      listProviders: () => Promise<ProviderStatus[]>;
      setProvider: (id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) => Promise<ProviderStatus[]>;
      loadProviderModels: (id: string) => Promise<ProviderStatus[]>;
      localModelStatus: () => Promise<{ running: boolean; text: string; ok?: boolean }>;
      setupLocalModel: () => Promise<{ running: boolean; text: string; ok?: boolean }>;
      onLocalModel: (cb: (s: { running: boolean; text: string; ok?: boolean }) => void) => () => void;
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
      runningChats: () => Promise<string[]>;
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
      privacyStatus: () => Promise<PrivacyStatus>;
      pinSecret: (value: string) => Promise<PrivacyStatus>;
      unpinSecret: (index: number) => Promise<PrivacyStatus>;
      forgetPlaceholders: () => Promise<PrivacyStatus>;
      onClaudeEvent: (cb: (event: ClaudeEvent) => void) => () => void;
      onWorkspaceChanged: (cb: () => void) => () => void;
      onFlushThreads: (cb: () => void) => () => void;
      threadsFlushed: () => void;
      forgetSession: (chatId: string) => Promise<boolean>;
      patchChat: (id: string, patch: Partial<CursorChat>) => Promise<CursorChat | null>;
      deleteChat: (id: string) => Promise<void>;
      searchMessages: (query: string) => Promise<string[]>;
      gitStatus: (cwd: string) => Promise<{ ok: boolean; branch: string; lines: string; diff: string }>;
      gitCommit: (cwd: string, message: string) => Promise<{ ok: boolean; output: string }>;
      gitFetch: (cwd: string) => Promise<{ ok: boolean; output: string }>;
      gitPull: (cwd: string) => Promise<{ ok: boolean; output: string }>;
      gitPush: (cwd: string) => Promise<{ ok: boolean; output: string }>;
      gitHistory: (cwd: string) => Promise<{ ok: boolean; output: string }>;
      gitCheckout: (cwd: string, branch: string) => Promise<{ ok: boolean; output: string }>;
      gitPullRequest: (cwd: string, title: string, body: string) => Promise<{ ok: boolean; output: string }>;
      syncStatus: () => Promise<{
        url: string;
        ok: boolean;
        note: string;
        cursor: "off" | "partial" | "full";
        projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
      }>;
      setSyncUrl: (url: string) => Promise<{
        url: string;
        ok: boolean;
        note: string;
        cursor: "off" | "partial" | "full";
        projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
      }>;
      createSyncRepo: () => Promise<{
        url: string;
        ok: boolean;
        note: string;
        cursor: "off" | "partial" | "full";
        projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
      }>;
      setCursorIntegration: (mode: "off" | "partial" | "full") => Promise<{
        url: string;
        ok: boolean;
        note: string;
        cursor: "off" | "partial" | "full";
        projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
      }>;
      syncNow: () => Promise<{
        url: string;
        ok: boolean;
        note: string;
        cursor: "off" | "partial" | "full";
        projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
      }>;
      chatFolder: (chatId: string) => Promise<{ folder: string; changed: boolean } | null>;
      moveChat: (chatId: string, projectId: string | null) => Promise<CursorChat | null>;
      locateProject: (projectId: string) => Promise<boolean>;
      trashProject: (dir: string) => Promise<{ ok: boolean; note: string } | null>;
      listCredentials: () => Promise<{
        encrypted: boolean;
        logins: Array<{ name: string; kind: "password" | "token" | "ssh-key"; username: string; host: string; use: string; passphrase?: boolean }>;
      }>;
      saveCredential: (input: { name: string; kind: string; username: string; host: string; secret: string; passphrase?: string }) => Promise<{ ok: boolean; note: string }>;
      removeCredential: (name: string) => Promise<{ ok: boolean; note: string }>;
      cloneMissingRepos: () => Promise<{ ok: boolean; output: string }>;
      findLocalRepos: () => Promise<{ ok: boolean; output: string }>;
      storageStatus: () => Promise<{ mode: string; cursorChats: number }>;
      setChatStorage: (mode: string) => Promise<{ ok: boolean; note: string }>;
      reviewCursorRemoval: () => Promise<{
        folders: Array<{ path: string; bytes: number }>;
        keep: string | null;
        report: { chats: number; converted: number; recovered: number; already: number; empty: number; errors: string[] } | null;
        archive: string;
      }>;
      removeCursorFolders: () => Promise<{ ok: boolean; note: string; failed: string[] } | null>;
      projectCleanupPlan: () => Promise<CleanupProposal[]>;
      applyProjectCleanup: (merges: Array<{ from: string; to: string }>) => Promise<{ moved: number; backup: string }>;
      restartForUpdate: () => Promise<void>;
      cloneSyncedProject: (remote: string, projectId: string) => Promise<{ ok: boolean; output: string; path?: string }>;
      readProjectDoc: (cwd: string, name: string) => Promise<string>;
      writeProjectDoc: (cwd: string, name: string, contents: string) => Promise<boolean>;
      openShell: (cwd: string) => Promise<{ id: string; backlog: string }>;
      restartShell: (cwd: string) => Promise<{ id: string; backlog: string }>;
      writeShell: (id: string, text: string) => Promise<boolean>;
      closeShell: (id: string) => Promise<boolean>;
      focusPopout: (name: string) => Promise<boolean>;
      spellGuess: (word: string) => string | null;
      onShellData: (cb: (payload: { cwd: string; chunk: string }) => void) => () => void;
      checkForUpdate: () => Promise<{
        current: string;
        latest: string | null;
        url: string | null;
        note: string;
        patch: { ready: boolean; note: string };
        canInstall: boolean;
      }>;
      installUpdate: () => Promise<string | null>;
      previewCommand: (cwd: string) => Promise<string | null>;
      openExternal: (url: string) => Promise<boolean>;
      importOtherTools: () => Promise<{ claudeCode: number; vscode: number }>;
      worktreeGet: (chatId: string, folder: string) => Promise<{ path: string; branch: string } | null>;
      worktreeCreate: (chatId: string, folder: string) => Promise<{ path: string; branch: string } | string>;
      worktreeMerge: (chatId: string) => Promise<{ ok: boolean; note: string }>;
      worktreeRemove: (chatId: string) => Promise<{ ok: boolean; note: string }>;
      getOrders: (cwd: string) => Promise<Orders>;
      setOrders: (cwd: string, next: Partial<Orders>) => Promise<Orders>;
      originsOf: (file: string) => Promise<Array<{ chatId: string; prompt: string; at: number }>>;
      briefing: (sinceMs: number) => Promise<BriefingItem[]>;
      getTeam: () => Promise<Team>;
      setManager: (chatId: string, on: boolean) => Promise<Team | string>;
      onTeam: (cb: (kind: "start" | "send", order: TeamOrder) => void) => () => void;
      listWatches: (chatId?: string) => Promise<WatchInfo[]>;
      addWatch: (chatId: string) => Promise<WatchInfo[]>;
      removeWatch: (chatId: string, file: string) => Promise<WatchInfo[]>;
    };
  }
}
