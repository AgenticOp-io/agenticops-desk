import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDirect } from "./direct";
import { parseDirectModel, providerStatus, setProvider } from "./providers";
import {
  answerApproval,
  bundledClaude,
  changeBase,
  changedFiles,
  findClaudeCli,
  keepChanges,
  listModels,
  pendingRuns,
  probeClaude,
  resumePendingRun,
  revertChanges,
  runClaude,
  shutdownClaude,
  stopClaude,
} from "./claude";
import {
  catchupBriefing,
  listCursorChats,
  readCursorChat,
  searchWorkspaceFiles,
} from "./cursor";
import {
  addProject,
  chatLastUsedMap,
  lastUsedProjects,
  listLibraryProjects,
  loadThread,
  migrateLibraryIfNeeded,
  rememberChats,
  rememberProjects,
  rememberedChats,
  removeProject,
  saveThread,
  touchChat,
  upsertChat,
} from "./library";
import { loadSettings, migrateSettingsIfNeeded, patchSettings, type UiPrefs } from "./settings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setPath("userData", path.join(app.getPath("appData"), "ClaudeDesk"));

let win: BrowserWindow | null = null;
let workspace = process.cwd();
let watcher: FSWatcher | null = null;

function watchWorkspace() {
  watcher?.close();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watcher = watch(workspace, { recursive: true }, (_event, filename) => {
      const rel = String(filename ?? "");
      if (
        rel.includes("node_modules") ||
        rel.includes("dist-electron") ||
        rel.includes(`${path.sep}.git${path.sep}`) ||
        rel.startsWith(".git")
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => win?.webContents.send("workspace:changed"), 250);
    });
  } catch {
    watcher = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#181818",
    title: "ClaudeDesk",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: existsSync(path.join(__dirname, "preload.mjs"))
        ? path.join(__dirname, "preload.mjs")
        : path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win?.show());

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  await migrateLibraryIfNeeded();
  await migrateSettingsIfNeeded();
  const s = await loadSettings();
  if (s.lastWorkspace && existsSync(s.lastWorkspace)) {
    workspace = s.lastWorkspace;
  } else {
    const used = Object.entries(await lastUsedProjects()).sort((a, b) => b[1] - a[1]);
    const newest = used.find(([dir]) => dir && existsSync(dir));
    if (newest) {
      workspace = newest[0];
      void patchSettings({ lastWorkspace: workspace });
    }
  }
  watchWorkspace();
  createWindow();
  for (const run of pendingRuns()) resumePendingRun(win, run.chatId, run.workspace || workspace);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => shutdownClaude());

app.on("window-all-closed", () => {
  watcher?.close();
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("workspace:get", () => workspace);

function setWorkspace(dir: string) {
  workspace = dir;
  watchWorkspace();
  void patchSettings({ lastWorkspace: dir });
  return workspace;
}

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, prefs: Partial<UiPrefs>) => patchSettings(prefs));

ipcMain.handle("workspace:open", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Open folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return workspace;
  return setWorkspace(result.filePaths[0]);
});

ipcMain.handle("workspace:set", (_e, dir: string) => {
  if (!dir || !existsSync(dir)) return workspace;
  return setWorkspace(dir);
});

ipcMain.handle("cursor:projects", async () => {
  const list = await listLibraryProjects();
  await rememberProjects(list);
  return list;
});
ipcMain.handle("projects:add", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Add folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return listLibraryProjects();
  const dir = await addProject(result.filePaths[0]);
  setWorkspace(dir);
  return listLibraryProjects();
});
ipcMain.handle("projects:remove", async (_e, dir: string) => {
  await removeProject(dir);
  const remaining = await listLibraryProjects();
  if (workspace && keyMatch(workspace, dir)) {
    const next = remaining.find((p) => p.path && p.exists);
    if (next) setWorkspace(next.path);
  }
  return remaining;
});

function keyMatch(a: string, b: string) {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}
ipcMain.handle("cursor:chats", async (_e, projectPath?: string) => {
  let scanned: Awaited<ReturnType<typeof listCursorChats>> = [];
  try {
    scanned = await listCursorChats(projectPath);
  } catch (err) {
    console.error("ClaudeDesk chat import failed", err);
    scanned = [];
  }
  const stored = await rememberedChats();
  const used = await chatLastUsedMap();
  const byId = new Map<string, (typeof scanned)[number]>();
  for (const c of stored) if (c?.id) byId.set(c.id, c);
  for (const c of scanned) {
    if (!c?.id) continue;
    const prev = byId.get(c.id);
    byId.set(c.id, {
      ...prev,
      ...c,
      projectPath: c.projectPath || prev?.projectPath || null,
      projectName: c.projectName || prev?.projectName || "",
      title: c.title && c.title !== "Untitled chat" ? c.title : prev?.title || c.title,
      lastUsedAt: c.lastUsedAt ?? prev?.lastUsedAt,
    });
  }
  const merged = [...byId.values()]
    .filter((c) => {
      if (!projectPath) return true;
      return c.projectPath && path.normalize(c.projectPath).toLowerCase() === path.normalize(projectPath).toLowerCase();
    })
    .map((c) => ({ ...c, lastUsedAt: used[c.id] ?? c.lastUsedAt ?? c.updatedAt }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  await rememberChats(merged);
  return merged;
});
ipcMain.handle("cursor:chat", async (_e, slug: string, id: string) => {
  const saved = await loadThread(id);
  const fromCursor = slug ? await readCursorChat(slug, id) : null;
  if (saved && saved.length) {
    return {
      id,
      slug: fromCursor?.slug ?? slug,
      projectPath: fromCursor?.projectPath ?? null,
      projectName: fromCursor?.projectName ?? "",
      title: fromCursor?.title ?? "Chat",
      updatedAt: fromCursor?.updatedAt ?? Date.now(),
      size: fromCursor?.size ?? 0,
      messages: saved,
      files: fromCursor?.files ?? [],
    };
  }
  return fromCursor;
});
ipcMain.handle("cursor:touch", (_e, chatId: string, projectPath?: string | null) => touchChat(chatId, projectPath));
ipcMain.handle("cursor:upsert", (_e, chat: Parameters<typeof upsertChat>[0]) => upsertChat(chat));
ipcMain.handle("thread:save", (_e, chatId: string, messages: unknown[]) => saveThread(chatId, messages));
ipcMain.handle("thread:load", (_e, chatId: string) => loadThread(chatId));
ipcMain.handle(
  "cursor:catchup",
  async (
    _e,
    payload: { slug?: string; id?: string; workspace?: string } | null,
  ) => {
    const chat = payload?.slug && payload.id ? { slug: payload.slug, id: payload.id } : null;
    const cwd = payload?.workspace && existsSync(payload.workspace) ? payload.workspace : workspace;
    const briefing = await catchupBriefing(cwd, chat);
    const chatId = payload?.id ?? `folder-${Date.now()}`;
    runClaude({
      win,
      chatId,
      workspace: cwd,
      prompt: briefing.prompt,
    });
    return { title: briefing.title, chatId };
  },
);
ipcMain.handle("fs:search", (_e, query: string) => searchWorkspaceFiles(workspace, query));
ipcMain.handle("fs:pickFile", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Open file",
    defaultPath: workspace,
    properties: ["openFile"],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
ipcMain.handle("fs:reveal", (_e, filePath: string) => {
  if (filePath && existsSync(filePath)) shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle("fs:list", async (_e, dir: string) => {
  const root = dir || workspace;
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        !["node_modules", ".git", "dist", "dist-electron", ".vite", ".claudedesk"].includes(e.name),
    )
    .map((e) => ({
      name: e.name,
      path: path.join(root, e.name),
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
});

ipcMain.handle("fs:read", async (_e, filePath: string) => {
  const st = await fs.stat(filePath);
  if (st.size > 2_000_000) return `[[ file too large to open here: ${st.size} bytes ]]`;
  const buf = await fs.readFile(filePath);
  if (buf.includes(0)) return "[[ binary file ]]";
  return buf.toString("utf8");
});

ipcMain.handle("fs:write", async (_e, filePath: string, contents: string) => {
  await fs.writeFile(filePath, contents, "utf8");
  return true;
});

ipcMain.handle("claude:probe", () => probeClaude());

// Opens a console window running Claude Code's own sign-in, which finishes in the browser.
ipcMain.handle("claude:login", () => {
  const exe = bundledClaude() ?? findClaudeCli();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "Claude sign-in", exe, "auth", "login"], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
  return true;
});

ipcMain.handle("providers:list", () => providerStatus());
ipcMain.handle("providers:set", (_e, id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) =>
  setProvider(id, patch),
);

ipcMain.handle("claude:auth", async () => {
  const cli = bundledClaude() ?? findClaudeCli();
  const cmd = cli.toLowerCase().endsWith(".exe") ? cli : process.env.ComSpec || "cmd.exe";
  const args = cli.toLowerCase().endsWith(".exe") ? ["auth", "status"] : ["/d", "/s", "/c", `"${cli}" auth status`];
  return await new Promise<{ ok: boolean; raw: string }>((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          windowsHide: true,
          timeout: 15000,
          shell: false,
          windowsVerbatimArguments: cmd.toLowerCase().endsWith("cmd.exe"),
        },
        (err, stdout, stderr) => {
          const raw = `${stdout ?? ""}${stderr ?? ""}`.trim();
          resolve({ ok: !err && /"loggedIn"\s*:\s*true/.test(raw), raw });
        },
      );
    } catch {
      resolve({ ok: false, raw: "" });
    }
  });
});

ipcMain.handle(
  "claude:run",
  async (
    _e,
    payload: {
      prompt: string;
      resume?: boolean;
      permissionMode?: string;
      history?: Array<{ role: string; text: string }>;
      chatId: string;
      workspace?: string;
      model?: string;
      images?: Array<{ mediaType: string; data: string; name?: string }>;
    },
  ) => {
    const cwd = payload.workspace && existsSync(payload.workspace) ? payload.workspace : workspace;
    const images = Array.isArray(payload.images)
      ? payload.images
          .filter((i) => /^image\/(png|jpeg|gif|webp)$/.test(i?.mediaType) && typeof i.data === "string")
          .slice(0, 10)
      : undefined;
    const direct = typeof payload.model === "string" ? parseDirectModel(payload.model) : null;
    if (direct) {
      runDirect({
        win,
        chatId: payload.chatId,
        workspace: cwd,
        prompt: payload.prompt,
        provider: direct.provider,
        model: direct.model,
        permissionMode: payload.permissionMode,
        history: payload.history,
        images,
      });
      return true;
    }
    runClaude({
      win,
      chatId: payload.chatId,
      workspace: cwd,
      prompt: payload.prompt,
      resume: payload.resume,
      permissionMode: payload.permissionMode,
      history: payload.history,
      model: typeof payload.model === "string" && /^[\w.\-[\]]{1,80}$/.test(payload.model) ? payload.model : undefined,
      images,
    });
    return true;
  },
);

ipcMain.handle("claude:models", () => listModels());
ipcMain.handle("claude:changes", (_e, chatId: string) => changedFiles(chatId));
ipcMain.handle("claude:changeBase", (_e, chatId: string, filePath: string) => changeBase(chatId, filePath));
ipcMain.handle("claude:revert", (_e, chatId: string, paths?: string[]) => revertChanges(win, chatId, paths));
ipcMain.handle("claude:keep", (_e, chatId: string, paths?: string[]) => keepChanges(win, chatId, paths));

// Explorer actions only touch paths inside the open folder.
function insideWorkspace(target: string) {
  const rel = path.relative(workspace, path.resolve(target));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

ipcMain.handle("fs:create", async (_e, target: string, isDir: boolean) => {
  if (!insideWorkspace(target)) throw new Error("Only files inside the open folder can be created.");
  if (existsSync(target)) throw new Error(`${path.basename(target)} already exists.`);
  if (isDir) await fs.mkdir(target, { recursive: true });
  else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "", { encoding: "utf8", flag: "wx" });
  }
  return true;
});

ipcMain.handle("fs:rename", async (_e, from: string, to: string) => {
  if (!insideWorkspace(from) || !insideWorkspace(to)) throw new Error("Only files inside the open folder can be renamed.");
  if (existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`${path.basename(to)} already exists.`);
  await fs.rename(from, to);
  return true;
});

ipcMain.handle("fs:delete", async (_e, target: string) => {
  if (!insideWorkspace(target)) throw new Error("Only files inside the open folder can be deleted.");
  await shell.trashItem(target);
  return true;
});

ipcMain.handle("claude:stop", (_e, chatId?: string) => {
  stopClaude(win, chatId);
  return true;
});

ipcMain.handle(
  "claude:approve",
  (
    _e,
    payload: {
      chatId: string;
      requestId: string;
      allow: boolean;
      always?: boolean;
      answers?: Record<string, string>;
      message?: string;
    },
  ) => answerApproval(win, payload.chatId, payload.requestId, payload),
);
