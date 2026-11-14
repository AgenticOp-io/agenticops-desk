import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChatMarkdown } from "./ChatMarkdown";
import { ChangesBar } from "./ChangesBar";
import { appendStep, appendText, appendThinking, Conversation, type TranscriptMsg } from "./Conversation";
import type { DiffView } from "./CodePane";
import { Windowed } from "./Windowed";
import { PopOut, type Look } from "./PopOut";

const CodePane = lazy(() => import("./CodePane").then((m) => ({ default: m.CodePane })));
import { Composer, type ComposerHandle } from "./Composer";
import { Explorer } from "./Explorer";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Dock, type DockTab } from "./Dock";
import { Help } from "./Help";
import { Briefing, Inbox, WatchChips, WorktreeChip } from "./Extras";
import { AutoSettings, PluginsSettings } from "./Plugins";
import { PrivacySettings } from "./PrivacySettings";
import { ChatStorage } from "./ChatStorage";
import { SavedLogins } from "./SavedLogins";
import { CursorFolders } from "./CursorFolders";
import { ProjectCleanup } from "./ProjectCleanup";
import { isStale, olderChats, projectForChat } from "./sideChats";
import { SyncSettings } from "./SyncSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { UsageSettings } from "./UsageSettings";
import { extractCodeBlocks } from "./codeBlocks";
import { clamp, defaultPrefs, moveKey, PANELS, type PanelKey, type UiPrefs } from "./prefs";
import type { ApprovalRequest, BriefingItem, Team, ClaudeEvent, CursorChat, CursorProject, ImageAttachment, ModelOption, PluginCommand, RunPhase, UsageInfo, WatchInfo } from "./vite-env";

// host is the popped-out window's root when the menu was opened there.
type CtxMenu = { x: number; y: number; projectKey?: string; chatId?: string; chatTitle?: string; host?: Element };
type DragPayload = { kind: "project" | "chat"; key?: string; id?: string };
const portalTo = (host: Element | undefined, node: ReactNode) => (host ? createPortal(node, host) : node);

function parseDrag(e: DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

function setDragData(e: DragEvent, payload: DragPayload) {
  const raw = JSON.stringify(payload);
  e.dataTransfer.setData("application/json", raw);
  e.dataTransfer.setData("text/plain", raw);
  e.dataTransfer.effectAllowed = "move";
}

type Entry = { name: string; path: string; isDir: boolean };
type Msg = TranscriptMsg;
type SideGroup = { key: string; name: string; path: string; slug: string; exists: boolean; projectId?: string; chats: CursorChat[] };
type SideRow =
  | { kind: "project"; id: string; group: SideGroup }
  | { kind: "chat"; id: string; group: SideGroup; chat: CursorChat }
  | { kind: "note"; id: string; text: string }
  | { kind: "other"; id: string; count: number; open: boolean };

// Rows grow with the list's font size, so a larger font is not clipped.
function sideRowHeight(row: SideRow, font: number) {
  if (row.kind === "chat") return Math.ceil(font * 2.5) + 18;
  if (row.kind === "project") return Math.ceil(font * 1.35) + 18;
  return 32;
}
type Tab = { path: string; name: string; contents: string; dirty: boolean };
type RunProgress = { status: string; steps: string[]; phase?: RunPhase };

function phaseWord(progress?: RunProgress) {
  const text = progress?.status?.replace(/…$/, "").trim();
  if (text) return text;
  if (progress?.phase === "approval") return "Needs permission";
  return "Working";
}

// The left panel only says what kind of work is going on. What the agent is saying or running stays in the chat.
const SIDE_WORD: Record<RunPhase, string> = {
  starting: "Starting",
  thinking: "Thinking",
  tool: "Working",
  writing: "Writing",
  pushing: "Pushing",
  approval: "Needs permission",
};

function sideWord(progress?: RunProgress) {
  return progress?.phase ? SIDE_WORD[progress.phase] : "Working";
}

function phaseRank(progress?: RunProgress) {
  if (progress?.phase === "approval") return 4;
  if (progress?.phase === "pushing") return 3;
  if (progress?.phase === "writing") return 2;
  return progress ? 1 : 0;
}

function baseName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function samePath(a?: string | null, b?: string | null) {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function relTime(ms: number | null) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

const GLYPH: Record<string, string> = {
  chats: "M2.4 4.2h6.4a1 1 0 0 1 1 1v3.6a1 1 0 0 1-1 1H6.2L4.4 12v-2.2H2.4a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1ZM6.2 6.6h6.4a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H8.6",
  files: "M3.2 2.4h5.6L12.4 6v7.2a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8V3.2a.8.8 0 0 1 .8-.8ZM8.6 2.6V6h3.6",
  caret: "M6 3.5 10.5 8 6 12.5",
  chat: "M3.2 3.6h9.6v6.4H6.4L4.2 12.4V10H3.2Z",
  inbox: "M2.4 7.6a1 1 0 0 1 1-1h9.2a1 1 0 0 1 1 1v4.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V7.6ZM2 5.8 8 2.8l6 3-1 1.8H3L2 5.8Z",
  briefing: "M8 2.6a1.2 1.2 0 0 1 1.2 1.2v1.4H11a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.2a1 1 0 0 1 1-1h1.8V3.8A1.2 1.2 0 0 1 6 2.6ZM4.8 5.2h4.4V3.8H4.8v1.4Z",
  help: "M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6ZM6.4 6.4a1.6 1.6 0 1 1 3.2 0c0 .9-.5 1.4-1.2 1.9l-.4.3V9.6h-1V7.9l.6-.4c.5-.4.8-.7.8-1.1a.6.6 0 1 0-1.2 0h-1ZM8 11a.8.8 0 1 0 0-.1Z",
  settings: "M8 6.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8ZM8 2.4l1 .9 1.3-.4.4 1.2 1.2.4-.9 1 .9 1-1.2.4-.4 1.2-1.3-.4-1 .9-1-.9-1.3.4-.4-1.2-1.2-.4.9-1-.9-1 1.2-.4.4-1.2 1.3.4Z",
};

function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
      <path d={GLYPH[name]} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PermissionDialog({
  card,
  waiting,
  chatTitle,
  onAnswer,
}: {
  card: ApprovalRequest & { chatId: string };
  waiting: number;
  chatTitle?: string;
  onAnswer: (decision: { allow: boolean; always?: boolean; answers?: Record<string, string> }) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  useEffect(() => {
    setPicks({});
    setSent(false);
  }, [card.requestId]);
  const questions = card.questions ?? [];
  const ready = questions.every((q) => Boolean(picks[q.question]?.trim()));
  const choose = (question: string, label: string, multi?: boolean) => {
    setPicks((cur) => {
      if (!multi) return { ...cur, [question]: label };
      const selected = new Set((cur[question] ?? "").split(", ").filter(Boolean));
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
      return { ...cur, [question]: [...selected].join(", ") };
    });
  };
  return (
    <div className="permit-dock">
      <div className="permit" role="dialog" aria-labelledby="permit-title">
        <h2 id="permit-title">{card.summary}</h2>
        <p className="reason">
          {chatTitle ? `${chatTitle} · ` : ""}
          {card.toolName}
          {waiting > 1 ? ` · 1 of ${waiting}` : ""}
        </p>
        {card.reason && <p className="reason">{card.reason}</p>}
        {card.detail && <pre>{card.detail}</pre>}
        {questions.map((q) => (
          <div className="permit-q" key={q.question}>
            <strong>{q.header ? `${q.header}: ` : ""}{q.question}</strong>
            {q.options.map((opt) => {
              const on = (picks[q.question] ?? "").split(", ").includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`permit-opt ${on ? "on" : ""}`}
                  onClick={() => choose(q.question, opt.label, q.multiSelect)}
                >
                  <span>
                    {opt.label}
                    {opt.description && <small>{opt.description}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        <div className="permit-actions">
          <button className="btn danger" disabled={sent} onClick={() => { setSent(true); onAnswer({ allow: false }); }}>
            Deny
          </button>
          {card.canAlways && (
            <button className="btn" disabled={sent || !ready} onClick={() => { setSent(true); onAnswer({ allow: true, always: true, answers: picks }); }}>
              Allow always
            </button>
          )}
          <button className="btn primary" disabled={sent || !ready} onClick={() => { setSent(true); onAnswer({ allow: true, answers: picks }); }}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [workspace, setWorkspace] = useState("");
  const [roots, setRoots] = useState<Entry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<CursorChat | null>(null);
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [runningByChat, setRunningByChat] = useState<Record<string, boolean>>({});
  const [progressByChat, setProgressByChat] = useState<Record<string, RunProgress>>({});
  const [snippetId, setSnippetId] = useState<string | null>(null);
  const [cli, setCli] = useState<{ found: boolean; path: string; bundled?: boolean } | null>(null);
  const [authOk, setAuthOk] = useState<boolean | null>(null);
  // The result of something the user just did, shown briefly in the title bar. A chat's progress stays in the chat.
  const [status, setStatus] = useState("");
  const [setupNote, setSetupNote] = useState("");
  const [treeKey, setTreeKey] = useState(0);
  const [projects, setProjects] = useState<CursorProject[]>([]);
  const [chats, setChats] = useState<CursorChat[]>([]);
  const [filter, setFilter] = useState("");
  const [prefs, setPrefs] = useState<UiPrefs>(() => defaultPrefs());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [briefing, setBriefing] = useState<BriefingItem[] | null>(null);
  const [watches, setWatches] = useState<WatchInfo[]>([]);
  // What is typed in the message box belongs to the chat it was typed in, and survives a restart.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("desk.drafts") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const setDraft = (chatId: string, text: string) =>
    setDrafts(({ [chatId]: _old, ...rest }) => (text ? { ...rest, [chatId]: text } : rest));
  const prompt = drafts[activeChat?.id ?? ""] ?? "";
  const setPrompt = (text: string) => setDraft(activeChat?.id ?? "", text);
  useEffect(() => {
    localStorage.setItem("desk.drafts", JSON.stringify(drafts));
  }, [drafts]);

  const [askStorage, setAskStorage] = useState<{ cursorChats: number } | null>(null);
  useEffect(() => {
    void window.desk.storageStatus().then((s) => {
      if (!s.mode && s.cursorChats > 0) setAskStorage({ cursorChats: s.cursorChats });
    });
  }, []);

  const [replayFrom, setReplayFrom] = useState<{ chat: CursorChat; index: number } | null>(null);

  // Morning briefing: after 8 hours away, show where every recent chat stands.
  useEffect(() => {
    const key = "desk.lastSeen";
    const last = Number(localStorage.getItem(key)) || 0;
    if (last && Date.now() - last > 8 * 3_600_000) {
      setTimeout(() => void window.desk.briefing(Date.now() - 3 * 86_400_000).then((items) => items.length && setBriefing(items)), 2000);
    }
    const mark = () => localStorage.setItem(key, String(Date.now()));
    mark();
    const timer = window.setInterval(mark, 60_000);
    window.addEventListener("beforeunload", mark);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", mark);
    };
  }, []);
  const [dock, setDock] = useState<DockTab | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [todosByChat, setTodosByChat] = useState<Record<string, Array<{ content: string; status: string }>>>({});
  const [planByChat, setPlanByChat] = useState<Record<string, string>>({});
  const [bodyHits, setBodyHits] = useState<string[]>([]);
  const [updateNote, setUpdateNote] = useState("");
  const [updateReady, setUpdateReady] = useState(false);
  const [updateInstallable, setUpdateInstallable] = useState(false);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Projects whose "older chats" row is open, for this session.
  const [olderOpen, setOlderOpen] = useState<Set<string>>(() => new Set());
  const [sideView, setSideView] = useState<"chats" | "files">(() =>
    localStorage.getItem("desk.sideView") === "files" ? "files" : "chats",
  );
  // Popped-out Chats/Files windows are open unless closed here; the topbar button toggles them.
  const [winClosed, setWinClosed] = useState<Partial<Record<"chats" | "files", boolean>>>({});
  const [mode, setMode] = useState(() => localStorage.getItem("desk.mode") || "default");
  const [model, setModel] = useState(() => localStorage.getItem("desk.model") || "");
  const [keyAsk, setKeyAsk] = useState<{ id: string; label: string; pick: string; hint: string; key: string; busy: boolean; error: string } | null>(null);
  // Slash commands and skills from installed plugins, offered in the composer's "/" menu.
  const [pluginCmds, setPluginCmds] = useState<PluginCommand[]>([]);
  // Which AI the Auto model handed each chat's latest run to.
  const [routeByChat, setRouteByChat] = useState<Record<string, string>>({});
  useEffect(() => {
    void window.desk.pluginCommands().then(setPluginCmds).catch(() => {});
  }, []);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [localModel, setLocalModel] = useState<{ running: boolean; text: string; ok?: boolean }>({ running: false, text: "" });
  useEffect(() => {
    void window.desk.localModelStatus().then(setLocalModel);
    return window.desk.onLocalModel((s) => {
      setLocalModel(s);
      if (!s.ok) return;
      // The main process turned Summaries on; show it here without saving it back.
      void window.desk.listModels().then((list) => list.length && setModels(list));
      void window.desk.getSettings().then((p) => setPrefs((cur) => ({ ...cur, summarizer: p.summarizer })));
    });
  }, []);
  const [usageByChat, setUsageByChat] = useState<Record<string, UsageInfo>>({});
  const [changesByChat, setChangesByChat] = useState<Record<string, string[]>>({});
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickHits, setQuickHits] = useState<Array<{ name: string; path: string; rel: string }>>([]);
  const [quickIndex, setQuickIndex] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState<Array<ApprovalRequest & { chatId: string }>>([]);
  const composerRef = useRef<ComposerHandle>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  const workspaceRef = useRef(workspace);
  const activeRef = useRef(activePath);
  const autoOpenRef = useRef<string | null>(null);
  const activeChatRef = useRef<CursorChat | null>(null);
  const threadsRef = useRef(threads);
  const runningByChatRef = useRef(runningByChat);
  const threadTimers = useRef(new Map<string, number>());
  const stickToBottom = useRef(true);
  const openTicket = useRef(0);
  const messagesTop = useRef(0);
  const chatsRef = useRef(chats);
  const prefsReady = useRef(false);
  const persistIds = useRef(new Set<string>());
  // The thread array last sent to disk per chat, so the debounced save skips chats that did not change.
  const savedThreads = useRef(new Map<string, Msg[]>());
  tabsRef.current = tabs;
  workspaceRef.current = workspace;
  activeRef.current = activePath;
  activeChatRef.current = activeChat;
  threadsRef.current = threads;
  runningByChatRef.current = runningByChat;
  chatsRef.current = chats;
  const msgs = activeChat ? threads[activeChat.id] ?? [] : [];
  const running = Boolean(activeChat && runningByChat[activeChat.id]);
  const runProgress = activeChat ? progressByChat[activeChat.id] : undefined;
  // Code blocks are only needed while the code pane is open; skip the scan of every message otherwise.
  const snippets = useMemo(
    () =>
      prefs.showCode
        ? msgs.flatMap((m, i) => (m.role === "assistant" ? extractCodeBlocks(m.text, `reply${i + 1}`) : []))
        : [],
    [msgs, prefs.showCode],
  );

  const refreshTree = async (dir: string) => {
    setRoots(await window.desk.listDir(dir));
    setTreeKey((n) => n + 1);
  };

  const reloadCursor = async () => {
    setProjects(await window.desk.listCursorProjects());
    return window.desk.listCursorChats();
  };

  const reloadOpenFile = async () => {
    const current = tabsRef.current.find((t) => t.path === activeRef.current);
    if (!current || current.dirty) return;
    // The file may have been moved or deleted outside the editor; keep the tab as it was.
    const text = await window.desk.readFile(current.path).catch(() => null);
    if (text === null) return;
    setTabs((all) => all.map((t) => (t.path === current.path ? { ...t, contents: text } : t)));
  };

  const markUsed = (chatId: string, projectPath?: string | null) => {
    void window.desk.touchChat(chatId, projectPath);
    setChats((all) =>
      all.map((c) => (c.id === chatId ? { ...c, lastUsedAt: Date.now() } : c)),
    );
  };

  const focusProject = async (dir: string) => {
    if (!dir) return;
    const ws = await window.desk.setWorkspace(dir);
    setWorkspace(ws);
    await refreshTree(ws);
  };

  const addFolder = async () => {
    const list = await window.desk.addProject();
    setProjects(list);
    const ws = await window.desk.getWorkspace();
    setWorkspace(ws);
    if (ws) await refreshTree(ws);
  };

  const popped = (k: PanelKey) => prefs.popOut.includes(k);
  const patchPrefs = (partial: Partial<UiPrefs>) => {
    if (!prefsReady.current) return;
    setPrefs((p) => ({ ...p, ...partial }));
    void window.desk.saveSettings(partial);
  };

  const hideProject = (key: string) => {
    if (!key) return;
    patchPrefs({ hiddenProjects: [...new Set([...prefs.hiddenProjects, key])] });
    setMenu(null);
  };

  const unhideProject = (key: string) => {
    patchPrefs({ hiddenProjects: prefs.hiddenProjects.filter((k) => k !== key) });
    setMenu(null);
  };

  const hideChat = (id: string) => {
    if (!id) return;
    patchPrefs({ hiddenChats: [...new Set([...prefs.hiddenChats, id])] });
    setMenu(null);
  };

  const unhideChat = (id: string) => {
    const host = groups.find((g) => g.chats.some((c) => c.id === id));
    patchPrefs({
      hiddenChats: prefs.hiddenChats.filter((k) => k !== id),
      hiddenProjects: host ? prefs.hiddenProjects.filter((k) => k !== host.key) : prefs.hiddenProjects,
    });
    setMenu(null);
  };


  // Everything is fetched first and then switched together, so one click paints one change: no blank
  // pane, and no new project over the old chat. The chat on screen stays until the next one is ready.
  const openChat = async (chat: CursorChat, folder = chat.projectPath) => {
    const ticket = ++openTicket.current;
    const cached = Boolean(threadsRef.current[chat.id]);
    const moving = Boolean(folder) && !samePath(folder!, workspaceRef.current);
    const [detail, ws] = await Promise.all([
      cached ? null : window.desk.readCursorChat(chat.slug, chat.id).catch(() => null),
      moving ? window.desk.setWorkspace(folder!) : null,
    ]);
    if (ws) {
      setWorkspace(ws);
      void refreshTree(ws);
    }
    // A later click won. The folder above still follows the click order, and only the chat is dropped.
    if (ticket !== openTicket.current) return;
    if (!cached) setThreads((t) => (t[chat.id] ? t : { ...t, [chat.id]: detail?.messages ?? [] }));
    setActiveChat(chat);
    setMode(chat.mode || "default");
    setModel(chat.model ?? "");
  };

  const openProjectLatest = async (path: string, projectChats: CursorChat[]) => {
    const latest = [...projectChats].sort(
      (a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt),
    )[0];
    if (latest) await openChat(latest, path || latest.projectPath);
    else if (path) await focusProject(path);
  };

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.desk.getSettings();
        setPrefs(s);
      } catch {
        /* defaults stay until settings can be read */
      }
      prefsReady.current = true;
      try {
        const ws = await window.desk.getWorkspace();
        setWorkspace(ws);
        if (ws) await refreshTree(ws);
      } catch {
        /* folder tree is optional */
      }
      try {
        const list = await reloadCursor();
        setChats(list);
      } catch {
        setStatus("Could not load chats");
      }
      // A first-launch download can run for a while, so this stays up until it ends.
      const stopSetup = window.desk.onSetup(setSetupNote);
      try {
        setCli(await window.desk.probeClaude());
        const auth = await window.desk.authStatus();
        setAuthOk(auth.ok);
      } catch {
        setAuthOk(false);
      } finally {
        stopSetup();
        setSetupNote("");
      }
    })();
  }, []);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 8000);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const patchThread = (chatId: string, fn: (m: Msg[]) => Msg[]) => {
      setThreads((t) => ({ ...t, [chatId]: fn(t[chatId] ?? []) }));
    };
    const offClaude = window.desk.onClaudeEvent((ev: ClaudeEvent) => {
      const chatId = ev.chatId;
      if (!chatId) return;
      persistIds.current.add(chatId);
      if (ev.running !== undefined) {
        setRunningByChat((r) => ({ ...r, [chatId]: ev.running as boolean }));
      }
      if (ev.kind === "status" && ev.text) {
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: ev.text ?? "", steps: p[chatId]?.steps ?? [], phase: ev.phase ?? p[chatId]?.phase },
        }));
      }
      if (ev.kind === "approval" && ev.approval) {
        const card = { ...ev.approval, chatId };
        setPendingApprovals((list) => [...list.filter((a) => a.requestId !== card.requestId), card]);
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: card.summary, steps: p[chatId]?.steps ?? [], phase: "approval" },
        }));
      }
      if (ev.kind === "changes") {
        setChangesByChat((c) => ({ ...c, [chatId]: ev.files ?? [] }));
      }
      if (ev.kind === "usage" && ev.usage) {
        // Each run reports its own cost; add them up so the meter shows the chat's total since launch.
        setUsageByChat((u) => ({ ...u, [chatId]: { ...ev.usage!, costUsd: (u[chatId]?.costUsd ?? 0) + ev.usage!.costUsd } }));
      }
      if (ev.kind === "approval_done") {
        setPendingApprovals((list) => list.filter((a) => a.requestId !== ev.id));
      }
      if (ev.kind === "tool" && ev.text) {
        setProgressByChat((p) => {
          const cur = p[chatId] ?? { status: ev.text ?? "", steps: [] };
          const steps = cur.steps[cur.steps.length - 1] === ev.text ? cur.steps : [...cur.steps, ev.text ?? ""].slice(-12);
          return {
            ...p,
            [chatId]: { status: ev.text ?? cur.status, steps, phase: ev.phase ?? cur.phase ?? "tool" },
          };
        });
        patchThread(chatId, (m) => appendStep(m, ev.text ?? ""));
      }
      if (ev.kind === "thinking" && ev.text) {
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: "Thinking…", steps: p[chatId]?.steps ?? [], phase: "thinking" },
        }));
        patchThread(chatId, (m) => appendThinking(m, ev.text ?? ""));
      }
      if (ev.kind === "line" && ev.text) {
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: "Writing the reply…", steps: p[chatId]?.steps ?? [], phase: "writing" },
        }));
        patchThread(chatId, (m) => appendText(m, ev.text ?? ""));
      }
      if (ev.kind === "error" && ev.text) {
        patchThread(chatId, (m) => [...m, { role: "error", text: ev.text ?? "" }]);
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: ev.text ?? "Error", steps: p[chatId]?.steps ?? [] },
        }));
      }
      if (ev.kind === "todos" && ev.todos) {
        setTodosByChat((cur) => ({ ...cur, [chatId]: ev.todos ?? [] }));
      }
      if (ev.kind === "route" && ev.text) {
        setRouteByChat((cur) => ({ ...cur, [chatId]: ev.text ?? "" }));
      }
      if (ev.kind === "note" && ev.text) {
        patchThread(chatId, (m) => [...m, { role: "system", text: ev.text ?? "" }]);
      }
      if (ev.kind === "plan" && ev.text) {
        setPlanByChat((cur) => ({ ...cur, [chatId]: ev.text ?? "" }));
      }
      if (ev.kind === "done") {
        if (activeChatRef.current?.id !== chatId && typeof Notification !== "undefined") {
          const title = chatsRef.current.find((c) => c.id === chatId)?.title ?? "A chat";
          new Notification("AgenticOps Desk", { body: `${title} finished` });
        }
        setPendingApprovals((list) => list.filter((a) => a.chatId !== chatId));
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: ev.text ?? "Done.", steps: p[chatId]?.steps ?? [] },
        }));
        const ws = workspaceRef.current;
        if (ws) void refreshTree(ws);
        void reloadOpenFile();
        const pendingSave = threadTimers.current.get(chatId);
        if (pendingSave) {
          window.clearTimeout(pendingSave);
          threadTimers.current.delete(chatId);
        }
        const msgs = threadsRef.current[chatId];
        if (msgs) {
          savedThreads.current.set(chatId, msgs);
          void window.desk.saveThread(chatId, msgs, true);
        }
        const row = activeChatRef.current?.id === chatId ? activeChatRef.current : null;
        if (row) void window.desk.upsertChat({ ...row, updatedAt: Date.now() });
      }
    });
    const offWatch = window.desk.onWorkspaceChanged(() => {
      const ws = workspaceRef.current;
      if (ws) void refreshTree(ws);
      void reloadOpenFile();
    });
    return () => {
      offClaude();
      offWatch();
    };
  }, []);

  useEffect(() => {
    if (!chats.length || autoOpenRef.current) return;
    const mine = chats.filter(
      (c) => c.projectPath && c.projectPath.toLowerCase() === workspace.toLowerCase(),
    );
    const first = mine[0] ?? chats[0];
    autoOpenRef.current = first.id;
    void openChat(first);
  }, [chats, workspace]);

  // A chat always opens at its last message, wherever the previous one was scrolled to.
  // Layout effects, so the first paint of a chat is already at its end instead of its top.
  useLayoutEffect(() => {
    stickToBottom.current = true;
  }, [activeChat?.id]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (stickToBottom.current && el) el.scrollTop = el.scrollHeight;
  }, [msgs, running, activeChat?.id]);

  // Fonts and rendered blocks can grow a message after it is drawn; that must not strand the view above the end.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const grown = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    // The pane itself too: opening a panel below the chat shrinks it.
    grown.observe(el);
    for (const child of el.children) grown.observe(child);
    return () => grown.disconnect();
  }, [msgs, activeChat?.id]);

  useEffect(() => {
    const ids = [...persistIds.current].filter(
      (id) => id in threads && savedThreads.current.get(id) !== threads[id],
    );
    for (const id of ids) {
      const pending = threadTimers.current.get(id);
      const streaming = Boolean(runningByChatRef.current[id]);
      if (streaming && pending) continue;
      if (pending) window.clearTimeout(pending);
      const timer = window.setTimeout(() => {
        threadTimers.current.delete(id);
        const next = threadsRef.current[id];
        if (!next || savedThreads.current.get(id) === next) return;
        savedThreads.current.set(id, next);
        void window.desk.saveThread(id, next);
      }, streaming ? 8000 : 800);
      threadTimers.current.set(id, timer);
    }
  }, [threads]);

  // Debounced saves above mean the last few seconds of a chat live only in memory. On quit the main
  // process asks for this, and it writes every opened chat before the window is destroyed.
  const flushThreads = useCallback(async () => {
    for (const timer of threadTimers.current.values()) window.clearTimeout(timer);
    threadTimers.current.clear();
    const entries = Object.entries(threadsRef.current);
    if (!entries.length) return;
    await Promise.allSettled(
      entries.map(([id, next]) => {
        savedThreads.current.set(id, next);
        return window.desk.saveThread(id, next, true);
      }),
    );
  }, []);

  useEffect(() => {
    const offFlush = window.desk.onFlushThreads(() => {
      void flushThreads().finally(() => window.desk.threadsFlushed());
    });
    return offFlush;
  }, [flushThreads]);

  useEffect(() => {
    if (!quickOpen) return;
    const t = setTimeout(() => {
      void window.desk.searchFiles(quickQuery).then((hits) => {
        setQuickHits(hits);
        setQuickIndex(0);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [quickOpen, quickQuery]);

  useEffect(() => localStorage.setItem("desk.sideView", sideView), [sideView]);
  useEffect(() => localStorage.setItem("desk.mode", mode), [mode]);
  useEffect(() => localStorage.setItem("desk.model", model), [model]);

  useEffect(() => {
    void window.desk.listModels().then((list) => {
      if (list.length) setModels(list);
    });
    return window.desk.onClaudeEvent((ev) => {
      if (ev.kind === "models" && ev.models?.length) setModels(ev.models);
    });
  }, []);

  // Changes live in the main process, so a chat opened later still shows what Claude changed in it.
  const activeChatId = activeChat?.id;
  useEffect(() => {
    if (!activeChatId) {
      setWatches([]);
      return;
    }
    void window.desk.listWatches(activeChatId).then(setWatches);
  }, [activeChatId]);
  useEffect(() => {
    if (!activeChatId) return;
    setDiff(null);
    void window.desk.changedFiles(activeChatId).then((files) =>
      setChangesByChat((c) => ({ ...c, [activeChatId]: files })),
    );
  }, [activeChatId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === "F1" || ((e.ctrlKey || e.metaKey) && e.key === "/")) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setSideView((v) => (v === "files" ? "chats" : "files"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        composerRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newAgent();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen(true);
        setQuickQuery("");
        setTimeout(() => quickRef.current?.focus(), 0);
      }
      if (e.key === "Escape") {
        setQuickOpen(false);
        setShowHelp(false);
        setShowSettings(false);
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openFilePath = async (filePath: string) => {
    const existing = tabsRef.current.find((t) => t.path === filePath);
    patchPrefs({ showCode: true });
    setSnippetId(null);
    setDiff(null);
    if (existing) {
      setActivePath(filePath);
      return;
    }
    const text = await window.desk.readFile(filePath);
    const tab: Tab = { path: filePath, name: baseName(filePath), contents: text, dirty: false };
    setTabs((all) => [...all.filter((t) => t.path !== filePath), tab]);
    setActivePath(filePath);
  };


  const saveTab = async (filePath: string) => {
    const tab = tabsRef.current.find((t) => t.path === filePath);
    if (!tab) return;
    const contents = tab.contents;
    await window.desk.writeFile(filePath, contents);
    // Only clear the dot if nothing was typed while the save was in flight.
    setTabs((all) => all.map((t) => (t.path === filePath && t.contents === contents ? { ...t, dirty: false } : t)));
    setStatus(`Saved ${baseName(filePath)}`);
  };

  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem("desk.chatWidth"));
    return saved >= 320 && saved <= 1200 ? saved : 460;
  });

  const startChatResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    let latest = startW;
    const move = (ev: MouseEvent) => {
      latest = clamp(startW - (ev.clientX - startX), 320, Math.max(320, window.innerWidth - 700));
      setChatWidth(latest);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("desk.chatWidth", String(latest));
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const closeTab = (filePath: string) => {
    const tab = tabsRef.current.find((t) => t.path === filePath);
    if (tab?.dirty && !window.confirm(`${tab.name} has unsaved changes. Close it anyway?`)) return;
    setTabs((all) => {
      const next = all.filter((t) => t.path !== filePath);
      if (activePath === filePath) setActivePath(next.at(-1)?.path ?? null);
      return next;
    });
  };

  const newAgent = () => {
    const id = crypto.randomUUID();
    const chat: CursorChat = {
      id,
      slug: projects.find((p) => p.path.toLowerCase() === workspace.toLowerCase())?.slug ?? "",
      projectPath: workspace,
      projectName: baseName(workspace),
      title: "New agent",
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
      size: 0,
    };
    persistIds.current.add(id);
    setThreads((t) => ({ ...t, [id]: [] }));
    setActiveChat(chat);
    setChats((all) => [chat, ...all.filter((c) => c.id !== id)]);
    composerRef.current?.focus();
    void window.desk.upsertChat(chat);
    markUsed(id, workspace);
  };

  // Null means the user declined to pick a folder, so nothing should run.
  const placeChat = async (chat: CursorChat) => {
    const placed = await window.desk.chatFolder(chat.id);
    if (!placed) {
      setStatus("Not sent. This chat needs a folder first.");
      return null;
    }
    if (!placed.changed) return { folder: placed.folder, chat };
    const list = await reloadCursor();
    setChats(list);
    await focusProject(placed.folder);
    return { folder: placed.folder, chat: list.find((c) => c.id === chat.id) ?? chat };
  };

  const send = async (
    // quiet: sent by a manager chat, so the user stays in the chat they are reading.
    extra: { images: ImageAttachment[]; mentions: string[]; text?: string; chat?: CursorChat; model?: string; quiet?: boolean } = {
      images: [],
      mentions: [],
    },
  ) => {
    const typed = (extra.text ?? prompt).trim();
    const wanted = extra.chat ?? activeChat;
    const useModel = extra.model ?? model;
    if ((!typed && !extra.images.length) || !wanted) return;
    const guiding = Boolean(runningByChat[wanted.id]);
    // A guide goes to the run already going, wherever it is.
    const placed = guiding ? { folder: wanted.projectPath || workspace, chat: wanted } : await placeChat(wanted);
    if (!placed) return;
    const chat = placed.chat;
    const text = typed || "(see attached image)";
    persistIds.current.add(chat.id);
    // A new message after a finished run accepts that run's edits. A guide during a run leaves them in place.
    if (!guiding && (changesByChat[chat.id] ?? []).length) {
      setChangesByChat((c) => ({ ...c, [chat.id]: [] }));
      if (diff) setDiff(null);
      void window.desk.keepChanges(chat.id);
    }
    const titled =
      chat.title === "New agent" || chat.title === "Untitled chat"
        ? { ...chat, title: text.slice(0, 72), updatedAt: Date.now(), lastUsedAt: Date.now(), mode, model: useModel }
        : { ...chat, updatedAt: Date.now(), lastUsedAt: Date.now(), mode, model: useModel };
    setActiveChat((cur) => (extra.quiet && cur?.id !== chat.id ? cur : titled));
    setChats((all) => all.map((c) => (c.id === chat.id ? titled : c)));
    void window.desk.upsertChat(titled);
    const shown = extra.images.length
      ? `${text}\n\n*${extra.images.length} image${extra.images.length === 1 ? "" : "s"} attached*`
      : text;
    const nextMsgs = [
      ...(threadsRef.current[chat.id] ?? []),
      { role: "user" as const, text: shown, ...(guiding ? { steer: true } : {}) },
    ];
    setThreads((t) => ({ ...t, [chat.id]: nextMsgs }));
    void window.desk.saveThread(chat.id, nextMsgs, true);
    // A replay sends other text, so what is in the box stays.
    if (extra.text === undefined) setDraft(chat.id, "");
    setProgressByChat((p) => ({
      ...p,
      [chat.id]: guiding
        ? { ...(p[chat.id] ?? { steps: [], phase: "thinking" }), status: "Following your instruction…" }
        : { status: "Starting…", steps: [], phase: "starting" },
    }));
    markUsed(chat.id, placed.folder);
    const history = nextMsgs
      .slice(0, -1)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text }));
    // @-mentioned files go to Claude as absolute paths it can open with Read.
    const promptText = extra.mentions.length
      ? `${text}\n\nFiles the user referenced with @:\n${extra.mentions.map((p) => `- ${p}`).join("\n")}`
      : text;
    await window.desk.runClaude({
      prompt: promptText,
      history,
      chatId: chat.id,
      workspace: placed.folder,
      permissionMode: mode,
      model: useModel || undefined,
      images: extra.images.length ? extra.images : undefined,
    });
  };

  const [team, setTeam] = useState<Team>({ managers: [], workers: {} });
  const teamRef = useRef({ send, chats });
  teamRef.current = { send, chats };
  useEffect(() => {
    void window.desk.getTeam().then(setTeam);
    return window.desk.onTeam((kind, order) => {
      const { send: sendNow, chats: all } = teamRef.current;
      if (kind === "send") {
        const chat = all.find((c) => c.id === order.id);
        if (chat && order.text) void sendNow({ images: [], mentions: [], text: order.text, chat, quiet: true });
        return;
      }
      const boss = all.find((c) => c.id === order.managerId);
      if (!boss || !order.prompt) return;
      const chat: CursorChat = {
        ...boss,
        id: order.id,
        title: order.title || "Worker",
        model: order.model || boss.model,
        pinned: false,
        parentId: undefined,
        updatedAt: Date.now(),
        lastUsedAt: Date.now(),
        size: 0,
      };
      persistIds.current.add(chat.id);
      setThreads((t) => ({ ...t, [chat.id]: [] }));
      setChats((list) => [chat, ...list.filter((c) => c.id !== chat.id)]);
      void window.desk.getTeam().then(setTeam);
      void window.desk.upsertChat(chat).then(() =>
        sendNow({ images: [], mentions: [], text: order.prompt, chat, model: order.model, quiet: true }),
      );
    });
  }, []);
  const toggleManager = async (chat: CursorChat) => {
    const r = await window.desk.setManager(chat.id, !team.managers.includes(chat.id));
    if (typeof r === "string") setStatus(r);
    else {
      setTeam(r);
      setStatus(r.managers.includes(chat.id) ? `“${chat.title}” can now start and direct worker chats` : `“${chat.title}” is no longer a manager`);
    }
  };

  const activeChanges = activeChat ? changesByChat[activeChat.id] ?? [] : [];

  const openReview = async (filePath: string) => {
    const chat = activeChat;
    if (!chat) return;
    const before = await window.desk.changeBase(chat.id, filePath);
    const after = await window.desk.readFile(filePath).catch(() => "");
    patchPrefs({ showCode: true });
    setDiff({ path: filePath, before: before ?? "", after, created: before === null });
  };

  const afterChangeAction = async (chatId: string, remaining: string[]) => {
    setChangesByChat((c) => ({ ...c, [chatId]: remaining }));
    // Close the review of a file that is now kept or undone; never jump the editor to another diff.
    const keep = new Set(remaining.map((p) => p.toLowerCase()));
    if (diff && !keep.has(diff.path.toLowerCase())) setDiff(null);
    const ws = workspaceRef.current;
    if (ws) void refreshTree(ws);
    // Reload clean tabs so an undo shows up in the editor right away.
    for (const t of tabsRef.current) {
      if (t.dirty) continue;
      const text = await window.desk.readFile(t.path).catch(() => null);
      if (text !== null) setTabs((all) => all.map((x) => (x.path === t.path && !x.dirty ? { ...x, contents: text } : x)));
    }
  };

  const keepChanges = async (paths?: string[]) => {
    const chat = activeChat;
    if (!chat) return;
    await afterChangeAction(chat.id, await window.desk.keepChanges(chat.id, paths));
  };

  const undoChanges = async (paths?: string[]) => {
    const chat = activeChat;
    if (!chat) return;
    await afterChangeAction(chat.id, await window.desk.revertChanges(chat.id, paths));
    setStatus(paths?.length === 1 ? `Undid the agent's changes to ${baseName(paths[0])}` : "Undid the agent's changes");
  };

  const catchUp = async () => {
    if (!activeChat || runningByChat[activeChat.id]) return;
    const placed = await placeChat(activeChat);
    if (!placed) return;
    const { chat, folder: cwd } = placed;
    persistIds.current.add(chat.id);
    setThreads((t) => ({
      ...t,
      [chat.id]: [
        ...(t[chat.id] ?? []),
        { role: "user", text: `Catch the agent up on “${chat.title}”.` },
      ],
    }));
    markUsed(chat.id, cwd);
    setProgressByChat((p) => ({ ...p, [chat.id]: { status: "Starting…", steps: [], phase: "starting" } }));
    await window.desk.catchClaudeUp({
      slug: chat.slug || undefined,
      id: chat.id,
      workspace: cwd,
    });
  };

  const storeChat = (chat: CursorChat) => {
    setChats((all) => all.map((c) => (c.id === chat.id ? chat : c)));
    setActiveChat((cur) => (cur?.id === chat.id ? chat : cur));
    void window.desk.patchChat(chat.id, chat);
  };

  const [movingChat, setMovingChat] = useState<CursorChat | null>(null);

  const moveChatTo = async (chat: CursorChat, projectId: string | null) => {
    setMovingChat(null);
    const moved = await window.desk.moveChat(chat.id, projectId);
    if (!moved) return;
    const list = await reloadCursor();
    setChats(list);
    setActiveChat((cur) => (cur?.id === chat.id ? list.find((c) => c.id === chat.id) ?? cur : cur));
    setStatus(`Moved “${chat.title}” to ${moved.projectName}`);
  };

  // Electron has no window.prompt, so renaming edits the title in place in the sidebar.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameChat = (chat: CursorChat) => setRenamingId(chat.id);
  const commitRename = (chat: CursorChat, raw: string) => {
    setRenamingId(null);
    const title = raw.trim();
    if (!title || title === chat.title) return;
    storeChat({ ...chat, title });
  };

  const togglePin = (chat: CursorChat) => storeChat({ ...chat, pinned: !chat.pinned });

  const removeChat = async (chat: CursorChat) => {
    if (!window.confirm(`Delete “${chat.title}”?`)) return;
    await window.desk.stopClaude(chat.id);
    await window.desk.deleteChat(chat.id);
    setChats((all) => all.filter((c) => c.id !== chat.id));
    setThreads((t) => {
      const next = { ...t };
      delete next[chat.id];
      threadsRef.current = next;
      return next;
    });
    if (activeChatRef.current?.id === chat.id) setActiveChat(null);
  };

  const branchFrom = async (chat: CursorChat, messages: Msg[]) => {
    const id = `branch-${Date.now()}`;
    const copy: CursorChat = {
      ...chat,
      id,
      title: `Branch of ${chat.title}`.slice(0, 80),
      parentId: chat.id,
      pinned: false,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    persistIds.current.add(id);
    const nextThreads = { ...threadsRef.current, [id]: messages };
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    setChats((all) => [copy, ...all]);
    setActiveChat(copy);
    await window.desk.upsertChat(copy);
    await window.desk.saveThread(id, messages);
    setStatus(`Branched “${chat.title}”`);
    return copy;
  };

  // Replay: the same request on another model, in a branch, so the two answers can be compared.
  const replayOn = async (value: string) => {
    const from = replayFrom;
    setReplayFrom(null);
    if (!from) return;
    const all = threadsRef.current[from.chat.id] ?? [];
    const request = all[from.index]?.text ?? "";
    if (!request) return;
    const label = models.find((m) => m.value === value)?.displayName ?? (value || "default model");
    const copy = await branchFrom({ ...from.chat, title: `${from.chat.title} · ${label}` }, all.slice(0, from.index));
    setModel(value);
    await send({ images: [], mentions: [], text: request, chat: copy, model: value });
  };

  const applyModel = (value: string) => {
    setModel(value);
    const chat = activeChatRef.current;
    if (chat) storeChat({ ...chat, model: value });
  };

  const refreshModels = async () => {
    const list = await window.desk.listModels();
    if (list.length) setModels(list);
    return list;
  };

  const ipcText = (err: unknown) =>
    err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

  // Picking an API model that isn't set up asks for the key here, then loads that provider's models.
  const chooseModel = (value: string) => {
    const opt = models.find((m) => m.value === value);
    if (opt?.needsSetup === "models") {
      const id = value.slice("setup:".length);
      void window.desk
        .loadProviderModels(id)
        .then(async () => {
          const list = await refreshModels();
          const first = list.find((m) => m.value.startsWith(`direct:${id}:`) && !m.needsSetup);
          if (first) applyModel(first.value);
          else setStatus("No models came back.");
        })
        .catch((err) => setStatus(ipcText(err)));
      return;
    }
    if (opt?.needsSetup === "key") {
      const id = value.startsWith("setup:") ? value.slice("setup:".length) : (value.split(":")[1] ?? "");
      setKeyAsk({ id, label: opt.group?.replace(/^Direct · /, "") ?? id, pick: value.startsWith("direct:") ? value : "", hint: opt.description ?? "", key: "", busy: false, error: "" });
      return;
    }
    applyModel(value);
  };

  const saveKeyAsk = async () => {
    if (!keyAsk?.key.trim() || keyAsk.busy) return;
    const ask = keyAsk;
    setKeyAsk({ ...ask, busy: true, error: "" });
    try {
      await window.desk.setProvider(ask.id, { key: ask.key.trim() });
      let note = "";
      try {
        await window.desk.loadProviderModels(ask.id);
      } catch (err) {
        note = ipcText(err);
      }
      const list = await refreshModels();
      const usable = (m: ModelOption) => m.value.startsWith(`direct:${ask.id}:`) && !m.needsSetup;
      const pick = (ask.pick && list.some((m) => m.value === ask.pick && usable(m)) ? ask.pick : list.find(usable)?.value) ?? "";
      if (!pick) {
        setKeyAsk({ ...ask, busy: false, error: note || "The key was saved, but no models were listed." });
        return;
      }
      applyModel(pick);
      setKeyAsk(null);
      if (note) setStatus(`${note} The key is saved.`);
    } catch (err) {
      setKeyAsk({ ...ask, busy: false, error: ipcText(err) });
    }
  };

  // One handler for the floating card and the inbox.
  const answerCard = (card: ApprovalRequest & { chatId: string }, decision: { allow: boolean; always?: boolean; answers?: Record<string, string> }) => {
    setPendingApprovals((list) => list.filter((a) => a.requestId !== card.requestId));
    void window.desk.answerApproval({ chatId: card.chatId, requestId: card.requestId, ...decision });
  };

  const openChatById = (id: string) => {
    const chat = chatsRef.current.find((c) => c.id === id);
    if (chat) void openChat(chat);
  };

  const showBriefing = () =>
    void window.desk.briefing(Date.now() - 3 * 86_400_000).then((items) => setBriefing(items));

  const watchLog = (chatId: string) =>
    void window.desk.addWatch(chatId).then((list) => {
      if (activeChatRef.current?.id === chatId) setWatches(list);
      if (list.length) setStatus("Watching for errors. This chat reacts when one appears.");
    });

  const rewindTo = async (index: number, resend: boolean) => {
    const chat = activeChatRef.current;
    if (!chat) return;
    const all = threadsRef.current[chat.id] ?? [];
    const prior = resend ? all.slice(0, index) : all.slice(0, index + 1);
    const again = resend ? all[index]?.text ?? "" : "";
    await window.desk.forgetSession(chat.id);
    const nextThreads = { ...threadsRef.current, [chat.id]: prior };
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    await window.desk.saveThread(chat.id, prior);
    if (resend && again) {
      await send({ images: [], mentions: [], text: again });
      return;
    }
    setStatus("Rewound this chat. Send continues from here.");
  };

  // Opens Settings to one sub-panel (Plugins, Auto model, etc.).
  const openSettingsAt = (id: string) => {
    setSettingsSection(id);
    setShowSettings(true);
  };

  const runCommand = (command: string) => {
    const chat = activeChatRef.current;
    if (command === "help") setShowHelp(true);
    else if (command === "agent") setMode("default");
    else if (command === "plan") setMode("plan");
    else if (command === "auto") setMode("acceptEdits");
    else if (command === "catchup") void catchUp();
    else if (command === "terminal" || command === "git" || command === "preview" || command === "notes" || command === "rules") {
      setDock((cur) => (cur === command ? null : command));
    } else if (command === "rename" && chat) renameChat(chat);
    else if (command === "pin" && chat) togglePin(chat);
    else if (command === "branch" && chat) void branchFrom(chat, threadsRef.current[chat.id] ?? []);
    else if (command === "theme") patchPrefs({ theme: prefs.theme === "light" ? "dark" : "light" });
    else if (command === "palette") setPaletteOpen(true);
    else if (command === "plugins") openSettingsAt("plugins");
    else if (command === "autopick") openSettingsAt("models");
    else if (command === "inbox") setInboxOpen(true);
    else if (command === "briefing") showBriefing();
    else if (command === "watch" && chat) watchLog(chat.id);
  };

  const paletteActions: PaletteAction[] = [
    { id: "new", label: "New chat", hint: "Ctrl+N", run: () => newAgent() },
    { id: "help", label: "Help", hint: "F1", run: () => setShowHelp(true) },
    { id: "settings", label: "Settings", run: () => { setSettingsSection(""); setShowSettings(true); } },
    { id: "plugins", label: "Plugins: browse and install", run: () => openSettingsAt("plugins") },
    { id: "auto", label: "Auto model: which AIs and in what order", run: () => openSettingsAt("models") },
    { id: "auto-use", label: "Use the Auto model in this chat", run: () => {
      setModel("auto");
      if (activeChat) storeChat({ ...activeChat, model: "auto" });
    } },
    { id: "files", label: "Open a file", hint: "Ctrl+P", run: () => setQuickOpen(true) },
    { id: "terminal", label: "Terminal", run: () => setDock("terminal") },
    { id: "git", label: "Git", run: () => setDock("git") },
    { id: "preview", label: "Preview a page", run: () => setDock("preview") },
    { id: "notes", label: "Project instructions and MCP", run: () => setDock("notes") },
    { id: "rules", label: "Standing orders: protected paths and checks", run: () => setDock("rules") },
    { id: "inbox", label: "Decisions inbox", run: () => setInboxOpen(true) },
    { id: "briefing", label: "Briefing: where every chat stands", run: () => showBriefing() },
    { id: "watch", label: "Watch a log file for errors (this chat reacts)", run: () => activeChatRef.current && watchLog(activeChatRef.current.id) },
    { id: "theme", label: prefs.theme === "light" ? "Use dark theme" : "Use light theme", run: () => patchPrefs({ theme: prefs.theme === "light" ? "dark" : "light" }) },
    { id: "agent", label: "Agent mode", run: () => setMode("default") },
    { id: "plan", label: "Plan mode", run: () => setMode("plan") },
    { id: "auto", label: "Auto-edit mode", run: () => setMode("acceptEdits") },
  ];

  const q = filter.trim().toLowerCase();
  useEffect(() => {
    if (q.length < 2) {
      setBodyHits([]);
      return;
    }
    const t = setTimeout(() => {
      void window.desk.searchMessages(q).then(setBodyHits);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const groups = useMemo(() => {
    type Group = {
      key: string;
      name: string;
      path: string;
      slug: string;
      exists: boolean;
      projectId?: string;
      lastChatAt: number;
      lastUsedAt: number;
      github: boolean;
      chats: CursorChat[];
    };
    const map = new Map<string, Group>();
    const put = (key: string, extra: Partial<Group>) => {
      const cur = map.get(key) ?? {
        key,
        name: extra.name ?? "Project",
        path: extra.path ?? "",
        slug: extra.slug ?? "",
        exists: extra.exists ?? false,
        lastChatAt: extra.lastChatAt ?? 0,
        lastUsedAt: extra.lastUsedAt ?? 0,
        github: extra.github ?? false,
        chats: [],
      };
      Object.assign(cur, extra);
      map.set(key, cur);
      return cur;
    };
    for (const p of projects) {
      const key = (p.path || p.id || p.slug).toLowerCase();
      put(key, {
        key,
        projectId: p.id,
        name: p.name,
        path: p.path,
        slug: p.slug,
        exists: p.exists,
        github: /github\.com/i.test(p.remote ?? ""),
        lastChatAt: p.lastChatAt ?? 0,
        lastUsedAt: p.lastUsedAt ?? p.lastChatAt ?? 0,
      });
    }
    for (const c of chats) {
      const owner = projectForChat(projects, c);
      const ownerKey = owner ? (owner.path || owner.id || owner.slug).toLowerCase() : "";
      const slugKey = c.slug.toLowerCase() || c.id;
      const g =
        (ownerKey && map.get(ownerKey)) ||
        put(slugKey, {
          key: slugKey,
          name: c.projectPath || c.projectId ? c.projectName : "No project",
          path: c.projectPath || "",
          slug: c.slug,
          exists: Boolean(c.projectPath),
          lastUsedAt: c.updatedAt,
        });
      g.chats.push(c);
      g.lastChatAt = Math.max(g.lastChatAt, c.updatedAt);
      g.lastUsedAt = Math.max(g.lastUsedAt, c.lastUsedAt ?? c.updatedAt);
    }
    for (const g of map.values()) {
      const ord = prefs.chatOrder[g.key];
      if (ord?.length) {
        const rank = new Map(ord.map((id, i) => [id, i]));
        g.chats.sort(
          (a, b) =>
            Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
            (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) ||
            b.updatedAt - a.updatedAt,
        );
      } else {
        g.chats.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
      }
    }
    // Two checkouts with the same folder name stay separate, and the parent folder tells them apart.
    const nameCount = new Map<string, number>();
    for (const g of map.values()) nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);
    for (const g of map.values()) {
      if ((nameCount.get(g.name) ?? 0) < 2 || !g.path) continue;
      const parent = g.path.split(/[\\/]/).filter(Boolean).at(-2);
      if (parent) g.name = `${g.name} · ${parent}`;
    }
    let list = [...map.values()];
    if (q) {
      list = list
        .map((g) => {
          const projectHit =
            g.name.toLowerCase().includes(q) || g.path.toLowerCase().includes(q);
          return {
            ...g,
            chats: projectHit
              ? g.chats
              : g.chats.filter((c) => c.title.toLowerCase().includes(q) || bodyHits.includes(c.id)),
          };
        })
        .filter((g) => g.chats.length > 0 || g.name.toLowerCase().includes(q));
      list.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
      return list;
    }
    if (!list.length) return list;
    if (prefs.projectOrder.length) {
      const rank = new Map(prefs.projectOrder.map((k, i) => [k, i]));
      list.sort(
        (a, b) =>
          (rank.get(a.key) ?? 9999) - (rank.get(b.key) ?? 9999) ||
          b.lastUsedAt - a.lastUsedAt ||
          a.name.localeCompare(b.name),
      );
    } else {
      list.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
    }
    return list;
  }, [projects, chats, q, bodyHits, prefs.chatOrder, prefs.projectOrder]);

  const toggleGroup = (key: string) => {
    patchPrefs({ expanded: { ...prefs.expanded, [key]: !prefs.expanded[key] } });
  };

  const hiddenProjectSet = useMemo(() => new Set(prefs.hiddenProjects), [prefs.hiddenProjects]);
  const hiddenChatSet = useMemo(() => new Set(prefs.hiddenChats), [prefs.hiddenChats]);
  const visibleGroups = q ? groups : groups.filter((g) => !hiddenProjectSet.has(g.key));
  const hiddenGroupList = groups.filter((g) => hiddenProjectSet.has(g.key));
  const hiddenChatList = chats.filter((c) => hiddenChatSet.has(c.id));
  // Unopened for three months, or dragged in by hand. A running chat keeps its project out, and so does being open now,
  // unless it was archived by hand. Dragging one out counts as opening it, so the three months start again.
  const archivedKeys = new Set<string>();
  if (!q) {
    for (const g of visibleGroups) {
      if (g.chats.some((c) => runningByChat[c.id])) continue;
      const mark = prefs.projectArchive[g.key];
      const open = samePath(g.path, workspace) || g.chats.some((c) => c.id === activeChat?.id);
      if (mark === "in" || (!open && isStale(Math.max(g.lastUsedAt, mark ?? 0), Date.now()))) archivedKeys.add(g.key);
    }
  }
  const markArchive = (key: string, mark: "in" | number | null) => {
    const { [key]: _old, ...rest } = prefs.projectArchive;
    patchPrefs({ projectArchive: mark === null ? rest : { ...rest, [key]: mark } });
    const name = groups.find((g) => g.key === key)?.name ?? "Project";
    if (mark === "in") setStatus(`Moved ${name} to the archive`);
    else if (mark !== null) setStatus(`Brought ${name} out of the archive`);
  };
  const bringOut = (key: string) => {
    markArchive(key, Date.now());
    // A folder with no chats comes back under Other folders, so that row opens to show where it went.
    const back = groups.find((g) => g.key === key);
    if (back && !back.github && back.chats.length === 0) setOtherOpen(true);
  };
  const sideHeight = useMemo(() => (row: SideRow) => sideRowHeight(row, prefs.itemFont), [prefs.itemFont]);
  const sideRows = useMemo(() => {
    const rows: SideRow[] = [];
    const pushGroup = (g: (typeof visibleGroups)[number]) => {
      const current = samePath(g.path, workspace);
      const opened = Boolean(q) || Boolean(prefs.expanded[g.key]);
      const liveChats = g.chats.filter((c) => !hiddenChatSet.has(c.id));
      // A closed project is one row, so a long list of folders is easy to scan. An open one shows its recent chats,
      // and the rest fold under "older chats". A search shows every match.
      const older = q
        ? new Set<string>()
        : olderChats(liveChats, prefs.chatArchiveDays, Date.now(), (c) => Boolean(runningByChat[c.id]) || c.id === activeChat?.id);
      rows.push({ kind: "project", id: `p:${g.key}`, group: g });
      if (opened) {
        for (const c of liveChats) if (!older.has(c.id)) rows.push({ kind: "chat", id: `c:${g.key}:${c.id}`, group: g, chat: c });
        if (older.size) {
          const open = olderOpen.has(g.key);
          rows.push({ kind: "other", id: `older:${g.key}`, count: older.size, open });
          if (open) for (const c of liveChats) if (older.has(c.id)) rows.push({ kind: "chat", id: `c:${g.key}:${c.id}`, group: g, chat: c });
        }
      }
      if (liveChats.length === 0 && (opened || current)) rows.push({ kind: "note", id: `empty:${g.key}`, text: "No chats yet" });
    };
    // A search shows every match. Otherwise GitHub projects and any project that still has chats stay in the list.
    const inUse = (g: (typeof visibleGroups)[number]) =>
      samePath(g.path, workspace) || g.chats.some((c) => runningByChat[c.id] || c.id === activeChat?.id);
    const archived = q ? [] : visibleGroups.filter((g) => archivedKeys.has(g.key));
    const primary = q
      ? visibleGroups
      : visibleGroups.filter(
          (g) => !archivedKeys.has(g.key) && (g.github || g.chats.some((c) => !hiddenChatSet.has(c.id)) || inUse(g)),
        );
    const rest = q ? [] : visibleGroups.filter((g) => !primary.includes(g) && !archived.includes(g));
    for (const g of primary) pushGroup(g);
    if (rest.length) {
      rows.push({ kind: "other", id: "other-folders", count: rest.length, open: otherOpen });
      if (otherOpen) for (const g of rest) pushGroup(g);
    }
    // Always there outside a search, even empty: it is also where a project is dragged to archive it.
    if (!q) {
      rows.push({ kind: "other", id: "archive", count: archived.length, open: archiveOpen });
      if (archiveOpen) for (const g of archived) pushGroup(g);
    }
    return rows;
  }, [visibleGroups, q, prefs.expanded, prefs.projectArchive, prefs.chatArchiveDays, hiddenChatSet, runningByChat, workspace, activeChat?.id, otherOpen, archiveOpen, olderOpen]);

  // A newly opened chat shows in the list, once: collapsing its project afterwards stays collapsed.
  const shownChat = useRef<string | null>(null);
  useEffect(() => {
    const id = activeChat?.id;
    if (!id || shownChat.current === id || !prefsReady.current) return;
    const key = groups.find((g) => g.chats.some((c) => c.id === id))?.key;
    if (key === undefined) return;
    shownChat.current = id;
    if (!prefs.expanded[key]) patchPrefs({ expanded: { ...prefs.expanded, [key]: true } });
    if (prefs.projectArchive[key] === "in") markArchive(key, null);
  }, [activeChat?.id, groups]);

  const openMenu = (e: ReactMouseEvent, extra: Partial<CtxMenu> = {}) => {
    e.preventDefault();
    e.stopPropagation();
    const doc = (e.currentTarget as Element).ownerDocument;
    const view = doc.defaultView ?? window;
    setMenu({
      x: Math.min(e.clientX, view.innerWidth - 220),
      y: Math.min(e.clientY, view.innerHeight - 240),
      host: doc === document ? undefined : (e.currentTarget as Element).closest(".app") ?? undefined,
      ...extra,
    });
  };

  const moveProject = (from: string, to: string) => {
    const keys = visibleGroups.map((g) => g.key);
    const seeded = keys.every((k) => prefs.projectOrder.includes(k))
      ? prefs.projectOrder
      : [...prefs.projectOrder.filter((k) => keys.includes(k)), ...keys.filter((k) => !prefs.projectOrder.includes(k))];
    patchPrefs({ projectOrder: moveKey(seeded.length ? seeded : keys, from, to) });
  };

  const trashProject = async (g: SideGroup) => {
    if (g.chats.some((c) => runningByChat[c.id])) {
      setStatus(`A chat is running in ${g.name}. Stop it first.`);
      return;
    }
    const result = await window.desk.trashProject(g.path);
    if (!result) return;
    if (result.ok) markArchive(g.key, "in");
    setStatus(result.note);
    if (!result.ok) return;
    const under = (p: string) => {
      const file = p.toLowerCase();
      const dir = g.path.toLowerCase();
      return file === dir || file.startsWith(`${dir}\\`) || file.startsWith(`${dir}/`);
    };
    setTabs((all) => all.filter((t) => !under(t.path)));
    setActivePath((cur) => (cur && under(cur) ? null : cur));
    if (activeChat && g.chats.some((c) => c.id === activeChat.id)) setActiveChat(null);
    setWorkspace(await window.desk.getWorkspace());
    setProjects(await window.desk.listCursorProjects());
  };

  const moveChat = (projectKey: string, fromId: string, toId: string) => {
    const g = groups.find((x) => x.key === projectKey);
    const ids = (g?.chats ?? []).map((c) => c.id);
    const current = prefs.chatOrder[projectKey];
    const seeded =
      current?.length && ids.every((id) => current.includes(id))
        ? current
        : ids;
    patchPrefs({
      chatOrder: { ...prefs.chatOrder, [projectKey]: moveKey(seeded, fromId, toId) },
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const w = menu.host?.ownerDocument.defaultView ?? window;
    w.addEventListener("click", close);
    w.addEventListener("blur", close);
    return () => {
      w.removeEventListener("click", close);
      w.removeEventListener("blur", close);
    };
  }, [menu]);

  const look: Look = {
    theme: prefs.theme,
    style: { "--window-font": `${prefs.windowFont}px`, "--item-font": `${prefs.itemFont}px` } as CSSProperties,
  };
  const winShown = (view: "chats" | "files") => popped(view) && !winClosed[view];
  const otherView = sideView === "files" ? "chats" : "files";
  // The sidebar shows whichever of Chats/Files isn't in its own window; neither if both are.
  const inSide = !popped(sideView) ? sideView : !popped(otherView) ? otherView : null;
  const showSide = (view: "chats" | "files") => {
    if (popped(view)) setWinClosed((c) => ({ ...c, [view]: !c[view] }));
    else setSideView(view);
  };
  const sideOn = (view: "chats" | "files") => (popped(view) ? winShown(view) : inSide === view);

  return (
    <div className="app" data-theme={look.theme} style={look.style}>
      {(setupNote || status) && (
        <div className="toast" role="status">
          {setupNote || status}
        </div>
      )}
      <nav className="topbar" aria-label="Main">
        <div className="topbar-group" role="tablist" aria-label="Sidebar shows">
          <button
            type="button"
            role="tab"
            aria-selected={sideOn("chats")}
            className={sideOn("chats") ? "on" : ""}
            title="Show your projects and chats"
            onClick={() => showSide("chats")}
          >
            <Glyph name="chats" />
            <span>Chats</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sideOn("files")}
            className={sideOn("files") ? "on" : ""}
            title="Show the project's files (Ctrl+Shift+E)"
            onClick={() => showSide("files")}
          >
            <Glyph name="files" />
            <span>Files</span>
          </button>
        </div>
        <div className="topbar-group">
          <button
            type="button"
            className={inboxOpen ? "on" : ""}
            title={pendingApprovals.length ? `Everything waiting on you (${pendingApprovals.length})` : "Everything waiting on you, across all chats"}
            onClick={() => setInboxOpen((v) => !v)}
          >
            <Glyph name="inbox" />
            <span>Waiting on you</span>
            {pendingApprovals.length > 0 && <span className="topbar-badge">{pendingApprovals.length}</span>}
          </button>
          <button type="button" title="Where every recent chat stands" onClick={showBriefing}>
            <Glyph name="briefing" />
            <span>Chat status</span>
          </button>
          <button type="button" title="Help (F1)" onClick={() => setShowHelp(true)}>
            <Glyph name="help" />
            <span>Help</span>
          </button>
          <button type="button" title="Settings" onClick={() => { setSettingsSection(""); setShowSettings(true); }}>
            <Glyph name="settings" />
            <span>Settings</span>
          </button>
        </div>
      </nav>
      <div className={`workspace${inSide ? "" : " no-side"}`}>
        {(() => {
          // One render of each panel, used in the sidebar or in its own window.
          const panel = (view: "chats" | "files") => view === "files" ? (
            <Explorer
              root={workspace}
              roots={roots}
              active={activePath}
              changed={activeChanges}
              refreshKey={treeKey}
              onRefresh={() => void refreshTree(workspace)}
              onOpen={(p) => void openFilePath(p)}
              onMoved={(from, to) => {
                const under = (p: string) => {
                  const a = p.toLowerCase();
                  const b = from.toLowerCase();
                  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`);
                };
                setTabs((all) =>
                  to === null
                    ? all.filter((t) => !under(t.path))
                    : all.map((t) => {
                        if (!under(t.path)) return t;
                        const moved = to + t.path.slice(from.length);
                        return { ...t, path: moved, name: baseName(moved) };
                      }),
                );
                setActivePath((cur) =>
                  cur && under(cur) ? (to === null ? null : to + cur.slice(from.length)) : cur,
                );
              }}
              onMention={(p) => {
                const rel = workspace && p.toLowerCase().startsWith(workspace.toLowerCase())
                  ? p.slice(workspace.length).replace(/^[\\/]+/, "")
                  : p;
                composerRef.current?.addMention(p, rel);
              }}
            />
          ) : (
          <>
          <div className="pane-head">
            Projects
            <span className="pane-actions">
              <button className="ghost" onClick={() => void addFolder()} title="Add folder">
                Add
              </button>
              <button className="ghost" onClick={newAgent} title="Ctrl+N">
                New chat
              </button>
            </span>
          </div>
          <input
            className="filter"
            placeholder="Search projects and chats…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Windowed
            className="tree"
            items={sideRows}
            heightOf={sideHeight}
            keyOf={(row) => row.id}
            onContextMenu={(e) => openMenu(e)}
          >
            {(row) => {
              if (row.kind === "note") return <div className="tree-note">{row.text}</div>;
              if (row.kind === "other" && row.id.startsWith("older:")) {
                const key = row.id.slice("older:".length);
                return (
                  <button
                    type="button"
                    className="more-link other-folders"
                    aria-expanded={row.open}
                    title={`Chats not used for ${prefs.chatArchiveDays} days. Search finds them too. Change the days in Settings > Chats.`}
                    onClick={() =>
                      setOlderOpen((cur) => {
                        const next = new Set(cur);
                        if (!next.delete(key)) next.add(key);
                        return next;
                      })
                    }
                  >
                    {row.open ? "Hide" : "Show"} {row.count} older chat{row.count === 1 ? "" : "s"}
                  </button>
                );
              }
              if (row.kind === "other") {
                return (
                  <button
                    type="button"
                    className={`more-link other-folders ${dragOver === row.id ? "drag-over" : ""}`}
                    aria-expanded={row.open}
                    title={row.id === "archive" ? "Projects not opened for three months, or dragged here. Opening or dragging one out brings it back." : undefined}
                    onClick={() => (row.id === "archive" ? setArchiveOpen : setOtherOpen)((open) => !open)}
                    onDragOver={(e: DragEvent) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOver(row.id);
                    }}
                    onDrop={(e: DragEvent) => {
                      e.preventDefault();
                      const from = parseDrag(e);
                      if (from?.kind === "project" && from.key) {
                        if (row.id === "archive") markArchive(from.key, "in");
                        else if (archivedKeys.has(from.key)) bringOut(from.key);
                      }
                      setDragOver(null);
                      setDragging(null);
                    }}
                  >
                    {row.open ? "Hide" : "Show"} {row.id === "archive" ? `archive (${row.count})` : `${row.count} other folder${row.count === 1 ? "" : "s"}`}
                  </button>
                );
              }
              if (row.kind === "chat") {
                const g = row.group;
                const c = row.chat;
                return (
                  <button
                    type="button"
                    title={c.title}
                    draggable={!q && renamingId !== c.id}
                    className={`list-item nested ${activeChat?.id === c.id ? "active" : ""} ${runningByChat[c.id] ? `running phase-${progressByChat[c.id]?.phase ?? "starting"}` : ""} ${dragging === `c:${c.id}` ? "dragging" : ""} ${dragOver === `c:${c.id}` ? "drag-over" : ""}`}
                    onDragStart={(e: DragEvent) => {
                      e.stopPropagation();
                      setDragData(e, { kind: "chat", key: g.key, id: c.id });
                      setDragging(`c:${c.id}`);
                    }}
                    onDragOver={(e: DragEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = "move";
                      setDragOver(`c:${c.id}`);
                    }}
                    onDrop={(e: DragEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const from = parseDrag(e);
                      if (from?.kind === "chat" && from.key === g.key && from.id && from.id !== c.id) {
                        moveChat(g.key, from.id, c.id);
                      }
                      setDragOver(null);
                      setDragging(null);
                    }}
                    onDragEnd={() => {
                      setDragOver(null);
                      setDragging(null);
                    }}
                    onContextMenu={(e) => openMenu(e, { projectKey: g.key, chatId: c.id, chatTitle: c.title })}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (renamingId === c.id) return;
                      void openChat(c);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(c.id);
                    }}
                    onKeyDown={(e) => {
                      if (renamingId === c.id) return;
                      if (e.key === "F2") {
                        e.preventDefault();
                        setRenamingId(c.id);
                      }
                      if (e.key === "Delete") {
                        e.preventDefault();
                        void removeChat(c);
                      }
                    }}
                  >
                    <span className="row-icon"><Glyph name="chat" /></span>
                    {renamingId === c.id ? (
                      <input
                        className="rename-input"
                        autoFocus
                        defaultValue={c.title}
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") commitRename(c, e.currentTarget.value);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={(e) => commitRename(c, e.currentTarget.value)}
                      />
                    ) : (
                      <span className="list-title">{c.pinned ? "★ " : ""}{c.title}</span>
                    )}
                    <span
                      className="row-more"
                      role="button"
                      tabIndex={-1}
                      title="Rename, pin, branch, delete or hide"
                      onClick={(e) => openMenu(e, { projectKey: g.key, chatId: c.id, chatTitle: c.title })}
                    >
                      ⋯
                    </span>
                    <span className="list-sub">
                      {runningByChat[c.id] ? sideWord(progressByChat[c.id]) : relTime(c.lastUsedAt ?? c.updatedAt)}
                    </span>
                  </button>
                );
              }
              const g = row.group;
              const showAll = Boolean(q) || Boolean(prefs.expanded[g.key]);
              const current = samePath(g.path, workspace);
              const liveChats = g.chats.filter((c) => !hiddenChatSet.has(c.id));
              const projectRun = liveChats
                .filter((c) => runningByChat[c.id])
                .map((c) => progressByChat[c.id])
                .sort((a, b) => phaseRank(b) - phaseRank(a))[0];
              return (
                <button
                  type="button"
                  className={`project-row ${current ? "current" : ""} ${dragging === `p:${g.key}` ? "dragging" : ""} ${dragOver === `p:${g.key}` ? "drag-over" : ""}`}
                  title={g.path || g.slug}
                  aria-expanded={showAll}
                  draggable={!q}
                  onDragStart={(e: DragEvent) => {
                    setDragData(e, { kind: "project", key: g.key });
                    setDragging(`p:${g.key}`);
                  }}
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOver(`p:${g.key}`);
                  }}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault();
                    const from = parseDrag(e);
                    if (from?.kind === "project" && from.key && from.key !== g.key) {
                      moveProject(from.key, g.key);
                      // Dropped among the projects on the other side of the archive line: it crosses over too.
                      if (archivedKeys.has(from.key) && !archivedKeys.has(g.key)) bringOut(from.key);
                      if (!archivedKeys.has(from.key) && archivedKeys.has(g.key)) markArchive(from.key, "in");
                    }
                    setDragOver(null);
                    setDragging(null);
                  }}
                  onDragEnd={() => {
                    setDragOver(null);
                    setDragging(null);
                  }}
                  onContextMenu={(e) => openMenu(e, { projectKey: g.key })}
                  onClick={() => {
                    if (prefs.projectArchive[g.key] === "in") markArchive(g.key, null);
                    // Another project is gone to and left open, even if its list was already showing. Only the
                    // project you are in collapses, and collapsing never changes the chat on screen.
                    if (current && !q) return toggleGroup(g.key);
                    if (!showAll) toggleGroup(g.key);
                    void openProjectLatest(g.path, liveChats);
                  }}
                >
                  <span className={`row-icon ${showAll ? "open" : ""}`}>
                    <Glyph name="caret" />
                  </span>
                  <span className="list-title">{g.name}</span>
                  {g.projectId && !g.exists && <span className="list-sub" title="This project's folder is not on this computer. Right-click to locate it.">no folder</span>}
                  {projectRun && (
                    <span className={`phase phase-${projectRun.phase ?? "tool"}`}>{sideWord(projectRun)}</span>
                  )}
                  <span className="count">{liveChats.length}</span>
                  <span
                    className="row-x"
                    title="Hide"
                    onClick={(e) => {
                      e.stopPropagation();
                      hideProject(g.key);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            }}
          </Windowed>
          {visibleGroups.length === 0 && (
            <div className="bubble system" style={{ margin: 10 }}>
              {hiddenGroupList.length ? "All projects hidden. They come back from Settings." : "No projects yet. Use Add to open a folder, or Settings › Sync to bring them from another computer."}
            </div>
          )}
          </>
          );
          const win = (view: "chats" | "files", title: string) =>
            winShown(view) && (
              <PopOut
                name={view}
                title={`${title} — AgenticOps Desk`}
                width={380}
                height={820}
                look={look}
                onClose={() => setWinClosed((c) => ({ ...c, [view]: true }))}
              >
                <div className="sidebar">
                  <div className="side-panel">{panel(view)}</div>
                </div>
              </PopOut>
            );
          return (
            <>
              {inSide && (
                <aside className="sidebar">
                  <div className="side-panel">
                    {panel(inSide)}
                    <button className="settings-item" onClick={() => { setSettingsSection(""); setShowSettings(true); }}>
                      Settings
                    </button>
                  </div>
                </aside>
              )}
              {win("chats", "Chats")}
              {win("files", "Files")}
            </>
          );
        })()}

        <section
          className={`agent ${prefs.showCode ? "with-code" : ""}`}
          style={{ "--chat-width": `${chatWidth}px` } as CSSProperties}
        >
          {prefs.showCode && (
            <Suspense fallback={<div className="editor-wait">Opening the editor…</div>}>
            <CodePane
              files={tabs}
              activePath={activePath}
              snippets={snippets}
              snippetId={snippetId}
              workspace={workspace}
              diff={diff}
              onDiffKeep={(p) => void keepChanges([p])}
              onDiffUndo={(p) => void undoChanges([p])}
              onDiffClose={() => setDiff(null)}
              onSelectFile={(p) => {
                setDiff(null);
                setSnippetId(null);
                setActivePath(p);
              }}
              onSelectSnippet={(id) => {
                setDiff(null);
                setSnippetId(id);
              }}
              onCloseFile={closeTab}
              onChangeFile={(p, contents) =>
                setTabs((all) => all.map((t) => (t.path === p ? { ...t, contents, dirty: true } : t)))
              }
              onSaveFile={(p) => void saveTab(p)}
              onHide={() => patchPrefs({ showCode: false })}
              onOpenChat={openChatById}
              autocomplete={prefs.autocomplete}
            />
            </Suspense>
          )}
          {prefs.showCode && <div className="split" onMouseDown={startChatResize} title="Drag to resize" />}

          <div className="chat">
            <div className="pane-head chat-head">
              <span className="chat-title">{activeChat?.title ?? "New agent"}</span>
              {activeChat && team.managers.includes(activeChat.id) && (
                <span className="team-chip" title="This chat can start and direct worker chats. Right-click it in the sidebar to turn that off.">
                  Manager · {Object.entries(team.workers).filter(([w, m]) => m === activeChat.id && runningByChat[w]).length} running
                </span>
              )}
              {activeChat && team.workers[activeChat.id] && (
                <button className="team-chip" title="Open the manager chat that started this one" onClick={() => openChatById(team.workers[activeChat.id])}>
                  Worker of {chats.find((c) => c.id === team.workers[activeChat.id])?.title ?? "a manager"}
                </button>
              )}
              {running && <span className="run-dot" title={runProgress?.status ?? "Starting"} />}
              {running && (
                <span className={`phase phase-${runProgress?.phase ?? "starting"}`} title={runProgress?.status}>
                  {phaseWord(runProgress)}
                </span>
              )}
              {activeChat && <WatchChips chatId={activeChat.id} watches={watches} onChange={setWatches} />}
              {activeChat && (
                <WorktreeChip chatId={activeChat.id} folder={activeChat.projectPath ?? ""} running={running} onNote={setStatus} />
              )}
              {(["terminal", "git", "preview", "notes", "rules"] as DockTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`ghost ${dock === tab ? "on" : ""}`}
                  onClick={() => setDock((cur) => (cur === tab ? null : tab))}
                >
                  {tab === "notes" ? "Instructions" : tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
              <span className="grow" />
              <button
                className="ghost"
                onClick={() => patchPrefs({ showCode: !prefs.showCode })}
              >
                {prefs.showCode ? "Hide code" : "Code"}
              </button>
            </div>
            <div
              className="messages"
              ref={messagesRef}
              onScroll={() => {
                const el = messagesRef.current;
                if (!el) return;
                // Only the reader moving up lets go of the end. Content growing above the view is not that.
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stickToBottom.current = true;
                else if (el.scrollTop < messagesTop.current) stickToBottom.current = false;
                messagesTop.current = el.scrollTop;
              }}
            >
              {msgs.length === 0 && (
                <div className="bubble system">
                  Click a project to open its last-used chat, or pick any past chat to read it.
                  Send continues this chat. Other chats can keep running. Help (F1) explains the rest.
                </div>
              )}
              {activeChat && planByChat[activeChat.id] && (
                <div className="plan-card">
                  <strong>Plan</strong>
                  <ChatMarkdown text={planByChat[activeChat.id]} />
                </div>
              )}
              {activeChat && (todosByChat[activeChat.id]?.length ?? 0) > 0 && (
                <ul className="todo-list">
                  {todosByChat[activeChat.id].map((item) => (
                    <li key={item.content} className={`todo-${item.status}`}>
                      {item.status === "completed" ? "✓" : item.status === "in_progress" ? "…" : "○"} {item.content}
                    </li>
                  ))}
                </ul>
              )}
              <Conversation
                key={activeChat?.id}
                msgs={msgs}
                live={running}
                liveStatus={running ? runProgress?.status : undefined}
                onRewind={(i) => void rewindTo(i, false)}
                onRetry={(i) => void rewindTo(i, true)}
                onBranch={(i) => {
                  if (activeChat) void branchFrom(activeChat, msgs.slice(0, i + 1));
                }}
                onReplay={(i) => {
                  if (activeChat) setReplayFrom({ chat: activeChat, index: i });
                }}
              />
            </div>
            <ChangesBar
              files={activeChanges}
              workspace={activeChat?.projectPath || workspace}
              reviewing={diff?.path ?? null}
              onReview={(p) => void openReview(p)}
              onKeep={(paths) => void keepChanges(paths)}
              onUndo={(paths) => void undoChanges(paths)}
            />
            <Composer
              ref={composerRef}
              value={prompt}
              onChange={setPrompt}
              running={running}
              mode={mode}
              onMode={(m) => {
                setMode(m);
                if (activeChat) storeChat({ ...activeChat, mode: m });
              }}
              model={model}
              onModel={(m) => chooseModel(m)}
              models={models}
              pluginCommands={pluginCmds}
              routedTo={activeChat ? routeByChat[activeChat.id] : undefined}
              usage={activeChat ? usageByChat[activeChat.id] : undefined}
              onSend={(extra) => void send(extra)}
              onCatchUp={() => void catchUp()}
              onCommand={runCommand}
              onStop={() => void window.desk.stopClaude(activeChat?.id)}
              activeChatId={activeChat?.id}
              chatTitle={(id) => chats.find((c) => c.id === id)?.title}
              onOpenChat={openChatById}
            />
            {dock && workspace && (
              <Dock tab={dock} workspace={workspace} previewUrl={previewUrl} onPreviewUrl={setPreviewUrl} onStatus={setStatus} />
            )}
          </div>
        </section>
      </div>

      {quickOpen && (
        <div className="modal" onClick={() => setQuickOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              ref={quickRef}
              value={quickQuery}
              placeholder="Open file in this folder…"
              onChange={(e) => setQuickQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setQuickIndex((i) => Math.min(i + 1, Math.max(0, quickHits.length - 1)));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setQuickIndex((i) => Math.max(0, i - 1));
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const hit = quickHits[quickIndex];
                  if (hit) {
                    void openFilePath(hit.path);
                    setQuickOpen(false);
                  }
                }
              }}
            />
            <div className="palette-list">
              {quickHits.map((h, i) => (
                <button
                  key={h.path}
                  className={`list-item ${i === quickIndex ? "active" : ""}`}
                  onMouseEnter={() => setQuickIndex(i)}
                  onClick={() => {
                    void openFilePath(h.path);
                    setQuickOpen(false);
                  }}
                >
                  <span className="list-title">{h.name}</span>
                  <span className="list-sub">{h.rel}</span>
                </button>
              ))}
              {quickHits.length === 0 && <div className="bubble system">No matches in this folder.</div>}
            </div>
          </div>
        </div>
      )}

      {menu && portalTo(menu.host, (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.chatId ? (
            <>
              <button
                onClick={() => {
                  const chat = chats.find((c) => c.id === menu.chatId);
                  if (chat) renameChat(chat);
                  setMenu(null);
                }}
              >
                Rename
              </button>
              <button
                onClick={() => {
                  const chat = chats.find((c) => c.id === menu.chatId);
                  if (chat) togglePin(chat);
                  setMenu(null);
                }}
              >
                {chats.find((c) => c.id === menu.chatId)?.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                onClick={() => {
                  const chat = chats.find((c) => c.id === menu.chatId);
                  setMenu(null);
                  if (!chat) return;
                  void (async () => {
                    const loaded = threadsRef.current[chat.id] ?? (await window.desk.readCursorChat(chat.slug, chat.id))?.messages ?? [];
                    await branchFrom(chat, loaded);
                  })();
                }}
              >
                Branch
              </button>
              {!team.workers[menu.chatId] && (
                <button
                  title="A manager can start worker chats in this project, message them and wait for their results"
                  onClick={() => {
                    const chat = chats.find((c) => c.id === menu.chatId);
                    setMenu(null);
                    if (chat) void toggleManager(chat);
                  }}
                >
                  {team.managers.includes(menu.chatId) ? "Stop being a manager" : "Make manager"}
                </button>
              )}
              <button
                onClick={() => {
                  const chat = chats.find((c) => c.id === menu.chatId);
                  setMenu(null);
                  if (chat) setMovingChat(chat);
                }}
              >
                Move to project…
              </button>
              <button
                onClick={() => {
                  const chat = chats.find((c) => c.id === menu.chatId);
                  setMenu(null);
                  if (chat) void removeChat(chat);
                }}
              >
                Delete
              </button>
              <button
                onClick={() => {
                  const id = menu.chatId!;
                  setMenu(null);
                  watchLog(id);
                }}
              >
                Watch a log file…
              </button>
              <button onClick={() => hideChat(menu.chatId!)}>Hide chat</button>
            </>
          ) : menu.projectKey ? (
            <>
              {(() => {
                const g = groups.find((x) => x.key === menu.projectKey);
                if (!g?.projectId) return null;
                const id = g.projectId;
                return (
                  <button
                    onClick={() => {
                      setMenu(null);
                      void window.desk.locateProject(id).then(async (done) => {
                        if (!done) return;
                        const list = await reloadCursor();
                        setChats(list);
                        setActiveChat((cur) => (cur ? list.find((c) => c.id === cur.id) ?? cur : cur));
                      });
                    }}
                  >
                    {g.exists ? "Change folder…" : "Locate folder…"}
                  </button>
                );
              })()}
              <button onClick={() => hideProject(menu.projectKey!)}>Hide project</button>
              <button
                onClick={() => {
                  const key = menu.projectKey!;
                  setMenu(null);
                  if (archivedKeys.has(key)) bringOut(key);
                  else markArchive(key, "in");
                }}
              >
                {archivedKeys.has(menu.projectKey) ? "Bring out of archive" : "Move to archive"}
              </button>
              {(() => {
                const g = groups.find((x) => x.key === menu.projectKey);
                if (!g?.path || !g.exists) return null;
                return (
                  <button
                    className="danger-text"
                    onClick={() => {
                      setMenu(null);
                      void trashProject(g);
                    }}
                  >
                    Delete folder from this computer…
                  </button>
                );
              })()}
            </>
          ) : null}
          {hiddenGroupList.length + hiddenChatList.length > 0 ? (
            <>
              {(menu.chatId || menu.projectKey) && <div className="ctx-sep" />}
              <button
                onClick={() => {
                  setMenu(null);
                  openSettingsAt("projects");
                }}
              >
                Hidden ({hiddenGroupList.length + hiddenChatList.length})…
              </button>
            </>
          ) : !menu.chatId && !menu.projectKey ? (
            <div className="ctx-empty">Nothing hidden</div>
          ) : null}
        </div>
      ))}

      {(() => {
        // The floating card is for the chat you are in. Everything else waits in the inbox, so another
        // chat's question never jumps in front of your work.
        const here = pendingApprovals.filter((a) => a.chatId === activeChat?.id);
        const card = here[0];
        if (!card) return null;
        return (
          <PermissionDialog
            card={card}
            waiting={here.length}
            chatTitle={chats.find((c) => c.id === card.chatId)?.title}
            onAnswer={(decision) => answerCard(card, decision)}
          />
        );
      })()}

      {inboxOpen && (
        <PopOut
          name="inbox"
          title="Waiting on you — AgenticOps Desk"
          width={480}
          height={760}
          look={look}
          windowed={popped("inbox")}
          modal={false}
          onClose={() => setInboxOpen(false)}
        >
          <Inbox
            cards={pendingApprovals}
            chatTitle={(id) => chats.find((c) => c.id === id)?.title ?? "Chat"}
            onAnswer={(card, decision) => answerCard(card, decision)}
            onOpen={(id) => {
              openChatById(id);
              // A separate window stays open; the in-app drawer gets out of the way.
              if (!popped("inbox")) setInboxOpen(false);
            }}
            onClose={() => setInboxOpen(false)}
          />
        </PopOut>
      )}

      {briefing && (
        <PopOut
          name="status"
          title="Chat status — AgenticOps Desk"
          width={760}
          height={760}
          look={look}
          windowed={popped("status")}
          onClose={() => setBriefing(null)}
        >
          <Briefing
            items={briefing}
            onOpen={(id) => {
              openChatById(id);
              if (!popped("status")) setBriefing(null);
            }}
            onClose={() => setBriefing(null)}
          />
        </PopOut>
      )}

      {keyAsk && (
        <div className="modal" onClick={() => !keyAsk.busy && setKeyAsk(null)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <strong>{keyAsk.label} API key</strong>
              <button className="ghost" disabled={keyAsk.busy} onClick={() => setKeyAsk(null)}>
                Cancel
              </button>
            </div>
            <p className="settings-hint">{keyAsk.hint || "The key stays on this computer. Models from this provider then show in the menu."}</p>
            <input
              type="password"
              placeholder="API key"
              value={keyAsk.key}
              autoFocus
              disabled={keyAsk.busy}
              onChange={(e) => setKeyAsk({ ...keyAsk, key: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKeyAsk();
              }}
            />
            {keyAsk.error && <p className="settings-hint">{keyAsk.error}</p>}
            <div className="row">
              <button className="btn primary" disabled={keyAsk.busy || !keyAsk.key.trim()} onClick={() => void saveKeyAsk()}>
                {keyAsk.busy ? "Saving…" : "Save and use"}
              </button>
            </div>
          </div>
        </div>
      )}
      {replayFrom && (
        <div className="modal" onClick={() => setReplayFrom(null)}>
          <div className="palette replay" onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <strong>Replay this request on…</strong>
              <button className="ghost" onClick={() => setReplayFrom(null)}>
                Cancel
              </button>
            </div>
            <p className="settings-hint">It runs in a new branch, so you can compare the two answers side by side.</p>
            <div className="palette-list">
              <button className="list-item" onClick={() => void replayOn("")}>
                <span className="list-title">Claude Code · default model</span>
              </button>
              {models.filter((m) => !m.needsSetup).map((m) => (
                <button key={m.value} className="list-item" onClick={() => void replayOn(m.value)}>
                  <span className="list-title">{m.displayName}</span>
                  <span className="list-sub">{m.group ?? "Claude Code"}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {movingChat && (
        <div className="modal" onClick={() => setMovingChat(null)}>
          <div className="palette replay" onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <strong>Move “{movingChat.title}” to…</strong>
              <button className="ghost" onClick={() => setMovingChat(null)}>
                Cancel
              </button>
            </div>
            <p className="settings-hint">The chat runs in that project's folder from its next message, with its history handed over.</p>
            <div className="palette-list">
              <button className="list-item" onClick={() => void moveChatTo(movingChat, null)}>
                <span className="list-title">Choose a folder…</span>
              </button>
              {projects
                .filter((p) => p.id && p.id !== movingChat.projectId)
                .map((p) => (
                  <button key={p.id} className="list-item" onClick={() => void moveChatTo(movingChat, p.id!)}>
                    <span className="list-title">{p.name}</span>
                    <span className="list-sub">{p.exists ? p.path : p.path ? `${p.path} (folder missing)` : "not on this computer"}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
      {askStorage && (
        <div className="modal">
          <div className="palette replay" role="dialog" aria-label="Where should your chats live?">
            <div className="settings-head">
              <strong>Where should your chats live?</strong>
              <button className="ghost" onClick={() => setAskStorage(null)}>
                Ask me later
              </button>
            </div>
            <p className="settings-hint">
              Found {askStorage.cursorChats} Cursor chats. Passwords and tokens are hidden in anything pushed to GitHub. Your choice can be changed in Settings.
            </p>
            <ChatStorage
              onChosen={(mode) => {
                setPrefs((p) => ({ ...p, chatStorage: mode }));
                setAskStorage(null);
                void reloadCursor().then(setChats);
              }}
            />
          </div>
        </div>
      )}
      {showHelp && <Help look={look} windowed={popped("help")} onClose={() => setShowHelp(false)} />}
      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {showSettings && (
        <PopOut
          name="settings"
          title="Settings — AgenticOps Desk"
          width={720}
          height={820}
          look={look}
          windowed={popped("settings")}
          onClose={() => { setShowSettings(false); setSettingsSection(""); }}
        >
          <div className="settings">
            <div className="settings-head">
              <strong>Settings</strong>
              <button className="ghost" onClick={() => { setShowSettings(false); setSettingsSection(""); }}>
                Close
              </button>
            </div>

            {settingsSection && (
              <div className="settings-sub">
                <button className="settings-back" onClick={() => setSettingsSection("")}>
                  ‹ Back
                </button>

                {settingsSection === "appearance" && (
                  <>
                    <div className="settings-label">Appearance</div>
                    <label className="settings-row">
                      <span>Theme</span>
                      <select
                        value={prefs.theme}
                        onChange={(e) => patchPrefs({ theme: e.target.value === "light" ? "light" : "dark" })}
                      >
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                      </select>
                      <em />
                    </label>
                    <label className="settings-row">
                      <span>Window font size</span>
                      <input
                        type="range"
                        min={12}
                        max={28}
                        value={prefs.windowFont}
                        onChange={(e) => patchPrefs({ windowFont: Number(e.target.value) })}
                      />
                      <em>{prefs.windowFont}px</em>
                    </label>
                    <label className="settings-row">
                      <span>Agent list font size</span>
                      <input
                        type="range"
                        min={10}
                        max={22}
                        value={prefs.itemFont}
                        onChange={(e) => patchPrefs({ itemFont: Number(e.target.value) })}
                      />
                      <em>{prefs.itemFont}px</em>
                    </label>
                    <div className="settings-label">Open in their own window</div>
                    <p className="settings-hint">Ticked panels open as separate windows you can move beside the chat. Unticked ones stay inside the main window.</p>
                    {PANELS.map((p) => (
                      <label key={p.key} className="settings-check">
                        <input
                          type="checkbox"
                          checked={popped(p.key)}
                          onChange={(e) =>
                            patchPrefs({
                              popOut: e.target.checked ? [...prefs.popOut, p.key] : prefs.popOut.filter((k) => k !== p.key),
                            })
                          }
                        />
                        {p.label}
                      </label>
                    ))}
                  </>
                )}

                {settingsSection === "privacy" && (
                  <>
                    <PrivacySettings mode={prefs.privacy} onMode={(privacy) => patchPrefs({ privacy })} />
                    <SavedLogins privacyOn={prefs.privacy !== "standard"} />
                  </>
                )}

                {settingsSection === "sync" && (
                  <SyncSettings
                    onChanged={() => {
                      void window.desk.listCursorProjects().then(setProjects);
                      void window.desk.getWorkspace().then((ws) => {
                        setWorkspace(ws);
                        if (ws) void refreshTree(ws);
                      });
                    }}
                  />
                )}

                {settingsSection === "projects" && (
                  <>
                    {(hiddenGroupList.length > 0 || hiddenChatList.length > 0) && (
                      <div className="settings-hidden">
                        <div className="settings-label">Hidden items</div>
                        <button
                          className="btn"
                          onClick={() => patchPrefs({ hiddenProjects: [], hiddenChats: [] })}
                        >
                          Unhide all
                        </button>
                        {hiddenGroupList.map((g) => (
                          <button key={g.key} className="more-link" onClick={() => unhideProject(g.key)}>
                            Unhide {g.name}
                          </button>
                        ))}
                        {hiddenChatList.map((c) => (
                          <button key={c.id} className="more-link" onClick={() => unhideChat(c.id)}>
                            Unhide chat: {c.title}
                          </button>
                        ))}
                      </div>
                    )}
                    {!hiddenGroupList.length && !hiddenChatList.length && (
                      <p className="settings-hint">Nothing is hidden.</p>
                    )}
                    <ProjectCleanup
                      onDone={() =>
                        void reloadCursor().then((list) => {
                          setChats(list);
                          setActiveChat((cur) => (cur ? list.find((c) => c.id === cur.id) ?? cur : cur));
                        })
                      }
                    />
                    <p className="settings-hint">Drag a project or chat to reorder it. Drag a project onto the archive row, or back out of it.</p>
                    <div className="settings-label">Older chats</div>
                    <label className="settings-row">
                      <span>
                        In each project, chats not used for this long fold under a "Show older chats" row. The top chat, pinned chats,
                        the open chat and running chats always stay. Search still finds every chat.
                      </span>
                      <select value={String(prefs.chatArchiveDays)} onChange={(e) => patchPrefs({ chatArchiveDays: Number(e.target.value) })}>
                        <option value="0">Never</option>
                        {[1, 3, 7, 14, 30, 60, 90].map((n) => (
                          <option key={n} value={String(n)}>
                            After {n} day{n === 1 ? "" : "s"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="settings-label">Where chats live</div>
                    <ChatStorage current={prefs.chatStorage} onChosen={(mode) => setPrefs((p) => ({ ...p, chatStorage: mode }))} />
                    {prefs.chatStorage === "github" && <CursorFolders />}
                    <div className="settings-label">Import from other tools</div>
                    <p className="settings-hint">
                      Claude Code sessions typed in a terminal, and VS Code chats. An imported Claude Code session continues where it left off.
                      Importing again adds new ones and leaves chats you continued here alone.
                    </p>
                    <div className="signin-row">
                      <button
                        className="btn"
                        onClick={() => {
                          setStatus("Importing chats…");
                          void window.desk.importOtherTools().then(async (r) => {
                            const list = await reloadCursor();
                            setChats(list);
                            setStatus(`Imported ${r.claudeCode} Claude Code session${r.claudeCode === 1 ? "" : "s"} and ${r.vscode} VS Code chat${r.vscode === 1 ? "" : "s"}`);
                          });
                        }}
                      >
                        Import chats
                      </button>
                    </div>
                  </>
                )}

                {settingsSection === "engine" && (
                  <>
                    <div className="settings-label">Claude Code</div>
                    <div className="signin-row">
                      <span>
                        {cli?.bundled ? "Ready" : cli?.found ? "Installed CLI" : "Not found"}
                        {" · "}
                        {authOk === null ? "checking sign-in…" : authOk ? "signed in" : "not signed in"}
                      </span>
                      <span className="grow" />
                      <button
                        className="btn"
                        onClick={() => {
                          void window.desk.signIn().then((opened) =>
                            setStatus(
                              opened
                                ? "Finish signing in in the window that opened, then come back here."
                                : "No terminal app found. Run \"claude auth login\" in a terminal, then press Check.",
                            ),
                          );
                        }}
                      >
                        {authOk ? "Sign in again" : "Sign in"}
                      </button>
                      <button
                        className="btn"
                        onClick={() =>
                          void window.desk.authStatus().then((a) => {
                            setAuthOk(a.ok);
                            setStatus(a.ok ? "Claude Code signed in" : "Not signed in yet");
                          })
                        }
                      >
                        Check
                      </button>
                    </div>
                  </>
                )}

                {settingsSection === "models" && (
                  <>
                    <ProvidersSettings onChanged={() => void window.desk.listModels().then(setModels)} />
                    <div className="settings-label">Second opinion</div>
                    <label className="settings-row">
                      <span>
                        After a run changes files, this model checks the change against your request. Its concerns go back to the agent
                        to fix, up to two rounds.
                      </span>
                      <select value={prefs.reviewer} onChange={(e) => patchPrefs({ reviewer: e.target.value })}>
                        <option value="">Off</option>
                        {models
                          .filter((m) => m.value.startsWith("direct:") && !m.needsSetup)
                          .map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.group?.replace(/^Direct · /, "")} · {m.displayName}
                            </option>
                          ))}
                      </select>
                    </label>
                    {!models.some((m) => m.value.startsWith("direct:") && !m.needsSetup) && (
                      <p className="settings-hint">Add a provider key above (OpenAI, Gemini, Claude API…) to pick a reviewer.</p>
                    )}
                    <div className="settings-label">Editor autocomplete</div>
                    <label className="settings-row">
                      <span>Suggest the next lines as grey text while you type (Tab accepts). Each pause in typing is one call to this model.</span>
                      <select value={prefs.autocomplete} onChange={(e) => patchPrefs({ autocomplete: e.target.value })}>
                        <option value="">Off</option>
                        {models
                          .filter((m) => m.value.startsWith("direct:") && !m.needsSetup)
                          .map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.group?.replace(/^Direct · /, "")} · {m.displayName}
                            </option>
                          ))}
                      </select>
                    </label>
                    {!models.some((m) => m.value.startsWith("direct:") && !m.needsSetup) && (
                      <p className="settings-hint">Needs a Direct provider: a Claude API key (Haiku is fast and cheap) or a local Ollama model.</p>
                    )}
                    <div className="settings-label">Summaries</div>
                    <label className="settings-row">
                      <span>
                        After each run, this model updates a short summary of the chat and of what the run proved. When a long or idle chat
                        starts a fresh session, it gets that summary instead of clipped turns. A local Ollama model costs nothing.
                      </span>
                      <select value={prefs.summarizer} onChange={(e) => patchPrefs({ summarizer: e.target.value })}>
                        <option value="">Off</option>
                        {models
                          .filter((m) => m.value.startsWith("direct:") && !m.needsSetup)
                          .map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.group?.replace(/^Direct · /, "")} · {m.displayName}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="settings-row">
                      <span>
                        Set up a free local model: installs Ollama if it is missing, downloads qwen2.5-coder 7B (about 5 GB), and picks it
                        here. It runs in the background.
                        {localModel.text && (
                          <span className="settings-hint" role="status">
                            {" "}
                            {localModel.text}
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={localModel.running}
                        onClick={() => void window.desk.setupLocalModel()}
                      >
                        {localModel.running ? "Setting up…" : localModel.ok ? "Set up again" : "Set up local model"}
                      </button>
                    </div>
                    <div className="settings-label">Spending cap</div>
                    <label className="settings-row">
                      <span>Stop a run once it has spent this much. Covers the default engine and Claude API keys; other providers don't report a price and stop after 80 steps. With a Claude sign-in the cost is an estimate.</span>
                      <select value={String(prefs.runBudgetUsd)} onChange={(e) => patchPrefs({ runBudgetUsd: Number(e.target.value) })}>
                        <option value="0">Off</option>
                        {[1, 2, 5, 10, 25, 50].map((n) => (
                          <option key={n} value={String(n)}>
                            ${n} per run
                          </option>
                        ))}
                      </select>
                    </label>
                    <AutoSettings models={models} chosen={prefs.autoModels} onChange={(autoModels) => patchPrefs({ autoModels })} />
                  </>
                )}

                {settingsSection === "usage" && <UsageSettings />}

                {settingsSection === "plugins" && (
                  <PluginsSettings onChanged={() => void window.desk.pluginCommands().then(setPluginCmds)} />
                )}

                {settingsSection === "updates" && (
                  <>
                    <div className="settings-label">Updates</div>
                    <div className="signin-row">
                      <button
                        className="btn"
                        onClick={() =>
                          void window.desk.checkForUpdate().then((info) => {
                            setUpdateReady(info.patch.ready);
                            setUpdateInstallable(info.canInstall);
                            setUpdateNote(
                              info.patch.note
                                ? `This copy is ${info.current}. ${info.patch.note}`
                                : info.latest
                                  ? `This copy is ${info.current}. Latest release is ${info.latest}. ${info.url ?? ""} ${info.note}`
                                  : `${info.note} This copy is ${info.current}.`,
                            );
                          })
                        }
                      >
                        Check for updates
                      </button>
                      {updateReady && (
                        <button className="btn" onClick={() => void window.desk.restartForUpdate()}>
                          Restart to update
                        </button>
                      )}
                      {updateInstallable && (
                        <button
                          className="btn"
                          onClick={() => {
                            setUpdateNote("Downloading the installer…");
                            void window.desk.installUpdate().then((problem) => {
                              if (problem) setUpdateNote(problem);
                            });
                          }}
                        >
                          Download and install
                        </button>
                      )}
                    </div>
                    {updateNote && <p className="settings-hint">{updateNote}</p>}
                  </>
                )}
              </div>
            )}

            {!settingsSection && (
              <div className="settings-index">
                <button className="settings-entry" onClick={() => setSettingsSection("appearance")}>
                  <strong>Appearance</strong>
                  <span>Theme and font sizes</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("privacy")}>
                  <strong>Privacy & logins</strong>
                  <span>Privacy Mode and saved passwords</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("sync")}>
                  <strong>Sync</strong>
                  <span>Share chats, memory and settings across computers</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("projects")}>
                  <strong>Chats & projects</strong>
                  <span>Hidden items, cleanup, and where chats live</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("engine")}>
                  <strong>Engine & sign-in</strong>
                  <span>Claude Code status and sign-in</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("models")}>
                  <strong>AI models</strong>
                  <span>Providers, second opinion, autocomplete, Auto</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("usage")}>
                  <strong>Usage</strong>
                  <span>Plan limits, and tokens per engine, provider and model</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("plugins")}>
                  <strong>Plugins</strong>
                  <span>Browse, install and manage plugins</span>
                </button>
                <button className="settings-entry" onClick={() => setSettingsSection("updates")}>
                  <strong>Updates</strong>
                  <span>Check for a newer release</span>
                </button>
                <p className="settings-hint">
                  Saved on disk and kept after restart. Right-click a project or chat to hide it.
                </p>
              </div>
            )}
          </div>
        </PopOut>
      )}

    </div>
  );
}
