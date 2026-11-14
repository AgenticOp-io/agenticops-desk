import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTeam, setManager, teamView } from "./team";
import { initOpsTools } from "./opsTools";
import { AUTO, autoStatus, cancelAuto, CLAUDE_DEFAULT, forgetAuto, initAuto, runAuto, wakeAuto, type AutoPayload } from "./autoRoute";
import { deleteDirectHistory, runDirect } from "./direct";
import { completeAt, quickEdit, type QuickEditRequest } from "./quickEdit";
import { chatStorage, deleteFolderRefusal, deleteWarnings, devServerCommand, installChoices, parseSymbolHits, staysInside, SYMBOL_KINDS } from "./pureFeatures";
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
import { parseDirectModel, providerStatus, pullProviderModels, setProvider } from "./providers";
import { usageReport } from "./usageLog";
import { recentActivity } from "./activityLog";
import { opsTriage } from "./opsTriage";
import { describeImage } from "./imageVision";
import { clearCredentialFiles, listCredentials, removeCredential, saveCredential } from "./credentials";
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
  runningChats,
  listModels,
  onNotificationClick,
  pendingRuns,
  probeClaude,
  refreshPlanLimits,
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
  applyProjectCleanup,
  flushLibrary,
  chatLastUsedMap,
  importCursorLibrary,
  lastUsedProjects,
  locateProject,
  moveChatToProject,
  projectCleanupPlan,
  listLibraryProjects,
  deleteChat,
  deletedChatIds,
  loadThread,
  onLibraryFlush,
  patchChat,
  searchMessages,
  rememberChats,
  rememberedChats,
  removeProject,
  saveThread,
  touchChat,
  upsertChat,
} from "./library";
import { ensureClaudeBinary } from "./claudeBinary";
import { localModelStatus, pendingSetupFile, setupLocalModel, type LocalModelStatus } from "./localModel";
import { carryProjectMemory } from "./memory";
import { convertCursorChats, readConvertReport, removeCursorFolders, reviewCursorRemoval, type ConvertReport } from "./cursorConvert";
import { canInstallUpdate, confirmPatch, installFullUpdate, updateCode } from "./patcher";
import { createWorktree, mergeWorktree, removeWorktree, worktreeCwd, worktreeFor } from "./worktrees";
import { closeMcp } from "./directMcp";
import { importOtherTools } from "./ideImport";
import {
  cloneMissingRepos,
  cloneSyncedProject,
  linkLocalRepos,
  refreshProjectRemotes,
  remoteOfPath,
  scheduleDeskSync,
  SYNC_WHILE_WORKING,
  setCursorIntegration,
  setSyncUrl,
  createSyncRepo,
  syncApplying,
  syncNow,
  syncStatus,
} from "./deskSync";
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
  run,
  runGit,
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

function dataFolder() {
  // Tests run the app against a throwaway folder, never the user's real chats and settings.
  if (process.env.AGENTICOPS_DESK_DATA) return path.resolve(process.env.AGENTICOPS_DESK_DATA);
  return path.join(app.getPath("appData"), "AgenticOps Desk");
}

let win: BrowserWindow | null = null;
const sendLocalModel = (s: LocalModelStatus) => win?.webContents.send("localModel:status", s);
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

// Pop-out windows, keyed by their frameName ("desk-popout-chats" and so on), so the main window
// can focus an already-open panel when its menu item is clicked again.
const popouts = new Map<string, BrowserWindow>();
let pendingPopout: string | null = null;

function guardNavigation(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Panels pop out as blank windows the page draws into (src/PopOut.tsx).
    if (w === win && url === "about:blank" && frameName.startsWith("desk-popout-")) {
      pendingPopout = frameName;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: win ?? undefined,
          modal: false,
          backgroundColor: "#181818",
          autoHideMenuBar: true,
          minWidth: 420,
          minHeight: 360,
        },
      };
    }
    openOutside(url);
    return { action: "deny" };
  });
  w.webContents.on("did-create-window", (child) => {
    child.setMenuBarVisibility(false);
    guardNavigation(child);
    if (pendingPopout) {
      popouts.set(pendingPopout, child);
      pendingPopout = null;
      // A pop-out must come to the front even when the main window is maximized; a freshly created
      // child window otherwise opens behind it on Windows.
      child.show();
      child.focus();
      child.setAlwaysOnTop(true);
      child.setAlwaysOnTop(false);
      child.moveTop();
      child.once("closed", () => {
        for (const [name, wnd] of popouts) if (wnd === child) popouts.delete(name);
      });
    }
    w.once("closed", () => {
      if (!child.isDestroyed()) child.close();
    });
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
  // A Mac can close the window and leave the app running. The next window has to flush its chats too.
  allowQuit = false;
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
  win.once("ready-to-show", () => {
    win?.show();
    void confirmPatch();
  });
  guardNavigation(win);
  win.on("close", (e) => {
    if (allowQuit) return;
    if (liveRunCount() > 0) {
      e.preventDefault();
      ensureTray();
      win?.hide();
      return;
    }
    // Idle close: the renderer still holds the last debounced chat saves, so flush them before
    // the window (and its pending timers) is destroyed.
    e.preventDefault();
    void flushRendererThreads().finally(() => {
      allowQuit = true;
      if (win && !win.isDestroyed()) win.close();
    });
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

// Finishes a copy that was cut short or failed. Only after the user has chosen to have chats copied.
async function convertIfChosen() {
  const { chatStorage: mode } = await loadSettings();
  if (mode !== "github" && mode !== "hybrid") return null;
  const report = (await readConvertReport()) ?? (await convertCursorChats());
  if (report.errors.length) console.error("AgenticOps Desk could not convert everything from Cursor", report.errors);
  return report;
}

function convertNote(report: ConvertReport | null) {
  if (!report) return "";
  const stored = report.converted + report.recovered + report.already;
  const partial = report.recovered ? ` ${report.recovered} had only your own messages left to recover.` : "";
  const failed = report.errors.length ? ` ${report.errors.length} could not be copied and will be tried again.` : "";
  return `${stored} of ${report.chats} chats are stored here.${partial}${failed}`;
}

async function noteInstall(text: string) {
  await fs.writeFile(path.join(app.getPath("userData"), "install-result.txt"), text.replace(/\s+/g, " ").trim(), "utf8").catch(() => undefined);
}

// Git and Hybrid need a signed-in GitHub CLI. The window is GitHub's own approval page.
async function ensureGitHubLogin(): Promise<{ ok: boolean; note: string }> {
  const home = app.getPath("home");
  const status = await run("gh", ["auth", "status"], home, 20_000);
  if (status.ok) return { ok: true, note: "GitHub is already signed in." };
  if (/ENOENT|not recognized|not found/i.test(status.output)) {
    return { ok: false, note: "Install the GitHub CLI (gh), then run the installer again." };
  }
  await new Promise<void>((resolve) => {
    const cmd = process.env.ComSpec || "cmd.exe";
    const child = spawn(
      cmd,
      ["/d", "/c", "start", "/wait", "Sign in to GitHub", "gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"],
      { windowsHide: false, stdio: "ignore" },
    );
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  const again = await run("gh", ["auth", "status"], home, 20_000);
  return again.ok ? { ok: true, note: "GitHub sign-in finished." } : { ok: false, note: again.output || "GitHub sign-in was not finished." };
}

// The installer writes install-choices.json, then waits for this. Local skips the sign-in.
async function applyInstallChoices(): Promise<number> {
  const file = path.join(app.getPath("userData"), "install-choices.json");
  let choices: ReturnType<typeof installChoices> = null;
  try {
    choices = installChoices(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    choices = null;
  }
  await fs.rm(file, { force: true }).catch(() => undefined);
  if (!choices) {
    await noteInstall("The storage choice could not be read.");
    return 1;
  }
  if (choices.importCursor) {
    await importCursorOnInstall();
    await flushLibrary();
  } else {
    await fs.writeFile(
      path.join(app.getPath("userData"), "cursor-import.json"),
      JSON.stringify({ skipped: true, projects: 0, chats: 0, workspace: null, at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }
  if (choices.importTools) {
    await importOtherTools().catch((err) => console.error("AgenticOps Desk could not import other tools' chats", err));
    await flushLibrary();
  }
  // Several GB to download, so the first normal start does it in the background instead of holding the installer.
  if (choices.localModel) await fs.writeFile(pendingSetupFile(), "{}", "utf8").catch(() => undefined);
  if (choices.storage !== "local") {
    const login = await ensureGitHubLogin();
    if (!login.ok) {
      await noteInstall(login.note);
      return 1;
    }
  }
  const result = await chooseChatStorage(choices.storage, choices.importCursor);
  await noteInstall(result.note);
  return result.ok ? 0 : 1;
}

app.whenReady().then(async () => {
  // The installer runs this and waits, so the choice is on disk before the first window.
  if (process.argv.includes("--apply-install")) {
    // shortcut: a sign-in window left open holds the installer for 10 minutes, then setup stops. Opening the app applies a choice that was never started.
    const giveUp = setTimeout(() => app.exit(1), 10 * 60_000);
    let code = 1;
    if (app.requestSingleInstanceLock()) {
      try {
        code = await applyInstallChoices();
      } catch (err) {
        console.error("AgenticOps Desk could not apply the install choice", err);
        await noteInstall(err instanceof Error ? err.message : "The install choice could not be applied.");
        code = 1;
      }
    } else {
      await noteInstall("AgenticOps Desk is already open. Close it, then run the installer again.");
    }
    clearTimeout(giveUp);
    app.exit(code);
    return;
  }
  // Kept so an older installer can still list Cursor. New installs use --apply-install.
  if (process.argv.includes("--import-cursor")) {
    // The installer waits for this, so never let a slow Cursor scan hang the install.
    const giveUp = setTimeout(() => app.exit(0), 60_000);
    let code = 0;
    if (app.requestSingleInstanceLock()) {
      try {
        // Only lists what is there. Copying waits until the user has chosen where chats live, at first start.
        await importCursorOnInstall();
        // The library saves on a timer, and app.exit below would beat it.
        await flushLibrary();
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
  // The installer could not apply this because the app was already open. The choice file is still here.
  if (existsSync(path.join(app.getPath("userData"), "install-choices.json"))) {
    try {
      await applyInstallChoices();
    } catch (err) {
      console.error("AgenticOps Desk could not apply the install choice", err);
    }
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
  clearCredentialFiles();
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
    if (!syncApplying()) scheduleDeskSync(SYNC_WHILE_WORKING);
  });
  onNotificationClick(() => showWindow());
  createWindow();
  if (existsSync(pendingSetupFile())) {
    // Removed first, so a setup that fails is retried from Settings, not on every start.
    await fs.rm(pendingSetupFile(), { force: true }).catch(() => undefined);
    void setupLocalModel(sendLocalModel);
  }
  setTimeout(() => void refreshProjectRemotes().then(() => syncNow()), 5000);
  void convertIfChosen().catch((err) => console.error("AgenticOps Desk could not convert from Cursor", err));
  setInterval(() => void syncNow(), 3 * 60_000);
  setTimeout(() => void checkAndPatch(), 30_000);
  setInterval(() => void checkAndPatch(), 6 * 60 * 60_000);
  for (const run of pendingRuns()) resumePendingRun(win, run.chatId);
  // Watch and react: new errors in a watched log go to that chat, unless it is busy or waiting on the user.
  initWatches((w, lines) => {
    const state = chatState(w.chatId);
    if (state.running || state.waiting) return false;
    void rememberedChats().then((chats) => {
      const chat = chats.find((c) => c.id === w.chatId);
      const cwd = chat?.projectPath && existsSync(chat.projectPath) ? chat.projectPath : "";
      win?.webContents.send("claude:event", {
        kind: "note",
        chatId: w.chatId,
        running: false,
        text: cwd
          ? `Watched log reported an error: ${path.basename(w.file)}`
          : `Watched log reported an error: ${path.basename(w.file)}. This chat's folder is not on this computer, so the agent did not start.`,
      });
      if (!cwd) return;
      void runFolder(w.chatId, cwd).then((folder) =>
        runClaude({
          win,
          chatId: w.chatId,
          workspace: folder,
        prompt:
          `AgenticOps Desk is watching ${w.file} for this chat, and it just logged this:\n\n\`\`\`\n${lines}\n\`\`\`\n\n` +
          "Find the cause. Fix it if the fix is clear and safe; otherwise explain what you found and what you need from me.",
        }),
      );
    });
    return true;
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The renderer saves chats on a short debounce. On quit we ask it to write every opened chat now
// and wait briefly, so the messages still in memory reach disk before the process ends.
function flushRendererThreads(timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (!wc || wc.isDestroyed()) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener("thread:flushed", onFlushed);
      resolve();
    };
    const onFlushed = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    ipcMain.once("thread:flushed", onFlushed);
    wc.send("desk:flush-threads");
  });
}

let flushingQuit = false;
app.on("before-quit", (e) => {
  allowQuit = true;
  closeAllShells();
  closeWatches();
  shutdownClaude();
  void closeMcp();
  if (flushingQuit) return;
  flushingQuit = true;
  e.preventDefault();
  void Promise.allSettled([
    saveVault(),
    Promise.race([syncNow(), new Promise((resolve) => setTimeout(resolve, 20_000))]),
    flushRendererThreads(),
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
// Add and remove only. There is deliberately no way to read a saved value back into the window.
ipcMain.handle("creds:list", () => listCredentials());
ipcMain.handle("creds:save", (_e, input: Parameters<typeof saveCredential>[0]) => saveCredential(input));
ipcMain.handle("creds:remove", (_e, name: string) => removeCredential(String(name ?? "")));
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

ipcMain.handle("cursor:projects", () => listLibraryProjects());
ipcMain.handle("projects:add", async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Add folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return listLibraryProjects();
  const dir = await addProject(result.filePaths[0], await remoteOfPath(result.filePaths[0]));
  setWorkspace(dir);
  return listLibraryProjects();
});

async function pickFolder(title: string) {
  const result = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function locateAndCarry(projectId: string, dir: string) {
  const carried = await locateProject(projectId, dir);
  if (carried?.from && carried.to) await carryProjectMemory(carried.from, carried.to);
}

// The folder a chat runs in. A chat never falls back to whichever folder is open: if it has no folder here, the user decides.
ipcMain.handle("chat:folder", async (_e, chatId: string) => {
  const find = async () => (await rememberedChats()).find((c) => c.id === chatId);
  const chat = await find();
  if (chat?.projectPath && existsSync(chat.projectPath)) return { folder: chat.projectPath, changed: false };
  if (chat?.projectId) {
    const { response } = await dialog.showMessageBox(win!, {
      type: "question",
      message: `The folder for ${chat.projectName} is not on this computer.`,
      detail: `${chat.projectPath ? `It was at ${chat.projectPath}. ` : ""}Locate the folder to run this chat. Every chat in that project follows it.`,
      buttons: ["Locate folder…", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    const dir = response === 0 ? await pickFolder(`Locate ${chat.projectName}`) : null;
    if (!dir) return null;
    await locateAndCarry(chat.projectId, dir);
    return { folder: (await find())?.projectPath ?? dir, changed: true };
  }
  const open = workspace && existsSync(workspace) ? workspace : "";
  const buttons = [...(open ? [`Use ${path.basename(open)}`] : []), "Choose folder…", "Cancel"];
  const { response } = await dialog.showMessageBox(win!, {
    type: "question",
    message: "This chat is not in a project yet.",
    detail: "Pick the folder it should run in. It stays in that project until you move it.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (response === buttons.length - 1) return null;
  const dir = open && response === 0 ? open : await pickFolder("Choose a folder for this chat");
  if (!dir) return null;
  await moveChatToProject(chatId, { folder: dir }, "first run");
  return { folder: dir, changed: true };
});
ipcMain.handle("chat:move", async (_e, chatId: string, projectId: string | null) => {
  if (projectId) return moveChatToProject(chatId, { projectId });
  const dir = await pickFolder("Move this chat to the project in…");
  return dir ? moveChatToProject(chatId, { folder: dir }) : null;
});
ipcMain.handle("project:locate", async (_e, projectId: string) => {
  const dir = await pickFolder("Locate this project's folder");
  if (!dir) return false;
  await locateAndCarry(projectId, dir);
  return true;
});
ipcMain.handle("cursor:review-removal", () => reviewCursorRemoval());
ipcMain.handle("storage:status", async () => {
  const { chatStorage: mode } = await loadSettings();
  const found = mode ? 0 : (await listCursorChats().catch(() => [])).length;
  return { mode, cursorChats: found };
});
// copyCursor is false when the installer was told not to import. Settings always copies.
async function chooseChatStorage(raw: string, copyCursor: boolean) {
  const mode = chatStorage(raw);
  if (!mode) return { ok: false, note: "Pick where chats should live." };
  if (mode === "local") {
    await setSyncUrl("");
    await patchSettings({ chatStorage: mode });
    return { ok: true, note: "Chats stay on this computer, and nothing goes to GitHub." };
  }
  const before = (await syncStatus()).url;
  const previous = (await loadSettings()).chatStorage;
  await patchSettings({ chatStorage: mode });
  const report = copyCursor ? await convertIfChosen() : null;
  const view = await (before ? syncNow() : createSyncRepo());
  if (!view.ok) {
    // A choice that cannot reach its repository is not made: the user is asked again.
    await setSyncUrl(before);
    await patchSettings({ chatStorage: previous });
    return { ok: false, note: view.note || "That repository could not be reached." };
  }
  return { ok: true, note: `Chats now sync to ${view.url}. ${convertNote(report)}`.trim() };
}
ipcMain.handle("storage:set", (_e, raw: string) => chooseChatStorage(raw, true));
// The one thing that deletes Cursor's folders. Only this dialog can start it, and Cancel is the default.
ipcMain.handle("cursor:remove-folders", async () => {
  const { response } = await dialog.showMessageBox(win!, {
    type: "warning",
    message: "Permanently delete Cursor's folders?",
    detail: "This cannot be undone. Cursor loses its settings, extensions, sign-in and chat history. Your chats are copied here first, and your project folders are not touched.",
    buttons: ["Cancel", "Delete"],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1 ? removeCursorFolders() : null;
});
ipcMain.handle("cleanup:plan", () => projectCleanupPlan());
ipcMain.handle("cleanup:apply", async (_e, merges: Array<{ from: string; to: string }>) => {
  const result = await applyProjectCleanup(Array.isArray(merges) ? merges : []);
  for (const pair of result.carried) await carryProjectMemory(pair.from, pair.to);
  return { moved: result.moved, backup: result.backup };
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
  const all = [...byId.values()];
  const filed = new Map((await rememberChats(all)).map((c) => [c.id, c]));
  return all
    .map((c) => filed.get(c.id) ?? c)
    .filter((c) => {
      if (!projectPath) return true;
      return c.projectPath && path.normalize(c.projectPath).toLowerCase() === path.normalize(projectPath).toLowerCase();
    })
    .map((c) => ({ ...c, lastUsedAt: used[c.id] ?? c.lastUsedAt ?? c.updatedAt }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
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
ipcMain.handle("thread:save", (_e, chatId: string, messages: unknown[], entered?: boolean) =>
  saveThread(chatId, messages).then(() => scheduleDeskSync(entered ? undefined : SYNC_WHILE_WORKING)),
);
ipcMain.handle("thread:load", (_e, chatId: string) => loadThread(chatId));
ipcMain.handle(
  "cursor:catchup",
  async (
    _e,
    payload: { slug?: string; id?: string; workspace?: string } | null,
  ) => {
    const chat = payload?.slug && payload.id ? { slug: payload.slug, id: payload.id } : null;
    const cwd = payload?.workspace && existsSync(payload.workspace) ? payload.workspace : "";
    if (!cwd) return { title: "", chatId: payload?.id ?? "" };
    const saved = payload?.id ? ((await loadThread(payload.id)) as Array<{ role: "user" | "assistant" | "system"; text: string }> | null) : null;
    const briefing = await catchupBriefing(cwd, chat, saved);
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
  if (!inWorkspace(filePath) && !inWorktrees(filePath)) throw new Error("Only files inside the open folder can be written.");
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

ipcMain.handle("usage:get", () => usageReport());
ipcMain.handle("activity:get", () => recentActivity());
ipcMain.handle("ops:triage", (_e, command: string) => opsTriage(String(command ?? "")));
ipcMain.handle("image:describe", (_e, img: { mediaType?: string; data?: string; name?: string }) =>
  describeImage({ mediaType: String(img?.mediaType ?? "image/png"), data: String(img?.data ?? ""), name: typeof img?.name === "string" ? img.name : undefined }),
);
ipcMain.handle("usage:plan", () => refreshPlanLimits());
ipcMain.handle("providers:list", () => providerStatus());
ipcMain.handle("providers:set", (_e, id: string, patch: { key?: string | null; models?: string[]; baseUrl?: string }) =>
  setProvider(id, patch),
);
ipcMain.handle("providers:load", async (_e, id: string) => {
  await pullProviderModels(String(id ?? ""));
  return providerStatus();
});
ipcMain.handle("localModel:status", () => localModelStatus());
ipcMain.handle("localModel:setup", () => setupLocalModel(sendLocalModel));

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
    const folder = payload.workspace && existsSync(payload.workspace) ? payload.workspace : "";
    const cwd = folder && (await runFolder(payload.chatId, folder));
    if (!cwd) {
      win?.webContents.send("claude:event", { kind: "error", chatId: payload.chatId, running: false, text: "This chat's folder is not on this computer, so nothing ran." });
      win?.webContents.send("claude:event", { kind: "done", chatId: payload.chatId, running: false, text: "Stopped." });
      return false;
    }
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
initTeam(() => win);
initOpsTools();
ipcMain.handle("team:get", () => teamView());
ipcMain.handle("team:manager", (_e, chatId: string, on: boolean) => setManager(String(chatId ?? ""), Boolean(on)));

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
  return Boolean(workspace) && staysInside(workspace, target, allowRoot);
}

function insideWorkspace(target: string) {
  return inWorkspace(target);
}

// Chats' own worktrees live under the app's data folder; their files show in the change bar and the editor.
function inWorktrees(target: string) {
  return staysInside(path.join(app.getPath("userData"), "worktrees"), target, false);
}

function canTouch(target: string, allowRoot = false) {
  return inWorkspace(target, allowRoot) || inWorktrees(target) || openedOutside.has(canon(target));
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

ipcMain.handle("claude:running", () => runningChats());
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

// Where a chat's run happens: its own worktree when it has one for this folder, otherwise the folder.
async function runFolder(chatId: string, folder: string) {
  const tree = await worktreeFor(chatId, folder);
  return tree ? worktreeCwd(tree) : folder;
}
ipcMain.handle("tools:import", () => importOtherTools());
ipcMain.handle("preview:command", async (_e, cwd: string) => {
  if (!cwd || !existsSync(cwd)) return null;
  const pkg = await fs.readFile(path.join(cwd, "package.json"), "utf8").then(JSON.parse).catch(() => null);
  return devServerCommand(pkg, await fs.readdir(cwd).catch(() => []));
});
ipcMain.handle("shell:open-external", async (_e, url: string) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});
ipcMain.handle("worktree:get", (_e, chatId: string, folder: string) => worktreeFor(String(chatId ?? ""), String(folder ?? "")));
ipcMain.handle("worktree:create", async (_e, chatId: string, folder: string) => {
  if (chatState(chatId).running) return "Stop the chat first.";
  if (!folder || !existsSync(folder)) return "This chat's folder is not on this computer.";
  const made = await createWorktree(String(chatId), folder);
  if (typeof made === "string") return made;
  // The agent's saved session belongs to the old folder; the next message starts fresh in the worktree with the chat's history.
  forgetSession(chatId);
  return made;
});
ipcMain.handle("worktree:merge", (_e, chatId: string) =>
  chatState(chatId).running ? { ok: false, note: "Stop the chat first." } : mergeWorktree(String(chatId)),
);
ipcMain.handle("worktree:remove", async (_e, chatId: string) => {
  if (chatState(chatId).running) return { ok: false, note: "Stop the chat first." };
  const first = await removeWorktree(String(chatId));
  if (first.ok) {
    forgetSession(chatId);
    return first;
  }
  const { response } = await dialog.showMessageBox(win!, {
    type: "warning",
    message: "Remove this chat's worktree anyway?",
    detail: `${first.note} Removing it deletes that work and its branch.`,
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return { ok: false, note: "" };
  const forced = await removeWorktree(String(chatId), true);
  if (forced.ok) forgetSession(chatId);
  return forced;
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
  // Kept when it holds work that isn't merged; that stays under the app's worktrees folder.
  await removeWorktree(id).catch(() => {});
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
ipcMain.handle("sync:create", () => createSyncRepo());
ipcMain.handle("sync:cursor", (_e, mode: string) => setCursorIntegration(String(mode ?? "")));
ipcMain.handle("sync:now", () => syncNow());
ipcMain.handle("sync:clone", async (_e, remote: string, projectId: string) => {
  const result = await dialog.showOpenDialog(win!, {
    title: "Folder to clone into",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, output: "Clone cancelled.", path: "" };
  const cloned = await cloneSyncedProject(String(remote ?? ""), result.filePaths[0]);
  if (cloned.ok && cloned.path) {
    await locateAndCarry(String(projectId ?? ""), cloned.path);
    setWorkspace(cloned.path);
  }
  return cloned;
});
ipcMain.handle("sync:clone-all", async () => {
  const dir = await pickFolder("Folder to clone every missing project into");
  return dir ? cloneMissingRepos(dir) : { ok: false, output: "Clone cancelled." };
});
ipcMain.handle("sync:find-repos", async () => {
  const dir = await pickFolder("Folder that holds your repositories");
  if (!dir) return { ok: false, output: "Search cancelled." };
  return { ok: true, output: (await linkLocalRepos(dir)) || "No matching repositories found there." };
});
// The one way a project's folder leaves the disk. Only this dialog can start it, Cancel is the default, and it goes to
// the Recycle Bin. shortcut: only tested on a local drive; a network drive may have no bin, so check before trusting it there.
ipcMain.handle("project:trash", async (_e, raw: string) => {
  const target = path.normalize(String(raw ?? ""));
  if (!path.isAbsolute(target) || !existsSync(target)) return { ok: false, note: "That folder is not on this computer." };
  const inside = (file: string) => {
    const rel = path.relative(target, file);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const running = new Set(runningChats());
  const refusal = deleteFolderRefusal(target, {
    home: app.getPath("home"),
    keep: [app.getAppPath(), app.getPath("userData"), process.cwd()],
    projects: (await listLibraryProjects()).map((p) => p.path).filter(Boolean),
    running: (await rememberedChats()).some((c) => c.projectPath && running.has(c.id) && inside(c.projectPath)),
  });
  if (refusal) return { ok: false, note: refusal };
  const top = await runGit(target, ["rev-parse", "--show-toplevel"]);
  const repo = top.ok && path.relative(top.output.trim(), target) === "";
  const count = async (args: string[]) => {
    const res = await runGit(target, args);
    return res.ok && res.output ? res.output.split("\n").length : 0;
  };
  const warnings = deleteWarnings({
    repo,
    remote: repo && (await count(["remote"])) > 0,
    dirty: repo ? await count(["status", "--porcelain"]) : 0,
    unpushed: repo ? await count(["log", "--oneline", "--branches", "--not", "--remotes"]) : 0,
    stashed: repo ? await count(["stash", "list"]) : 0,
  });
  const bin = process.platform === "win32" ? "Recycle Bin" : "Trash";
  const { response } = await dialog.showMessageBox(win!, {
    type: "warning",
    message: `Move ${path.basename(target)} to the ${bin}?`,
    detail: [
      target,
      ...warnings,
      warnings.length ? "" : "Everything in it is committed and pushed.",
      `Its chats stay, and the project moves to the archive. Empty the ${bin} to free the disk space.`,
    ].filter(Boolean).join("\n\n"),
    buttons: ["Cancel", `Move to ${bin}`],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return null;
  const wasOpen = workspace && inside(workspace) ? workspace : "";
  // The folder watcher holds the folder open on Windows.
  if (wasOpen) setWorkspace("");
  try {
    await shell.trashItem(target);
  } catch (err) {
    if (wasOpen) setWorkspace(wasOpen);
    return { ok: false, note: `${path.basename(target)} was not deleted. Close anything using it, such as a terminal or editor. ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, note: `Moved ${path.basename(target)} to the ${bin}.` };
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
ipcMain.handle("popout:focus", (_e, name: string) => {
  const wnd = typeof name === "string" ? popouts.get(name) : undefined;
  if (wnd && !wnd.isDestroyed()) {
    if (wnd.isMinimized()) wnd.restore();
    wnd.show();
    wnd.focus();
    // A transient raise forces the pop-out above a maximized main window on Windows.
    wnd.setAlwaysOnTop(true);
    wnd.setAlwaysOnTop(false);
    wnd.moveTop();
    return true;
  }
  return false;
});
let latestRelease: string | null = null;
async function checkAndPatch() {
  const info = await checkForUpdate();
  latestRelease = info.latest;
  const patch = await updateCode(info.latest);
  if (patch.ready && win && !win.isDestroyed()) win.setTitle("AgenticOps Desk (update ready, restart to load it)");
  return { ...info, patch, canInstall: !patch.ready && Boolean(info.latest) && canInstallUpdate() };
}
ipcMain.handle("updates:check", () => checkAndPatch());
ipcMain.handle("updates:install", async () => {
  if (!latestRelease) return "Check for updates first.";
  if (liveRunCount() > 0) return "A chat is still running. Install the update when it finishes.";
  return installFullUpdate(latestRelease);
});
ipcMain.handle("updates:restart", () => {
  app.relaunch();
  app.quit();
});

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
