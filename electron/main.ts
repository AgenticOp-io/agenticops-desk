import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, renameSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO, autoStatus, cancelAuto, CLAUDE_DEFAULT, forgetAuto, initAuto, runAuto, wakeAuto, type AutoPayload } from "./autoRoute";
import { deleteDirectHistory, runDirect } from "./direct";
import { completeAt, quickEdit, type QuickEditRequest } from "./quickEdit";
import { parseSymbolHits, SYMBOL_KINDS } from "./pureFeatures";
import {
  addMarketplace,
  installPlugin,
  listMarketplaces,
  listPlugins,
  pluginCommands,
  pluginDetails,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
} from "./plugins";
import { parseDirectModel, providerStatus, setProvider } from "./providers";
import { forgetPlaceholders, pinSecret, privacyStatus, saveVault, setPrivacyMode, unpinSecret } from "./privacy";
import {
  answerApproval,
  changeBase,
  changedFiles,
  chatState,
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
  onLibraryFlush,
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
import { cloneSyncedProject, scheduleDeskSync, setCursorIntegration, setSyncUrl, syncApplying, syncNow, syncStatus } from "./deskSync";
import {
  checkForUpdate,
  closeAllShells,
  closeShell,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitHistory,
  gitPull,
  gitPullRequest,
  gitPush,
  gitStatus,
  openShell,
  readProjectDoc,
  writeProjectDoc,
  writeShell,
} from "./features";
import { loadSettings, patchSettings, type UiPrefs } from "./settings";
import { buildBriefing } from "./briefing";
import { loadOrders, saveOrders, teamOrders, type Orders } from "./orders";
import { originsOf } from "./provenance";
import { addWatch, closeWatches, initWatches, listWatches, removeChatWatches, removeWatch } from "./watch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setPath("userData", dataFolder());

// The app was called ClaudeDesk before; its folder moves to the new name the first time this version starts.
// If the old folder is in use (an older copy still running), keep using it this time and move it next launch.
function dataFolder() {
  // Tests run the app against a throwaway folder, never the user's real chats and settings.
  if (process.env.AGENTICOPS_DESK_DATA) return path.resolve(process.env.AGENTICOPS_DESK_DATA);
  const appData = app.getPath("appData");
  const current = path.join(appData, "AgenticOps Desk");
  const old = path.join(appData, "ClaudeDesk");
  if (existsSync(current) || !existsSync(old)) return current;
  try {
    renameSync(old, current);
    return current;
  } catch (err) {
    console.error("AgenticOps Desk could not move the old ClaudeDesk folder yet", err);
    return old;
  }
}

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
  tray.setToolTip("AgenticOps Desk is still working");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show AgenticOps Desk", click: () => showWindow() },
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

// The window must only ever show AgenticOps Desk: the preload gives the page full file, shell and git access.
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
    title: "AgenticOps Desk",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: existsSync(path.join(__dirname, "preload.mjs"))
        ? path.join(__dirname, "preload.mjs")
        : path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

// One AgenticOps Desk per user: a second launch focuses the open window instead of sharing the same data files.
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

// Dev only: vite.config.ts tells this process when the main-process code was rebuilt, instead of killing it.
// Restart once no chat is running, so editing electron/ from inside a AgenticOps Desk chat never cuts that chat off.
let restartTimer: ReturnType<typeof setInterval> | null = null;
function restartWhenIdle() {
  if (restartTimer) return;
  const check = () => {
    if (liveRunCount() > 0) {
      if (win && !win.isDestroyed()) win.setTitle("AgenticOps Desk (new code loads when running chats finish)");
      return;
    }
    if (restartTimer) clearInterval(restartTimer);
    restartTimer = null;
    process.send?.("desk:restart");
  };
  restartTimer = setInterval(check, 2000);
  check();
}
process.on("message", (msg) => {
  if (msg !== "desk:main-rebuilt") return;
  process.send?.("desk:ack");
  restartWhenIdle();
});

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

async function importCursorOnInstall() {
  const result = await importCursorLibrary();
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
        console.error("AgenticOps Desk could not import Cursor during install", err);
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
  // Import from Cursor once. People without Cursor would otherwise rescan on every launch.
  const imported = existsSync(path.join(app.getPath("userData"), "cursor-import.json"));
  if (!imported && !(await rememberedChats()).length) {
    try {
      await importCursorOnInstall();
    } catch (err) {
      console.error("AgenticOps Desk could not import Cursor", err);
    }
  }
  const s = await loadSettings();
  setPrivacyMode(s.privacy);
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
  onLibraryFlush(() => {
    if (!syncApplying()) scheduleDeskSync();
  });
  onNotificationClick(() => showWindow());
  createWindow();
  setTimeout(() => void syncNow(), 5000);
  setInterval(() => void syncNow(), 3 * 60_000);
  for (const run of pendingRuns()) resumePendingRun(win, run.chatId, run.workspace || workspace);
  // Watch and react: new errors in a watched log go to that chat, unless it is busy or waiting on the user.
  initWatches((w, lines) => {
    const state = chatState(w.chatId);
    if (state.running || state.waiting) return false;
    void rememberedChats().then((chats) => {
      const chat = chats.find((c) => c.id === w.chatId);
      const cwd = chat?.projectPath && existsSync(chat.projectPath) ? chat.projectPath : workspace;
      win?.webContents.send("claude:event", {
        kind: "note",
        chatId: w.chatId,
        running: false,
        text: `Watched log reported an error: ${path.basename(w.file)}`,
      });
      runClaude({
        win,
        chatId: w.chatId,
        workspace: cwd,
        prompt:
          `AgenticOps Desk is watching ${w.file} for this chat, and it just logged this:\n\n\`\`\`\n${lines}\n\`\`\`\n\n` +
          "Find the cause. Fix it if the fix is clear and safe; otherwise explain what you found and what you need from me.",
      });
    });
    return true;
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let flushingQuit = false;
app.on("before-quit", (e) => {
  allowQuit = true;
  closeAllShells();
  closeWatches();
  shutdownClaude();
  if (flushingQuit) return;
  flushingQuit = true;
  e.preventDefault();
  void Promise.allSettled([
    saveVault(),
    Promise.race([syncNow(), new Promise((resolve) => setTimeout(resolve, 20_000))]),
  ]).finally(() => app.quit());
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
ipcMain.handle("settings:set", async (_e, prefs: Partial<UiPrefs>) => {
  const next = await patchSettings(prefs);
  setPrivacyMode(next.privacy);
  scheduleDeskSync();
  return next;
});
ipcMain.handle("privacy:status", () => privacyStatus());
ipcMain.handle("privacy:pin", (_e, value: string) => pinSecret(value));
ipcMain.handle("privacy:unpin", (_e, index: number) => unpinSecret(Number(index)));
ipcMain.handle("privacy:forget", () => forgetPlaceholders());

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
    console.error("AgenticOps Desk chat import failed", err);
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
ipcMain.handle("thread:save", (_e, chatId: string, messages: unknown[]) =>
  saveThread(chatId, messages).then(() => scheduleDeskSync()),
);
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

// "@name" finds declarations through git grep: fast, and it skips ignored files. Folders that are not a
// git repository get no symbols, only files.
ipcMain.handle("fs:symbols", (_e, query: string) => {
  const q = String(query ?? "");
  if (!workspace || !/^[\w$]{2,60}$/.test(q)) return [];
  const pattern = `(^|[^[:alnum:]_$])(${SYMBOL_KINDS})[[:space:]]+\\*?${q.replace(/\$/g, "\\$")}`;
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", workspace, "grep", "-n", "-I", "-i", "-E", "--max-count=5", pattern],
      { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        resolve(
          parseSymbolHits(stdout ?? "", q).map((h) => ({ ...h, path: path.join(workspace, h.file), rel: h.file.replace(/\//g, path.sep) })),
        );
      },
    );
  });
});
const openedOutside = new Set<string>();

function canon(filePath: string) {
  return path.resolve(filePath);
}

ipcMain.handle("fs:pickFile", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Open file",
    defaultPath: workspace,
    properties: ["openFile"],
  });
  const picked = result.canceled ? null : result.filePaths[0] ?? null;
  if (picked) openedOutside.add(canon(picked));
  return picked;
});
ipcMain.handle("fs:reveal", (_e, filePath: string) => {
  if (!filePath || !canTouch(filePath, true)) return false;
  if (existsSync(filePath)) shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle("fs:list", async (_e, dir: string) => {
  const root = dir || workspace;
  if (!inWorkspace(root, true)) throw new Error("Only the open folder can be listed.");
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        !["node_modules", ".git", "dist", "dist-electron", ".vite"].includes(e.name),
    )
    .map((e) => ({
      name: e.name,
      path: path.join(root, e.name),
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
});

ipcMain.handle("fs:read", async (_e, filePath: string) => {
  if (!canTouch(filePath)) throw new Error("Only files inside the open folder can be read.");
  const st = await fs.stat(filePath);
  if (st.size > 2_000_000) return `[[ file too large to open here: ${st.size} bytes ]]`;
  const buf = await fs.readFile(filePath);
  if (buf.includes(0)) return "[[ binary file ]]";
  return buf.toString("utf8");
});

ipcMain.handle("fs:write", async (_e, filePath: string, contents: string) => {
  if (!inWorkspace(filePath)) throw new Error("Only files inside the open folder can be written.");
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
    const run: AutoPayload = {
      chatId: payload.chatId,
      workspace: cwd,
      prompt: payload.prompt,
      resume: payload.resume,
      permissionMode: payload.permissionMode,
      history: payload.history,
      images,
    };
    if (payload.model === AUTO) await runAuto(win, run);
    else startRun(typeof payload.model === "string" ? payload.model : "", run);
    return true;
  },
);

// Starts one run on one model: "direct:<provider>:<model>" goes to the Direct engine, anything else to Claude Code.
function startRun(model: string, run: AutoPayload) {
  const direct = parseDirectModel(model);
  if (direct) {
    runDirect({ win, ...run, provider: direct.provider, model: direct.model });
    return;
  }
  runClaude({
    win,
    ...run,
    model: model !== CLAUDE_DEFAULT && /^[\w.\-[\]]{1,80}$/.test(model) ? model : undefined,
  });
}
initAuto(startRun);

ipcMain.handle("claude:models", () => listModels());
ipcMain.handle("edit:quick", (_e, req: QuickEditRequest) => quickEdit(req));
ipcMain.handle("edit:complete", (_e, req: Parameters<typeof completeAt>[0]) => completeAt(req).catch(() => ""));

// Claude Code plugins (marketplaces, install, enable), run through the bundled Claude Code.
ipcMain.handle("plugins:list", (_e, refresh?: boolean) => listPlugins(Boolean(refresh)));
ipcMain.handle("plugins:marketplaces", () => listMarketplaces());
ipcMain.handle("plugins:addMarketplace", (_e, source: string) => addMarketplace(String(source ?? "")));
ipcMain.handle("plugins:removeMarketplace", (_e, name: string) => removeMarketplace(String(name ?? "")));
ipcMain.handle("plugins:install", (_e, id: string, acceptSha?: string) => installPlugin(String(id ?? ""), acceptSha));
ipcMain.handle("plugins:uninstall", (_e, id: string) => uninstallPlugin(String(id ?? "")));
ipcMain.handle("plugins:enable", (_e, id: string, on: boolean) => setPluginEnabled(String(id ?? ""), Boolean(on)));
ipcMain.handle("plugins:update", (_e, id: string) => updatePlugin(String(id ?? "")));
ipcMain.handle("plugins:details", (_e, id: string) => pluginDetails(String(id ?? "")));
ipcMain.handle("plugins:commands", (_e, all?: boolean) => pluginCommands(Boolean(all)));
ipcMain.handle("plugins:updateMarketplace", (_e, name?: string) => updateMarketplace(typeof name === "string" ? name : undefined));

// The Auto model: which AIs it would try now, which are resting, and a way to wake them.
ipcMain.handle("auto:status", () => autoStatus());
ipcMain.handle("auto:wake", (_e, model?: string) => {
  wakeAuto(typeof model === "string" ? model : undefined);
  return autoStatus();
});
ipcMain.handle("claude:changes", (_e, chatId: string) => changedFiles(chatId));
ipcMain.handle("claude:changeBase", (_e, chatId: string, filePath: string) => changeBase(chatId, filePath));
ipcMain.handle("claude:revert", (_e, chatId: string, paths?: string[]) => revertChanges(win, chatId, paths));
ipcMain.handle("claude:keep", (_e, chatId: string, paths?: string[]) => keepChanges(win, chatId, paths));

// Explorer actions only touch paths inside the open folder.
function inWorkspace(target: string, allowRoot = false) {
  if (!workspace) return false;
  const rel = path.relative(path.resolve(workspace), path.resolve(target));
  if (rel === "") return allowRoot;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function insideWorkspace(target: string) {
  return inWorkspace(target);
}

function canTouch(target: string, allowRoot = false) {
  return inWorkspace(target, allowRoot) || openedOutside.has(canon(target));
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
  cancelAuto(chatId);
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
// Deleting a chat stops it and removes everything AgenticOps Desk kept for it.
ipcMain.handle("chats:delete", async (_e, id: string) => {
  stopClaude(win, id);
  forgetSession(id);
  forgetAuto(id);
  removeChatWatches(id);
  try {
    deleteDirectHistory(id);
  } catch (err) {
    console.error("AgenticOps Desk could not remove direct history", err);
  }
  await deleteChat(id);
  return true;
});
ipcMain.handle("chats:search", (_e, query: string) => searchMessages(query));
ipcMain.handle("git:status", (_e, cwd: string) => gitStatus(cwd));
ipcMain.handle("git:commit", (_e, cwd: string, message: string) => gitCommit(cwd, message));
ipcMain.handle("git:fetch", (_e, cwd: string) => gitFetch(cwd));
ipcMain.handle("git:pull", (_e, cwd: string) => gitPull(cwd));
ipcMain.handle("git:push", (_e, cwd: string) => gitPush(cwd));
ipcMain.handle("git:history", (_e, cwd: string) => gitHistory(cwd));
ipcMain.handle("git:checkout", (_e, cwd: string, branch: string) => gitCheckout(cwd, branch));
ipcMain.handle("git:pr", (_e, cwd: string, title: string, body: string) => gitPullRequest(cwd, title, body));
ipcMain.handle("sync:status", () => syncStatus());
ipcMain.handle("sync:set", (_e, url: string) => setSyncUrl(String(url ?? "")));
ipcMain.handle("sync:cursor", (_e, mode: string) => setCursorIntegration(String(mode ?? "")));
ipcMain.handle("sync:now", () => syncNow());
ipcMain.handle("sync:clone", async (_e, remote: string) => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Folder to clone into",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, output: "Clone cancelled.", path: "" };
  const cloned = await cloneSyncedProject(String(remote ?? ""), result.filePaths[0]);
  if (cloned.ok && cloned.path) {
    await addProject(cloned.path);
    setWorkspace(cloned.path);
  }
  return cloned;
});
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

// Standing orders, the "why" trail, the briefing, and watched logs.
ipcMain.handle("orders:get", (_e, cwd: string) => ({ ...loadOrders(cwd || workspace), team: teamOrders(cwd || workspace) }));
ipcMain.handle("orders:set", (_e, cwd: string, next: Partial<Orders>) => ({ ...saveOrders(cwd || workspace, next), team: teamOrders(cwd || workspace) }));
ipcMain.handle("provenance:get", (_e, file: string) => (typeof file === "string" ? originsOf(file) : []));
ipcMain.handle("briefing:get", (_e, sinceMs: number) =>
  buildBriefing({
    sinceMs: Number(sinceMs) || Date.now() - 3 * 86_400_000,
    running: (id) => chatState(id).running,
    waiting: (id) => chatState(id).waiting,
    changes: (id) => changedFiles(id).length,
  }),
);
ipcMain.handle("watch:list", (_e, chatId?: string) => listWatches(chatId));
ipcMain.handle("watch:add", async (_e, chatId: string) => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Watch a log file for errors",
    defaultPath: workspace,
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return listWatches(chatId);
  return addWatch(chatId, result.filePaths[0]);
});
ipcMain.handle("watch:remove", (_e, chatId: string, file: string) => removeWatch(chatId, file));
