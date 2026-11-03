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
  privacy: "standard" | "protect" | "local";
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
  privacy: "protect",
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
