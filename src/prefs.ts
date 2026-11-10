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
  // Dollars a run may spend before it is stopped; 0 is off.
  runBudgetUsd: number;
  privacy: "standard" | "protect" | "local";
  /** off leaves Cursor alone. partial archives its chats. full also adds them to Cursor's list. */
  cursorIntegration: "off" | "partial" | "full";
  chatStorage: "github" | "hybrid" | "local" | "";
  projectArchive: Record<string, "in" | number>;
};

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
  runBudgetUsd: 0,
  privacy: "protect",
  cursorIntegration: "off",
  chatStorage: "",
  projectArchive: {},
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
