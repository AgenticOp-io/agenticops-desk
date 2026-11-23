import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "katex/dist/katex.min.css";
import "../src/styles.css";
import "./mobile.css";
import { Conversation } from "../src/Conversation";
import jsQR from "jsqr";
import {
  CLIENT_ID,
  parsePairCode,
  signInWithPairCode,
  type PairCode,
  finishSignIn,
  isRunning,
  loadProject,
  loadThread,
  projectRepos,
  sendMessage,
  session,
  startSignIn,
  type Chat,
  type DeviceCode,
  type Msg,
  type Project,
} from "./github";

// The phone side of AgenticOps Remote: the same projects and chats as the desk, read from and sent through GitHub.
// Messages typed here are run by the desktop on its next sync (every few minutes) and their replies come back the same way.

type Screen = { kind: "projects" } | { kind: "project"; repo: string } | { kind: "chat"; repo: string; chatId: string } | { kind: "new"; repo: string };
type Pending = { id: string; repo: string; chat?: string; title?: string; text: string; at: number };

const nothing = () => {};
const when = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} h ago`;
  return new Date(ms).toLocaleDateString();
};

// Last good data is kept, so the app opens instantly and still shows something offline.
const cache = {
  get: (): Record<string, Project> => JSON.parse(localStorage.getItem("cache.projects") ?? "{}") as Record<string, Project>,
  set: (v: Record<string, Project>) => localStorage.setItem("cache.projects", JSON.stringify(v)),
  pending: (): Pending[] => JSON.parse(localStorage.getItem("pending") ?? "[]") as Pending[],
  setPending: (v: Pending[]) => localStorage.setItem("pending", JSON.stringify(v)),
};

// Reads the desk's pairing QR with the camera (Capacitor's WebView asks for the camera permission itself).
function Scanner({ found, cancel }: { found: (text: string) => void; cancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let off = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const tick = () => {
      const v = video.current;
      if (off || !v) return;
      if (v.readyState >= 2 && v.videoWidth) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (hit?.data) return found(hit.data);
      }
      setTimeout(tick, 200);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        stream = s;
        if (off || !video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        tick();
      })
      .catch((e: Error) => setErr(`The camera didn't open: ${e.message}`));
    return () => {
      off = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [found]);
  return (
    <>
      <p>Point the camera at the code in the desk's Settings → Sync → Phone.</p>
      {err && <p className="m-error">{err}</p>}
      <video ref={video} className="m-scan" playsInline muted />
      <button className="ghost" onClick={cancel}>
        Cancel
      </button>
    </>
  );
}

function SignIn({ done }: { done: () => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [scan, setScan] = useState(false);
  const [pair, setPair] = useState<PairCode | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const scanned = useCallback(
    (text: string) => {
      setScan(false);
      const p = parsePairCode(text);
      if (p) setPair(p);
      else setErr("That isn't a desk pairing code.");
    },
    [],
  );
  const unlock = () =>
    signInWithPairCode(pair!, pin).then(done, (e: Error) => (setErr(e.message), setPin("")));
  useEffect(() => {
    if (!code) return;
    let off = false;
    finishSignIn(code, () => off)
      .then(() => !off && done())
      .catch((e: Error) => !off && (setErr(e.message), setCode(null)));
    return () => {
      off = true;
    };
  }, [code, done]);
  return (
    <main className="m-center">
      <h1 className="m-brand">AgenticOps Remote</h1>
      <p className="m-muted">Your projects and chats from the desk, through GitHub.</p>
      {err && <p className="m-error">{err}</p>}
      {pair ? (
        <>
          <p>Enter the 8 digits shown beside the code on your desk:</p>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          <button className="m-primary" disabled={pin.length !== 8} onClick={unlock}>
            Sign in
          </button>
          <button className="ghost" onClick={() => (setPair(null), setPin(""))}>
            Cancel
          </button>
        </>
      ) : scan ? (
        <Scanner found={scanned} cancel={() => setScan(false)} />
      ) : !code ? (
        <>
          <button className="m-primary" onClick={() => (setErr(""), setScan(true))}>
            Scan the code on your desk
          </button>
          {/* Device-flow sign-in only exists in builds that were given an OAuth app (VITE_GITHUB_CLIENT_ID). */}
          {CLIENT_ID && (
            <button className="ghost" onClick={() => void startSignIn().then(setCode, (e: Error) => setErr(e.message))}>
              Sign in with GitHub instead
            </button>
          )}
        </>
      ) : (
        <>
          <p>Enter this code on GitHub:</p>
          <div className="m-code">{code.user_code}</div>
          <a
            className="m-primary"
            href={code.verification_uri}
            onClick={() => void navigator.clipboard?.writeText(code.user_code).then(() => setCopied(true), nothing)}
          >
            {copied ? "Code copied · Open GitHub" : "Copy code and open GitHub"}
          </a>
          <p className="m-muted">Waiting for you to approve…</p>
          <button className="ghost" onClick={() => setCode(null)}>
            Cancel
          </button>
        </>
      )}
    </main>
  );
}

function Header({ title, back, children }: { title: string; back?: () => void; children?: ReactNode }) {
  return (
    <header className="m-head">
      {back && (
        <button className="m-back" aria-label="Back" onClick={back}>
          ‹
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

function Composer({ placeholder, onSend, withTitle }: { placeholder: string; onSend: (text: string, title?: string) => Promise<void>; withTitle?: boolean }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr("");
    onSend(text.trim(), withTitle ? title.trim() || undefined : undefined)
      .then(() => (setText(""), setTitle("")))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="m-composer">
      {err && <div className="m-error">{err}</div>}
      {withTitle && <input placeholder="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}
      <div className="m-composer-row">
        <textarea rows={withTitle ? 6 : 2} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="m-primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function ChatView({ project, chat, pending, send, refresh }: { project: Project; chat: Chat; pending: Pending[]; send: (text: string) => Promise<void>; refresh: () => void }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(() => JSON.parse(localStorage.getItem(`thread.${chat.id}`) ?? "null") as Msg[] | null);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = isRunning(project.jobs, chat.id);
  const load = useCallback(() => {
    loadThread(project.repo, chat.id).then(
      (m) => {
        setMsgs(m);
        setErr("");
        localStorage.setItem(`thread.${chat.id}`, JSON.stringify(m));
      },
      (e: Error) => setErr(e.message),
    );
  }, [project.repo, chat.id]);
  useEffect(load, [load, project.head]);
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  // Waiting on the desk: look for news often; otherwise now and then.
  useEffect(() => {
    const t = setInterval(refresh, running || pending.length ? 20_000 : 60_000);
    return () => clearInterval(t);
  }, [refresh, running, pending.length]);
  return (
    <div className="chat worker-watch m-chat">
      <div
        className="messages"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {err && <div className="m-error">{err}</div>}
        {!msgs ? <p className="m-muted">Loading…</p> : <Conversation msgs={msgs} live={!!running} liveStatus={running ? `Running on ${running.host}` : undefined} onRewind={nothing} onRetry={nothing} onBranch={nothing} onReplay={nothing} />}
        {pending.map((p) => (
          <div key={p.id} className="bubble user m-pending">
            {p.text}
            <div className="m-muted">Sent {when(p.at)} · the desk picks it up on its next sync</div>
          </div>
        ))}
      </div>
      <Composer placeholder="Message the agent on your desk" onSend={send} />
    </div>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(!!session.token());
  const [projects, setProjects] = useState<Record<string, Project>>(cache.get);
  const [pending, setPending] = useState<Pending[]>(cache.pending);
  const [stack, setStack] = useState<Screen[]>([{ kind: "projects" }]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const screen = stack[stack.length - 1];

  // The Android back button walks the WebView's history, so each screen is a history entry.
  const go = (s: Screen) => {
    history.pushState(null, "");
    setStack((st) => [...st, s]);
  };
  const back = () => history.back();
  useEffect(() => {
    const pop = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  const busy = useRef(false);
  const refresh = useCallback(() => {
    if (busy.current || !session.token()) return;
    busy.current = true;
    setLoading(true);
    projectRepos()
      .then(async (repos) => {
        const old = cache.get();
        const next: Record<string, Project> = {};
        for (const { repo, head } of repos) next[repo] = old[repo]?.head === head ? old[repo] : await loadProject(repo, head);
        cache.set(next);
        setProjects(next);
        setErr("");
        // A message whose inbox file is gone was taken by the desk; its turn now shows in the thread.
        const left = cache.pending().filter((p) => next[p.repo]?.inbox.includes(p.id));
        cache.setPending(left);
        setPending(left);
      })
      .catch((e: Error) => {
        setErr(e.message);
        if (!session.token()) setSignedIn(false);
      })
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, []);
  useEffect(() => {
    if (signedIn) refresh();
  }, [signedIn, refresh]);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 120_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!signedIn) return <SignIn done={() => setSignedIn(true)} />;

  const send = async (repo: string, msg: { chat?: string; title?: string; text: string }) => {
    const p = projects[repo];
    // Sent to the computer that last ran this chat (or this project), so two desks don't both run it.
    const host = (msg.chat ? p?.jobs.find((j) => j.chat === msg.chat) : p?.jobs[0])?.host;
    const id = await sendMessage(repo, { ...msg, host });
    const next = [...cache.pending(), { id, repo, ...msg, at: Date.now() }];
    cache.setPending(next);
    setPending(next);
  };
  const reload = (
    <button className="ghost" disabled={loading} onClick={refresh}>
      {loading ? "…" : "Refresh"}
    </button>
  );
  const errorLine = err && <div className="m-error">{err}</div>;

  if (screen.kind === "chat" || screen.kind === "new" || screen.kind === "project") {
    const project = projects[screen.repo];
    if (!project) return <Header title="Not found" back={back} />;
    if (screen.kind === "new") {
      return (
        <div className="m-screen">
          <Header title={`New chat · ${project.name}`} back={back} />
          <p className="m-muted m-pad">The desk starts this chat on its next sync, in the same project folder.</p>
          <Composer
            withTitle
            placeholder="What should the agent do?"
            onSend={async (text, title) => {
              await send(project.repo, { text, title });
              back();
            }}
          />
        </div>
      );
    }
    if (screen.kind === "chat") {
      const chat = project.chats.find((c) => c.id === screen.chatId);
      if (!chat) return <Header title="Chat not found" back={back} />;
      return (
        <div className="m-screen">
          <Header title={chat.title || "Untitled chat"} back={back}>
            {reload}
          </Header>
          {errorLine}
          <ChatView project={project} chat={chat} pending={pending.filter((p) => p.chat === chat.id)} send={(text) => send(project.repo, { chat: chat.id, text })} refresh={refresh} />
        </div>
      );
    }
    const fresh = pending.filter((p) => p.repo === project.repo && !p.chat);
    return (
      <div className="m-screen">
        <Header title={project.name} back={back}>
          {reload}
        </Header>
        {errorLine}
        <main className="m-list">
          <button className="m-primary m-new" onClick={() => go({ kind: "new", repo: project.repo })}>
            New chat
          </button>
          {fresh.map((p) => (
            <div key={p.id} className="m-row m-pending">
              <div className="m-row-title">{p.title || "From phone"}</div>
              <div className="m-muted">Waiting for the desk · sent {when(p.at)}</div>
            </div>
          ))}
          {[...project.chats]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => {
              const run = isRunning(project.jobs, c.id);
              return (
                <button key={c.id} className="m-row" onClick={() => go({ kind: "chat", repo: project.repo, chatId: c.id })}>
                  <div className="m-row-title">
                    {run && <span className="run-dot" />} {c.title || "Untitled chat"}
                  </div>
                  <div className="m-muted">{run ? `Running on ${run.host}` : when(c.updatedAt)}</div>
                </button>
              );
            })}
          {project.jobs.length > 0 && (
            <details className="m-jobs">
              <summary>Recent jobs</summary>
              {project.jobs.slice(0, 30).map((j, i) => (
                <div key={i} className="m-muted">
                  {j.ev === "start" ? "▶ Started" : "■ Finished"} · {project.chats.find((c) => c.id === j.chat)?.title ?? j.chat} · {j.host} · {when(j.at)}
                </div>
              ))}
            </details>
          )}
        </main>
      </div>
    );
  }

  const list = Object.values(projects).sort((a, b) => (b.chats[0] ? Math.max(...b.chats.map((c) => c.updatedAt)) : 0) - (a.chats[0] ? Math.max(...a.chats.map((c) => c.updatedAt)) : 0));
  return (
    <div className="m-screen">
      <Header title="Projects">
        {reload}
        <button
          className="ghost"
          onClick={() => {
            if (!confirm(`Sign ${session.login()} out of this phone?`)) return;
            session.clear();
            localStorage.clear();
            setProjects({});
            setPending([]);
            setSignedIn(false);
          }}
        >
          Sign out
        </button>
      </Header>
      {errorLine}
      <main className="m-list">
        {list.map((p) => {
          const runs = p.chats.filter((c) => isRunning(p.jobs, c.id)).length;
          return (
            <button key={p.repo} className="m-row" onClick={() => go({ kind: "project", repo: p.repo })}>
              <div className="m-row-title">
                {runs > 0 && <span className="run-dot" />} {p.name}
              </div>
              <div className="m-muted">
                {p.repo} · {p.chats.length} {p.chats.length === 1 ? "chat" : "chats"}
                {runs > 0 ? ` · ${runs} running` : ""}
              </div>
            </button>
          );
        })}
        {!loading && list.length === 0 && (
          <p className="m-muted m-pad">
            No projects yet. A project shows up here once the desk has synced its chats to a desk-chats branch in its private GitHub repository.
          </p>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
