import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { CodePane } from "./CodePane";
import { extractCodeBlocks } from "./codeBlocks";
import { defaultPrefs, moveKey, type UiPrefs } from "./prefs";
import type { ApprovalRequest, ClaudeEvent, CursorChat, CursorProject, RunPhase } from "./vite-env";

type CtxMenu = { x: number; y: number; projectKey?: string; chatId?: string; chatTitle?: string };
type DragPayload = { kind: "project" | "chat"; key?: string; id?: string };

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
type Msg = { role: "user" | "assistant" | "system" | "error"; text: string };
type Tab = { path: string; name: string; contents: string; dirty: boolean };
type RunProgress = { status: string; steps: string[]; phase?: RunPhase };

function phaseWord(progress?: RunProgress) {
  if (!progress) return "Starting";
  if (progress.phase === "approval") return "Needs permission";
  if (progress.phase === "thinking") return "Thinking";
  if (progress.phase === "writing") return "Writing";
  if (progress.phase === "pushing") return progress.status.startsWith("Pushing to main") ? "Pushing to main" : "Pushing";
  if (progress.phase === "starting") return "Starting";
  const text = progress.status.replace(/…$/, "").trim();
  return text || "Working";
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

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`chevron ${open ? "open" : ""}`} aria-hidden>
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M6 3.25 11.25 8 6 12.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function FileNode({
  entry,
  depth,
  active,
  refreshKey,
  onOpen,
}: {
  entry: Entry;
  depth: number;
  active: string | null;
  refreshKey: number;
  onOpen: (e: Entry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Entry[] | null>(null);

  useEffect(() => {
    if (!entry.isDir || !open) return;
    void window.desk.listDir(entry.path).then(setKids);
  }, [entry.isDir, entry.path, open, refreshKey]);

  return (
    <>
      <div
        className={`tree-item ${active === entry.path ? "active" : ""}`}
        style={{ ["--depth" as string]: depth }}
        onClick={() => {
          if (entry.isDir) setOpen((v) => !v);
          else onOpen(entry);
        }}
      >
        {entry.isDir ? <Chevron open={open} /> : <span className="file-dot">·</span>}
        <span>{entry.name}</span>
      </div>
      {open &&
        kids?.map((k) => (
          <FileNode
            key={k.path}
            entry={k}
            depth={depth + 1}
            active={active}
            refreshKey={refreshKey}
            onOpen={onOpen}
          />
        ))}
    </>
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
    <div className="modal">
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
  const [prompt, setPrompt] = useState("");
  const [activeChat, setActiveChat] = useState<CursorChat | null>(null);
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [runningByChat, setRunningByChat] = useState<Record<string, boolean>>({});
  const [progressByChat, setProgressByChat] = useState<Record<string, RunProgress>>({});
  const [snippetId, setSnippetId] = useState<string | null>(null);
  const [cli, setCli] = useState<{ found: boolean; path: string } | null>(null);
  const [authOk, setAuthOk] = useState<boolean | null>(null);
  const [status, setStatus] = useState("Ready");
  const [treeKey, setTreeKey] = useState(0);
  const [projects, setProjects] = useState<CursorProject[]>([]);
  const [chats, setChats] = useState<CursorChat[]>([]);
  const [filter, setFilter] = useState("");
  const [prefs, setPrefs] = useState<UiPrefs>(() => defaultPrefs());
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickHits, setQuickHits] = useState<Array<{ name: string; path: string; rel: string }>>([]);
  const [quickIndex, setQuickIndex] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState<Array<ApprovalRequest & { chatId: string }>>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  const workspaceRef = useRef(workspace);
  const activeRef = useRef(activePath);
  const autoOpenRef = useRef<string | null>(null);
  const activeChatRef = useRef<CursorChat | null>(null);
  const threadsRef = useRef(threads);
  const prefsReady = useRef(false);
  const persistIds = useRef(new Set<string>());
  // The thread array last sent to disk per chat, so the debounced save skips chats that did not change.
  const savedThreads = useRef(new Map<string, Msg[]>());
  tabsRef.current = tabs;
  workspaceRef.current = workspace;
  activeRef.current = activePath;
  activeChatRef.current = activeChat;
  threadsRef.current = threads;
  const msgs = activeChat ? threads[activeChat.id] ?? [] : [];
  const running = Boolean(activeChat && runningByChat[activeChat.id]);
  const runProgress = activeChat ? progressByChat[activeChat.id] : undefined;
  const snippets = useMemo(
    () =>
      msgs.flatMap((m, i) =>
        m.role === "assistant" ? extractCodeBlocks(m.text, `reply${i + 1}`) : [],
      ),
    [msgs],
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
    const text = await window.desk.readFile(current.path);
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


  const openChat = async (chat: CursorChat) => {
    if (chat.projectPath && !samePath(chat.projectPath, workspaceRef.current)) {
      await focusProject(chat.projectPath);
    }
    setActiveChat(chat);
    if (threadsRef.current[chat.id]) {
      setStatus(chat.title);
      return;
    }
    setStatus("Loading chat…");
    const detail = await window.desk.readCursorChat(chat.slug, chat.id);
    if (!detail) {
      setThreads((t) => ({ ...t, [chat.id]: t[chat.id] ?? [] }));
      setStatus(chat.title);
      return;
    }
    setThreads((t) => (t[chat.id] ? t : { ...t, [chat.id]: detail.messages }));
    setStatus(detail.title);
  };

  const openProjectLatest = async (path: string, projectChats: CursorChat[]) => {
    if (path) await focusProject(path);
    const latest = [...projectChats].sort(
      (a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt),
    )[0];
    if (latest) await openChat(latest);
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
        setStatus(list.length ? `${list.length} chats` : "No chats found");
      } catch {
        setStatus("Could not load chats");
      }
      try {
        setCli(await window.desk.probeClaude());
        const auth = await window.desk.authStatus();
        setAuthOk(auth.ok);
        setStatus(auth.ok ? "Claude Code signed in" : "Run claude auth login");
      } catch {
        setAuthOk(false);
      }
    })();
  }, []);

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
        if (activeChatRef.current?.id === chatId) setStatus(ev.text);
      }
      if (ev.kind === "approval" && ev.approval) {
        const card = { ...ev.approval, chatId };
        setPendingApprovals((list) => [...list.filter((a) => a.requestId !== card.requestId), card]);
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: card.summary, steps: p[chatId]?.steps ?? [], phase: "approval" },
        }));
        if (activeChatRef.current?.id === chatId) setStatus(card.summary);
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
        patchThread(chatId, (m) => [...m, { role: "system", text: `▸ ${ev.text}` }]);
      }
      if (ev.kind === "line" && ev.text) {
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: "Writing…", steps: p[chatId]?.steps ?? [], phase: "writing" },
        }));
        patchThread(chatId, (m) => {
          const last = m[m.length - 1];
          if (last?.role === "assistant") {
            return [...m.slice(0, -1), { role: "assistant", text: last.text + ev.text }];
          }
          return [...m, { role: "assistant", text: ev.text ?? "" }];
        });
      }
      if (ev.kind === "error" && ev.text) {
        patchThread(chatId, (m) => [...m, { role: "error", text: ev.text ?? "" }]);
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: ev.text ?? "Error", steps: p[chatId]?.steps ?? [] },
        }));
        if (activeChatRef.current?.id === chatId) setStatus(ev.text);
      }
      if (ev.kind === "done") {
        setPendingApprovals((list) => list.filter((a) => a.chatId !== chatId));
        setProgressByChat((p) => ({
          ...p,
          [chatId]: { status: ev.text ?? "Done.", steps: p[chatId]?.steps ?? [] },
        }));
        if (activeChatRef.current?.id === chatId) setStatus(ev.text ?? "Done.");
        const ws = workspaceRef.current;
        if (ws) void refreshTree(ws);
        void reloadOpenFile();
        const msgs = threadsRef.current[chatId];
        if (msgs) void window.desk.saveThread(chatId, msgs);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgs, running]);

  useEffect(() => {
    const ids = [...persistIds.current].filter(
      (id) => id in threads && savedThreads.current.get(id) !== threads[id],
    );
    if (!ids.length) return;
    const timer = window.setTimeout(() => {
      for (const id of ids) {
        const msgs = threads[id] ?? [];
        savedThreads.current.set(id, msgs);
        void window.desk.saveThread(id, msgs);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [threads]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      if (e.key === "Escape") setQuickOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openFilePath = async (filePath: string) => {
    const existing = tabsRef.current.find((t) => t.path === filePath);
    patchPrefs({ showCode: true });
    setSnippetId(null);
    if (existing) {
      setActivePath(filePath);
      return;
    }
    const text = await window.desk.readFile(filePath);
    const tab: Tab = { path: filePath, name: baseName(filePath), contents: text, dirty: false };
    setTabs((all) => [...all.filter((t) => t.path !== filePath), tab]);
    setActivePath(filePath);
  };

  const openEntry = async (entry: Entry) => {
    await openFilePath(entry.path);
  };

  const closeTab = (filePath: string) => {
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
    setPrompt("");
    composerRef.current?.focus();
    setStatus("New agent");
    void window.desk.upsertChat(chat);
    markUsed(id, workspace);
  };

  const send = async (resume = false) => {
    const text = prompt.trim();
    const chat = activeChat;
    if (!text || !chat || runningByChat[chat.id]) return;
    persistIds.current.add(chat.id);
    const titled =
      chat.title === "New agent" || chat.title === "Untitled chat"
        ? { ...chat, title: text.slice(0, 72), updatedAt: Date.now(), lastUsedAt: Date.now() }
        : { ...chat, updatedAt: Date.now(), lastUsedAt: Date.now() };
    setActiveChat(titled);
    setChats((all) => all.map((c) => (c.id === chat.id ? titled : c)));
    void window.desk.upsertChat(titled);
    const nextMsgs = [...(threadsRef.current[chat.id] ?? []), { role: "user" as const, text }];
    setThreads((t) => ({ ...t, [chat.id]: nextMsgs }));
    void window.desk.saveThread(chat.id, nextMsgs);
    setPrompt("");
    setProgressByChat((p) => ({ ...p, [chat.id]: { status: "Starting…", steps: [], phase: "starting" } }));
    markUsed(chat.id, chat.projectPath || workspace);
    const history = nextMsgs
      .slice(0, -1)
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text }));
    await window.desk.runClaude({
      prompt: text,
      resume,
      history,
      chatId: chat.id,
      workspace: chat.projectPath || workspace,
    });
  };

  const catchUp = async () => {
    const chat = activeChat;
    if (!chat || runningByChat[chat.id]) return;
    const cwd = chat.projectPath || workspace;
    persistIds.current.add(chat.id);
    setThreads((t) => ({
      ...t,
      [chat.id]: [
        ...(t[chat.id] ?? []),
        { role: "user", text: `Catch Claude Code up on “${chat.title}”.` },
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

  const cliLabel = useMemo(() => {
    if (!cli) return "Detecting Claude CLI…";
    if (!cli.found) return "Claude CLI not found";
    const auth = authOk === null ? "" : authOk ? " · signed in" : " · not signed in";
    return `CLI ${auth}`;
  }, [cli, authOk]);

  const q = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    type Group = {
      key: string;
      name: string;
      path: string;
      slug: string;
      exists: boolean;
      lastChatAt: number;
      lastUsedAt: number;
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
        chats: [],
      };
      Object.assign(cur, extra);
      map.set(key, cur);
      return cur;
    };
    for (const p of projects) {
      const key = (p.path || p.slug).toLowerCase();
      put(key, {
        key,
        name: p.name,
        path: p.path,
        slug: p.slug,
        exists: p.exists,
        lastChatAt: p.lastChatAt ?? 0,
        lastUsedAt: p.lastUsedAt ?? p.lastChatAt ?? 0,
      });
    }
    for (const c of chats) {
      const pathKey = (c.projectPath || "").toLowerCase();
      const slugKey = c.slug.toLowerCase();
      const g =
        (pathKey && map.get(pathKey)) ||
        map.get(slugKey) ||
        put(slugKey, {
          key: slugKey,
          name: c.projectName,
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
          (a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999) || b.updatedAt - a.updatedAt,
        );
      } else {
        g.chats.sort((a, b) => b.updatedAt - a.updatedAt);
      }
    }
    let list = [...map.values()];
    if (q) {
      list = list
        .map((g) => {
          const projectHit =
            g.name.toLowerCase().includes(q) || g.path.toLowerCase().includes(q);
          return {
            ...g,
            chats: projectHit ? g.chats : g.chats.filter((c) => c.title.toLowerCase().includes(q)),
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
  }, [projects, chats, q, prefs.chatOrder, prefs.projectOrder]);

  const isExpanded = (key: string) => Boolean(prefs.expanded[key]);

  const toggleGroup = (key: string) => {
    patchPrefs({ expanded: { ...prefs.expanded, [key]: !prefs.expanded[key] } });
  };

  const hiddenProjectSet = useMemo(() => new Set(prefs.hiddenProjects), [prefs.hiddenProjects]);
  const hiddenChatSet = useMemo(() => new Set(prefs.hiddenChats), [prefs.hiddenChats]);
  const visibleGroups = q ? groups : groups.filter((g) => !hiddenProjectSet.has(g.key));
  const hiddenGroupList = groups.filter((g) => hiddenProjectSet.has(g.key));
  const hiddenChatList = chats.filter((c) => hiddenChatSet.has(c.id));

  const openMenu = (e: ReactMouseEvent, extra: Partial<CtxMenu> = {}) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 220),
      y: Math.min(e.clientY, window.innerHeight - 240),
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
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  return (
    <div
      className="app"
      style={
        {
          "--window-font": `${prefs.windowFont}px`,
          "--item-font": `${prefs.itemFont}px`,
        } as CSSProperties
      }
    >
      <header className="titlebar">
        <span className="brand">Agents</span>
        <span className="path" title={workspace}>
          {workspace ? baseName(workspace) : "No folder"}
        </span>
        <span className="grow" />
        <button className="ghost" onClick={() => setShowSettings(true)} title="Settings">
          Settings
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
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
          <div
            className="tree"
            onContextMenu={(e) => openMenu(e)}
          >
            {visibleGroups.map((g) => {
              const showAll = Boolean(q) || isExpanded(g.key);
              const current = samePath(g.path, workspace);
              const liveChats = g.chats.filter((c) => !hiddenChatSet.has(c.id));
              const runningChats = liveChats.filter((c) => runningByChat[c.id]);
              const idleChats = liveChats.filter((c) => !runningByChat[c.id]);
              const visibleChats = showAll ? liveChats : [...runningChats, ...idleChats].slice(0, Math.max(2, runningChats.length));
              const hiddenCount = liveChats.length - visibleChats.length;
              const projectRun = runningChats
                .map((c) => progressByChat[c.id])
                .sort((a, b) => phaseRank(b) - phaseRank(a))[0];
              return (
                <div
                  key={g.key}
                  className={`project-group ${dragging === `p:${g.key}` ? "dragging" : ""} ${dragOver === `p:${g.key}` ? "drag-over" : ""}`}
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
                    }
                    setDragOver(null);
                    setDragging(null);
                  }}
                  onDragEnd={() => {
                    setDragOver(null);
                    setDragging(null);
                  }}
                  onContextMenu={(e) => openMenu(e, { projectKey: g.key })}
                >
                  <button
                    className={`project-row ${current ? "current" : ""}`}
                    title={g.path || g.slug}
                    draggable={!q}
                    onDragStart={(e: DragEvent) => {
                      setDragData(e, { kind: "project", key: g.key });
                      setDragging(`p:${g.key}`);
                    }}
                    onClick={() => {
                      void openProjectLatest(g.path, liveChats);
                    }}
                  >
                    <span
                      className="chevron-hit"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroup(g.key);
                      }}
                    >
                      <Chevron open={showAll} />
                    </span>
                    <span className="list-title">{g.name}</span>
                    {projectRun && (
                      <span className={`phase phase-${projectRun.phase ?? "tool"}`}>{phaseWord(projectRun)}</span>
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
                  {visibleChats.map((c) => (
                      <button
                        key={c.id}
                        draggable={!q}
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
                        onContextMenu={(e) =>
                          openMenu(e, { projectKey: g.key, chatId: c.id, chatTitle: c.title })
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void openChat(c);
                        }}
                      >
                        <span className="list-title">{c.title}</span>
                        <span className="list-sub">
                          {runningByChat[c.id] ? phaseWord(progressByChat[c.id]) : relTime(c.lastUsedAt ?? c.updatedAt)}
                        </span>
                      </button>
                    ))}
                  {hiddenCount > 0 && (
                    <button
                      className="more-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        patchPrefs({ expanded: { ...prefs.expanded, [g.key]: true } });
                      }}
                    >
                      {hiddenCount} more
                    </button>
                  )}
                  {showAll && !q && liveChats.length > 2 && (
                    <button
                      className="more-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        patchPrefs({ expanded: { ...prefs.expanded, [g.key]: false } });
                      }}
                    >
                      Show less
                    </button>
                  )}
                  {liveChats.length === 0 && (
                    <div className="bubble system" style={{ margin: "4px 12px 8px 28px" }}>
                      No chats yet
                    </div>
                  )}
                </div>
              );
            })}
            {visibleGroups.length === 0 && (
              <div className="bubble system" style={{ margin: 10 }}>
                {hiddenGroupList.length ? "All projects hidden. Right-click to unhide." : "No Cursor projects found."}
              </div>
            )}
          </div>
          <button className="settings-item" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="files-toggle" onClick={() => setShowFiles((v) => !v)}>
            {showFiles ? "Hide files" : "Files"}
          </button>
          {showFiles && (
            <div className="tree files-tree">
              {roots.map((e) => (
                <FileNode
                  key={e.path}
                  entry={e}
                  depth={0}
                  active={activePath}
                  refreshKey={treeKey}
                  onOpen={(n) => void openEntry(n)}
                />
              ))}
            </div>
          )}
        </aside>

        <section className="agent">
          {prefs.showCode && (
            <CodePane
              files={tabs}
              activePath={activePath}
              snippets={snippets}
              snippetId={snippetId}
              onSelectFile={(p) => {
                setSnippetId(null);
                setActivePath(p);
              }}
              onSelectSnippet={setSnippetId}
              onCloseFile={closeTab}
              onHide={() => patchPrefs({ showCode: false })}
            />
          )}

          <div className="chat">
            <div className="pane-head chat-head">
              <span className="chat-title">{activeChat?.title ?? "New agent"}</span>
              {running && <span className="run-dot" title={runProgress?.status ?? "Starting"} />}
              {running && (
                <span className={`phase phase-${runProgress?.phase ?? "starting"}`}>{phaseWord(runProgress)}</span>
              )}
              <span className="grow" />
              <button
                className="ghost"
                onClick={() => patchPrefs({ showCode: !prefs.showCode })}
              >
                {prefs.showCode ? "Hide code" : "Code"}
              </button>
            </div>
            {(running || (runProgress && runProgress.steps.length > 0)) && (
              <div className={`run-progress ${running ? "live" : ""} ${runProgress?.phase ? `phase-${runProgress.phase}` : ""}`}>
                <div className="run-progress-status">
                  {running ? phaseWord(runProgress) : runProgress?.status}
                </div>
                {runProgress?.steps.length ? (
                  <div className="run-progress-steps">{runProgress.steps.join(" → ")}</div>
                ) : null}
              </div>
            )}
            <div className="messages">
              {msgs.length === 0 && (
                <div className="bubble system">
                  Click a project to open its last-used chat, or pick any past chat to read it.
                  Send continues this chat. Other chats can keep running.
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  {m.role === "user" || m.role === "assistant" ? (
                    <ChatMarkdown text={m.text} />
                  ) : (
                    m.text
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <div className="composer">
              <textarea
                ref={composerRef}
                placeholder="Message Claude Code…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    void send();
                    return;
                  }
                  if (e.shiftKey) return;
                  // Enter on an empty trailing line (i.e. a second Enter in a row) sends;
                  // otherwise let the textarea insert a newline.
                  const el = e.currentTarget;
                  const before = el.value.slice(0, el.selectionStart);
                  const after = el.value.slice(el.selectionEnd);
                  if (before.endsWith("\n") && after.trim() === "") {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="row">
                <button className="btn" disabled={running} onClick={() => void catchUp()}>
                  {running ? "Running…" : "Catch Claude up"}
                </button>
                <button className="btn primary" disabled={running} onClick={() => void send()}>
                  Send
                </button>
                <button
                  className="btn danger"
                  onClick={() => void window.desk.stopClaude(activeChat?.id)}
                >
                  Stop
                </button>
                <span className="grow" />
                <span className="hint">Enter twice or Ctrl+Enter send · Ctrl+P files</span>
              </div>
            </div>
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

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.chatId ? (
            <button onClick={() => hideChat(menu.chatId!)}>Hide chat</button>
          ) : menu.projectKey ? (
            <button onClick={() => hideProject(menu.projectKey!)}>Hide project</button>
          ) : null}
          {(menu.chatId || menu.projectKey) &&
          (hiddenGroupList.length > 0 || hiddenChatList.length > 0) ? (
            <div className="ctx-sep" />
          ) : null}
          {hiddenGroupList.length === 0 && hiddenChatList.length === 0 && !menu.chatId && !menu.projectKey ? (
            <div className="ctx-empty">Nothing hidden</div>
          ) : null}
          {hiddenGroupList.map((g) => (
            <button key={g.key} onClick={() => unhideProject(g.key)}>
              Unhide {g.name}
            </button>
          ))}
          {hiddenChatList.map((c) => (
            <button key={c.id} onClick={() => unhideChat(c.id)}>
              Unhide chat: {c.title}
            </button>
          ))}
        </div>
      )}

      {pendingApprovals[0] && (
        <PermissionDialog
          card={pendingApprovals[0]}
          waiting={pendingApprovals.length}
          chatTitle={chats.find((c) => c.id === pendingApprovals[0].chatId)?.title}
          onAnswer={(decision) => {
            const card = pendingApprovals[0];
            void window.desk.answerApproval({ chatId: card.chatId, requestId: card.requestId, ...decision });
          }}
        />
      )}

      {showSettings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="settings" onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <strong>Settings</strong>
              <button className="ghost" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
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
            <p className="settings-hint">
              Saved on disk and kept after restart. Right-click a project or chat to hide it.
              Drag items to reorder. Each folder shows two chats; use the chevron or more link for the rest.
            </p>
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
          </div>
        </div>
      )}

      <footer className={`status ${cli && (!cli.found || authOk === false) ? "warn" : ""}`}>
        <span>{status}</span>
        <span>
          {cliLabel}
          {Object.values(runningByChat).filter(Boolean).length
            ? ` · ${Object.values(runningByChat).filter(Boolean).length} running`
            : ""}
        </span>
      </footer>
    </div>
  );
}
