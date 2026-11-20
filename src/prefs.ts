export type UiPrefs = {
  windowFont: number;
  itemFont: number;
  hiddenProjects: string[];
  hiddenChats: string[];
  projectOrder: string[];
  chatOrder: Record<string, string[]>;
  showCode: boolean;
  expanded: Record<string, boolean>;
  lastWorkspace: string;
  lastChatId: string;
  openFiles: string[];
  activeFile: string;
  draft: string;
  theme: "dark" | "light";
  reviewer: string;
  autoModels: string[];
  // Direct model ("direct:<provider>:<model>") for ghost-text autocomplete in the editor; empty turns it off.
  autocomplete: string;
  // Direct model that writes chat summaries and capsule results after each run; empty follows localModelId.
  summarizer: string;
  // Which local model writes the short notes, or "" for none.
  localModelId: string;
  // Dollars a run may spend before it is stopped; 0 is off.
  runBudgetUsd: number;
  // How many of one manager's workers may run at once.
  maxWorkers: number;
  privacy: "standard" | "protect" | "local";
  /** off leaves Cursor alone. partial archives its chats. full also adds them to Cursor's list. */
  cursorIntegration: "off" | "partial" | "full";
  chatStorage: "github" | "hybrid" | "local" | "";
  projectArchive: Record<string, "in" | number>;
  // Chats unused this many days fold under their project's "older chats" row; 0 is off.
  chatArchiveDays: number;
  // Panels that open in their own window instead of inside the main one.
  popOut: PanelKey[];
  // How the Preview panel shows a running app: inline iframe, or launched in the default browser. Persistent.
  previewMode: "inline" | "browser";
  // Never ask before commands or edits. Questions and plan approvals still ask.
  allowAll?: boolean;
};

export type PanelKey = "chats" | "files" | "inbox" | "status" | "help" | "settings";
export const PANELS: { key: PanelKey; label: string }[] = [
  { key: "chats", label: "Chats" },
  { key: "files", label: "Files" },
  { key: "inbox", label: "Waiting on you" },
  { key: "status", label: "Chat status" },
  { key: "help", label: "Help" },
  { key: "settings", label: "Settings" },
];

export const defaultPrefs = (): UiPrefs => ({
  windowFont: 16,
  itemFont: 13,
  hiddenProjects: [],
  hiddenChats: [],
  projectOrder: [],
  chatOrder: {},
  showCode: false,
  expanded: {},
  lastWorkspace: "",
  lastChatId: "",
  openFiles: [],
  activeFile: "",
  draft: "",
  theme: "dark",
  reviewer: "",
  autoModels: [],
  autocomplete: "",
  summarizer: "",
  localModelId: "qwen2.5:1.5b",
  runBudgetUsd: 0,
  maxWorkers: 3,
  privacy: "protect",
  cursorIntegration: "off",
  chatStorage: "",
  projectArchive: {},
  chatArchiveDays: 14,
  popOut: ["help", "settings"],
  previewMode: "inline",
});

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function moveKey(list: string[], from: string, to: string) {
  if (!from || from === to) return list;
  const next = list.filter((k) => k !== from);
  const i = next.indexOf(to);
  if (i < 0) next.push(from);
  else next.splice(i, 0, from);
  return next;
}
