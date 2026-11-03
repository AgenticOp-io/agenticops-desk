import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

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
  // Direct model ("direct:<provider>:<model>") that reviews finished changes; empty turns it off.
  reviewer: string;
  // Models the Auto choice may use, in order ("default" is Claude Code's own model). Empty means all ready ones.
  autoModels: string[];
  privacy: "standard" | "protect" | "local";
};

const defaults = (): UiPrefs => ({
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

const str = (v: unknown) => (typeof v === "string" ? v : "");

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function normalize(raw: Partial<UiPrefs> | null | undefined): UiPrefs {
  const base = defaults();
  const r = raw ?? {};
  return {
    windowFont: clamp(Number(r.windowFont) || base.windowFont, 12, 28),
    itemFont: clamp(Number(r.itemFont) || base.itemFont, 10, 22),
    hiddenProjects: Array.isArray(r.hiddenProjects) ? r.hiddenProjects.map(String) : [],
    hiddenChats: Array.isArray(r.hiddenChats) ? r.hiddenChats.map(String) : [],
    projectOrder: Array.isArray(r.projectOrder) ? r.projectOrder.map(String) : [],
    chatOrder:
      r.chatOrder && typeof r.chatOrder === "object" && !Array.isArray(r.chatOrder)
        ? Object.fromEntries(
            Object.entries(r.chatOrder).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]),
          )
        : {},
    showCode: Boolean(r.showCode),
    expanded:
      r.expanded && typeof r.expanded === "object" && !Array.isArray(r.expanded)
        ? Object.fromEntries(Object.entries(r.expanded).map(([k, v]) => [k, Boolean(v)]))
        : {},
    lastWorkspace: str(r.lastWorkspace),
    lastChatId: str(r.lastChatId),
    openFiles: Array.isArray(r.openFiles) ? r.openFiles.map(String) : [],
    activeFile: str(r.activeFile),
    draft: str(r.draft),
    theme: r.theme === "light" ? "light" : "dark",
    reviewer: typeof r.reviewer === "string" && r.reviewer.startsWith("direct:") ? r.reviewer : "",
    autoModels: Array.isArray(r.autoModels) ? r.autoModels.filter((m): m is string => typeof m === "string").slice(0, 40) : [],
    privacy: r.privacy === "standard" || r.privacy === "local" ? r.privacy : "protect",
  };
}

export async function migrateSettingsIfNeeded() {
  const dest = settingsFile();
  try {
    await fs.access(dest);
    return;
  } catch {
    /* missing */
  }
  const appData = app.getPath("appData");
  const olds = [
    path.join(appData, "Electron", "settings.json"),
    path.join(appData, "claudedesk", "settings.json"),
  ];
  for (const old of olds) {
    if (path.normalize(old) === path.normalize(dest)) continue;
    try {
      await fs.access(old);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(old, dest);
      return;
    } catch {
      /* try next */
    }
  }
}

export async function loadSettings(): Promise<UiPrefs> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Partial<UiPrefs>;
    return normalize(raw);
  } catch {
    return defaults();
  }
}

export async function saveSettings(prefs: UiPrefs): Promise<UiPrefs> {
  const next = normalize(prefs);
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function patchSettings(partial: Partial<UiPrefs>): Promise<UiPrefs> {
  const cur = await loadSettings();
  const next = { ...cur, ...partial };
  if (!partial.lastWorkspace) next.lastWorkspace = cur.lastWorkspace;
  return saveSettings(next);
}
