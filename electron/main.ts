import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deleteDirectHistory, runDirect } from "./direct";
import { parseDirectModel, providerStatus, setProvider } from "./providers";
import {
  answerApproval,
  changeBase,
  changedFiles,
  findClaudeCli,
  forgetSession,
  keepChanges,
  liveRunCount,
  listModels,
  onNotificationClick,
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
  importCursorLibrary,
  lastUsedProjects,
  listLibraryProjects,
  deleteChat,
  deletedChatIds,
  loadThread,
  migrateLibraryIfNeeded,
  patchChat,
  searchMessages,
  rememberChats,
  rememberProjects,
  rememberedChats,
  removeProject,
  saveThread,
  touchChat,
  upsertChat,
} from "./library";
import { ensureClaudeBinary } from "./claudeBinary";
import {
  checkForUpdate,
  closeAllShells,
  closeShell,
  gitCommit,
  gitPullRequest,
  gitStatus,
  openShell,
  readProjectDoc,
  writeProjectDoc,
  writeShell,
} from "./features";
import { loadSettings, migrateSettingsIfNeeded, patchSettings, type UiPrefs } from "./settings";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setPath("userData", path.join(app.getPath("appData"), "ClaudeDesk"));

let win: BrowserWindow | null = null;
let workspace = process.cwd();
let watcher: FSWatcher | null = null;
let tray: Tray | null = null;
let allowQuit = false;

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
}

function ensureTray() {
  if (tray) return;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 80;
    buf[i * 4 + 1] = 180;
    buf[i * 4 + 2] = 60;
    buf[i * 4 + 3] = 255;
  }
  tray = new Tray(nativeImage.createFromBitmap(buf, { width: size, height: size }));
  tray.setToolTip("ClaudeDesk is still working");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show ClaudeDesk", click: () => showWindow() },
      {
        label: "Quit",
        click: () => {
          allowQuit = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showWindow());
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "release",
  "out",
  "target",
  ".next",
  ".vite",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".turbo",
  ".cache",
]);

function watchWorkspace() {
  watcher?.close();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watcher = watch(workspace, { recursive: true }, (_event, filename) => {
      const rel = String(filename ?? "");
      // Build output and dependency folders change constantly during builds; reloading on them is wasted work.
      if (rel.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => win?.webContents.send("workspace:changed"), 250);
    });
  } catch {
    watcher = null;
  }
}

// The window must only ever show ClaudeDesk: the preload gives the page full file, shell and git access.
// Links (chat replies, the preview pane) open in the system browser instead of replacing the app.
function isAppUrl(url: string) {
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) return url.startsWith(dev);
  return url.startsWith("file://");
}

function openOutside(url: string) {
  if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
}

function guardNavigation(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  w.webContents.on("will-redirect", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
  });
  w.webContents.on("will-attach-webview", (e) => e.preventDefault());
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
  guardNavigation(win);
  win.on("close", (e) => {
    if (allowQuit || liveRunCount() === 0) return;
    e.preventDefault();
    ensureTray();
    win?.hide();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// One ClaudeDesk per user: a second launch focuses the open window instead of sharing the same data files.
// The lock lives in userData, so this runs after userData is set (a test copy with its own folder is separate).
async function claimSingleInstance(): Promise<boolean> {
  // After a dev hot restart the previous instance can still be exiting, so wait for it briefly.
  const tries = process.env.VITE_DEV_SERVER_URL ? 25 : 1;
  for (let i = 0; i < tries; i++) {
    if (app.requestSingleInstanceLock()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

async function importCursorOnInstall() {
  await migrateLibraryIfNeeded();
  const result = await importCursorLibrary();
  await migrateSettingsIfNeeded();
  const s = await loadSettings();
  if (!s.lastWorkspace && result.workspace && existsSync(result.workspace)) {
    await patchSettings({ lastWorkspace: result.workspace });
  }
  await fs.writeFile(
    path.join(app.getPath("userData"), "cursor-import.json"),
    JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return result;
}

app.whenReady().then(async () => {
  // The installer runs this and waits, so projects and chats are on disk before the first window.
  if (process.argv.includes("--import-cursor")) {
    // The installer waits for this, so never let a slow Cursor scan hang the install.
    const giveUp = setTimeout(() => app.exit(0), 60_000);
    let code = 0;
    if (app.requestSingleInstanceLock()) {
      try {
        await importCursorOnInstall();
      } catch (err) {
        console.error("ClaudeDesk could not import Cursor during install", err);
        code = 1;
      }
    }
    clearTimeout(giveUp);
    app.exit(code);
    return;
  }
  if (!(await claimSingleInstance())) {
    app.quit();
    return;
  }
  await migrateLibraryIfNeeded();
  await migrateSettingsIfNeeded();
  // Import from Cursor once. People without Cursor would otherwise rescan on every launch.
  const imported = existsSync(path.join(app.getPath("userData"), "cursor-import.json"));
  if (!imported && !(await rememberedChats()).length) {
    try {
      await importCursorOnInstall();
    } catch (err) {
      console.error("ClaudeDesk could not import Cursor", err);
    }
  }
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
  onNotificationClick(() => showWindow());
  createWindow();
  for (const run of pendingRuns()) resumePendingRun(win, run.chatId, run.workspace || workspace);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  allowQuit = true;
  closeAllShells();
  shutdownClaude();
});

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

// Same key features.ts uses for a shell: case-insensitive except on Linux.
function shellKey(cwd: string) {
  const resolved = path.resolve(cwd);
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

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
  const gone = await deletedChatIds();
  const byId = new Map<string, (typeof scanned)[number]>();
  for (const c of stored) if (c?.id) byId.set(c.id, c);
  for (const c of scanned) {
    if (!c?.id || gone.has(c.id)) continue;
    const prev = byId.get(c.id);
    const scannedTitle = c.title && c.title !== "Untitled chat" ? c.title : prev?.title || c.title;
    byId.set(c.id, {
      ...prev,
      ...c,
      projectPath: c.projectPath || prev?.projectPath || null,
      projectName: c.projectName || prev?.projectName || "",
      title: prev?.titleLocked ? prev.title : scannedTitle,
      titleLocked: prev?.titleLocked,
      pinned: prev?.pinned,
      mode: prev?.mode,
      model: prev?.model,
      parentId: prev?.parentId,
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

ipcMain.handle("claude:probe", (e) =>
  probeClaude((text) => {
    if (!e.sender.isDestroyed()) e.sender.send("claude:setup", text);
  }),
);

function onPath(cmd: string) {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && existsSync(path.join(dir, cmd)));
}

// Opens a terminal running Claude Code's own sign-in, which finishes in the browser.
ipcMain.handle("claude:login", async () => {
  const exe = (await ensureClaudeBinary().catch(() => null)) ?? findClaudeCli();
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    cmd = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/c", "start", "Claude sign-in", exe, "auth", "login"];
  } else if (process.platform === "darwin") {
    const line = `'${exe.replace(/'/g, `'\\''`)}' auth login`;
    cmd = "osascript";
    args = ["-e", `tell application "Terminal" to do script ${JSON.stringify(line)}`, "-e", 'tell application "Terminal" to activate'];
  } else {
    const terms: Array<[string, string]> = [
      ["x-terminal-emulator", "-e"],
      ["gnome-terminal", "--"],
      ["konsole", "-e"],
      ["xfce4-terminal", "-x"],
      ["kitty", "--"],
      ["xterm", "-e"],
    ];
    const term = terms.find(([t]) => onPath(t));
    if (!term) return false;
    cmd = term[0];
    args = [term[1], exe, "auth", "login"];
  }
  const child = spawn(cmd, args, { detached: true, windowsHide: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
});

ipcMain.handle("providers:list", () => providerStatus());
ipcMain.handle("providers:set", (_e, id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) =>
  setProvider(id, patch),
);

ipcMain.handle("claude:auth", async () => {
  const cli = (await ensureClaudeBinary().catch(() => null)) ?? findClaudeCli();
  // Only a Windows .cmd shim needs cmd.exe; real binaries (claude.exe, or claude on macOS/Linux) run directly.
  const viaCmd = process.platform === "win32" && !cli.toLowerCase().endsWith(".exe");
  const cmd = viaCmd ? process.env.ComSpec || "cmd.exe" : cli;
  const args = viaCmd ? ["/d", "/s", "/c", `"${cli}" auth status`] : ["auth", "status"];
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

ipcMain.handle("claude:forget", (_e, chatId: string) => {
  forgetSession(chatId);
  return true;
});
ipcMain.handle("chats:patch", (_e, id: string, patch: { title?: unknown; pinned?: unknown; mode?: unknown; model?: unknown; parentId?: unknown }) =>
  patchChat(id, patch),
);
// Deleting a chat stops it and removes everything ClaudeDesk kept for it.
ipcMain.handle("chats:delete", async (_e, id: string) => {
  stopClaude(win, id);
  forgetSession(id);
  try {
    deleteDirectHistory(id);
  } catch (err) {
    console.error("ClaudeDesk could not remove direct history", err);
  }
  await deleteChat(id);
  return true;
});
ipcMain.handle("chats:search", (_e, query: string) => searchMessages(query));
ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));
ipcMain.handle("git:commit", (_e, cwd: string, message: string) => gitCommit(cwd, message));
ipcMain.handle("git:pr", (_e, cwd: string, title: string, body: string) => gitPullRequest(cwd, title, body));
ipcMain.handle("project:read", (_e, cwd: string, name: string) => readProjectDoc(cwd, name));
ipcMain.handle("project:write", (_e, cwd: string, name: string, contents: string) => writeProjectDoc(cwd, name, contents));
ipcMain.handle("shell:open", (e, cwd: string) =>
  openShell(cwd, (chunk) => {
    if (!e.sender.isDestroyed()) e.sender.send("shell:data", { cwd: shellKey(cwd), chunk });
  }),
);
ipcMain.handle("shell:write", (_e, id: string, text: string) => writeShell(id, text));
ipcMain.handle("shell:restart", (e, cwd: string) => {
  closeShell(shellKey(cwd));
  return openShell(cwd, (chunk) => {
    if (!e.sender.isDestroyed()) e.sender.send("shell:data", { cwd: shellKey(cwd), chunk });
  });
});
ipcMain.handle("shell:close", (_e, id: string) => {
  closeShell(id);
  return true;
});
ipcMain.handle("updates:check", () => checkForUpdate());
