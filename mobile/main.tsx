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
import { credential, localModel, route, runAgent, type AgentMsg, type Route } from "./agent";
import { CloudView } from "./cloud";
import {
  CLIENT_ID,
  listFiles,
  readRepoFile,
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
  type Approval,
  type Chat,
  type DeviceCode,
  type Msg,
  type Project,
} from "./github";

// The phone side of AgenticOps Remote: the same projects and chats as the desk, read from and sent through GitHub.
// Messages typed here are run by the desktop on its next sync (every few minutes) and their replies come back the same way.

type Screen = { kind: "projects" } | { kind: "project"; repo: string } | { kind: "chat"; repo: string; chatId: string } | { kind: "new"; repo: string } | { kind: "agent"; repo: string } | { kind: "files"; repo: string };
type Tab = "inbox" | "projects" | "agent" | "cloud" | "settings";
type Pending = { id: string; repo: string; chat?: string; title?: string; text: string; at: number };
type Out = { chat?: string; title?: string; text?: string; image?: string; approve?: { request: string; allow: boolean }; stop?: boolean };

// A photo is shrunk to 1280 px JPEG so the message stays small enough for GitHub.
const shrink = (file: File) =>
  new Promise<string>((ok, no) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => no(new Error("That photo could not be read."));
    img.src = URL.createObjectURL(file);
  });
const Speech = (window as unknown as { SpeechRecognition?: new () => SpeechLike; webkitSpeechRecognition?: new () => SpeechLike }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechLike }).webkitSpeechRecognition;
type SpeechLike = { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
const answered = {
  get: (): string[] => JSON.parse(localStorage.getItem("answered") ?? "[]") as string[],
  add: (id: string) => localStorage.setItem("answered", JSON.stringify([...answered.get(), id].slice(-200))),
};

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
  // Older caches have no approvals list.
  get: (): Record<string, Project> => Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem("cache.projects") ?? "{}") as Record<string, Project>).map(([k, p]) => [k, { ...p, approvals: p.approvals ?? [] }])),
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

function Composer({ placeholder, onSend, withTitle }: { placeholder: string; onSend: (text: string, title?: string, image?: string) => Promise<void>; withTitle?: boolean }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [photo, setPhoto] = useState<string | undefined>();
  const [listening, setListening] = useState(false);
  const mic = useRef<SpeechLike | null>(null);
  const dictate = () => {
    if (mic.current) return mic.current.stop();
    const sr = new Speech!();
    sr.lang = navigator.language;
    sr.onresult = (e) => setText((t) => `${t} ${Array.from(e.results, (x) => x[0].transcript).join(" ")}`.trim());
    sr.onend = () => ((mic.current = null), setListening(false));
    mic.current = sr;
    setListening(true);
    sr.start();
  };
  const send = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr("");
    onSend(text.trim(), withTitle ? title.trim() || undefined : undefined, photo)
      .then(() => (setText(""), setTitle(""), setPhoto(undefined)))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="m-composer">
      {err && <div className="m-error">{err}</div>}
      {withTitle && <input placeholder="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}
      <div className="m-composer-row">
        <label className="ghost m-attach" aria-label="Attach a photo">
          {photo ? "Photo ✓" : "Photo"}
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && shrink(e.target.files[0]).then(setPhoto, (x: Error) => setErr(x.message))} />
        </label>
        {Speech && <button className="ghost" aria-label="Dictate" onClick={dictate}>{listening ? "Stop" : "Voice"}</button>}
        <textarea rows={withTitle ? 6 : 2} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="m-primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function AgentView({ repo }: { repo: string }) {
  const [hist, setHist] = useState<AgentMsg[]>(() => JSON.parse(localStorage.getItem(`agent.${repo}`) ?? "[]") as AgentMsg[]);
  const [hasKey, setHasKey] = useState(!!credential.get() || !!localModel.get().url);
  const [keyText, setKeyText] = useState("");
  const [localUrl, setLocalUrl] = useState(localModel.get().url);
  const [localName, setLocalName] = useState(localModel.get().model);
  const save = (h: AgentMsg[]) => (setHist(h), localStorage.setItem(`agent.${repo}`, JSON.stringify(h)));
  if (!hasKey)
    return (
      <div className="m-composer">
        <p className="m-muted">
          This agent runs on your phone and calls the model API directly. Chat goes to Haiku, which hands real coding work to Sonnet or Opus. Paste your API key; it stays on this phone.
        </p>
        <input type="password" placeholder={credential.get() ? "API key (saved; leave empty to keep)" : "API key"} value={keyText} onChange={(e) => setKeyText(e.target.value)} />
        <p className="m-muted">Optional: a local Ollama model to chat with instead of Haiku. Harder work still goes to Sonnet or Opus with the API key.</p>
        <input placeholder="Local model URL, e.g. http://192.168.1.20:11434" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} />
        <input placeholder="Local model name, e.g. qwen3-coder:30b" value={localName} onChange={(e) => setLocalName(e.target.value)} />
        <button
          className="m-primary"
          disabled={!(keyText.trim() || credential.get() || (localUrl.trim() && localName.trim())) || (!!localUrl.trim() !== !!localName.trim())}
          onClick={() => (keyText.trim() && credential.set(keyText), localModel.set(localUrl, localName), setHasKey(true))}
        >
          Save
        </button>
      </div>
    );
  const text = (m: AgentMsg) =>
    typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? String(c.text) : c.type === "tool_use" ? `▸ ${String(c.name)} ${JSON.stringify(c.input).slice(0, 120)}` : "")).filter(Boolean).join(String.fromCharCode(10));
  return (
    <div className="chat m-chat">
      <div className="messages">
        {hist.map((m, i) => (text(m) ? <div key={i} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>{text(m)}</div> : null))}
        {!hist.length && <p className="m-muted m-pad">Ask about {repo}. The agent can read files and writes only to the phone-work branch.</p>}
      </div>
      <button className="m-link" onClick={() => setHasKey(false)}>
        Models: {localModel.get().url ? `local ${localModel.get().model}` : "Haiku"} → Sonnet / Opus · change
      </button>
      <Composer
        placeholder="Message the phone agent"
        onSend={async (t) => {
          const h: AgentMsg[] = [...hist, { role: "user", content: t }];
          save(h);
          try {
            await runAgent(repo, h, save);
          } catch (e) {
            save([...h, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
          }
        }}
      />
    </div>
  );
}

// Browse and read the repo's files over GitHub (read-only).
function FilesView({ repo }: { repo: string }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    listFiles(repo).then((t) => setFiles(t.split(String.fromCharCode(10)).filter((l) => !l.startsWith(" … "))), (e: Error) => setErr(e.message));
  }, [repo]);
  if (open)
    return (
      <main className="m-list m-pad">
        <button className="m-link" onClick={() => setOpen(null)}>‹ {open.path}</button>
        <pre className="m-file">{open.text}</pre>
      </main>
    );
  return (
    <main className="m-list">
      <input className="m-search" placeholder="Filter files" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="m-error">{err}</div>}
      {!files && !err && <p className="m-muted m-pad">Loading…</p>}
      {files?.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 200).map((f) => (
        <button key={f} className="m-row" onClick={() => readRepoFile(repo, f).then((text) => setOpen({ path: f, text }), (e: Error) => setErr(e.message))}>
          <div className="m-row-title">{f}</div>
        </button>
      ))}
    </main>
  );
}

function SettingsView({ projects, onSignOut }: { projects: Record<string, Project>; onSignOut: () => void }) {
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(!!credential.get());
  const [url, setUrl] = useState(localModel.get().url);
  const [name, setName] = useState(localModel.get().model);
  const [r, setR] = useState<Route>(route.get());
  const [mins, setMins] = useState(localStorage.getItem("phone.refresh") ?? "2");
  const [saved, setSaved] = useState(false);
  // Last time each desk wrote a job, from the jobs the projects already carry.
  const desks = new Map<string, number>();
  for (const p of Object.values(projects)) for (const j of p.jobs) desks.set(j.host, Math.max(desks.get(j.host) ?? 0, j.at));
  const save = () => {
    if (key.trim()) credential.set(key);
    localModel.set(url, name);
    route.set(r);
    localStorage.setItem("phone.refresh", String(Math.max(1, Number(mins) || 2)));
    setHasKey(!!credential.get());
    setKey("");
    setSaved(true);
  };
  return (
    <main className="m-list m-pad m-settings">
      <h2>API key</h2>
      <input type="password" placeholder={hasKey ? "Saved on this phone; paste to replace" : "Paste your API key"} value={key} onChange={(e) => setKey(e.target.value)} />
      {hasKey && <button className="ghost" onClick={() => (credential.set(""), setHasKey(false))}>Remove key</button>}
      <h2>Model routing</h2>
      <select value={r} onChange={(e) => setR(e.target.value as Route)}>
        <option value="auto">Auto: Haiku chats, hands harder work up</option>
        <option value="haiku">Always Haiku</option>
        <option value="sonnet">Always Sonnet</option>
        <option value="opus">Always Opus</option>
      </select>
      <input placeholder="Local model URL (optional, replaces Haiku for chat)" value={url} onChange={(e) => setUrl(e.target.value)} />
      <input placeholder="Local model name" value={name} onChange={(e) => setName(e.target.value)} />
      <h2>Notifications</h2>
      <p className="m-muted">Alerts appear while the app is open or in recent apps; Android may stop a closed app from checking.</p>
      <button className="ghost" onClick={() => typeof Notification !== "undefined" && void Notification.requestPermission().then(() => setSaved((v) => !v))}>
        {typeof Notification === "undefined" ? "Not supported here" : Notification.permission === "granted" ? "Notifications on" : "Turn on notifications"}
      </button>
      <h2>Refresh</h2>
      <label className="m-muted">Check the desk every <input className="m-num" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/\D/g, ""))} /> minutes</label>
      <button className="m-primary" disabled={(!!url.trim() !== !!name.trim())} onClick={save}>{saved ? "Saved" : "Save"}</button>
      <h2>Account</h2>
      <p className="m-muted">Signed in as {session.login() || "GitHub"}.</p>
      <button className="ghost" onClick={() => confirm("Remove the cached projects and chats from this phone?") && (["cache.projects", "pending"].forEach((k) => localStorage.removeItem(k)), location.reload())}>Clear local data</button>
      <button className="ghost" onClick={onSignOut}>Sign out</button>
      <h2>Desks</h2>
      {desks.size === 0 && <p className="m-muted">No desk has run a job yet.</p>}
      {[...desks].map(([h, at]) => <p key={h} className="m-muted">{h} · last seen {when(at)}</p>)}
      <h2>About</h2>
      <p className="m-muted">AgenticOps Remote. Desk questions and plan approvals must be answered at the desk.</p>
    </main>
  );
}

function ApprovalCards({ list, title, act }: { list: Array<{ project: Project; a: Approval }>; title: (chat: string, p: Project) => string; act: (p: Project, a: Approval, allow: boolean) => void }) {
  return (
    <>
      {list.map(({ project, a }) => (
        <div key={a.request} className="m-row m-approval">
          <div className="m-row-title">{a.summary}</div>
          <div className="m-muted">{title(a.chat, project)} · on {a.host}</div>
          {a.detail && <pre className="m-file">{a.detail}</pre>}
          <div className="m-composer-row">
            <button className="ghost" onClick={() => act(project, a, false)}>Deny</button>
            <button className="m-primary" onClick={() => act(project, a, true)}>Allow</button>
          </div>
        </div>
      ))}
    </>
  );
}

function InboxView({ projects, open, act }: { projects: Record<string, Project>; open: (repo: string, chat: string) => void; act: (p: Project, a: Approval, allow: boolean) => void }) {
  const waiting = Object.values(projects).flatMap((project) => project.approvals.filter((a) => !answered.get().includes(a.request)).map((a) => ({ project, a })));
  const rows = Object.values(projects).flatMap((p) => p.chats.map((c) => ({ p, c, run: isRunning(p.jobs, c.id), end: p.jobs.find((j) => j.chat === c.id && j.ev === "end")?.at ?? 0 })));
  const running = rows.filter((x) => x.run);
  const done = rows.filter((x) => !x.run && x.end).sort((a, b) => b.end - a.end).slice(0, 30);
  const row = (x: (typeof rows)[number], sub: string) => (
    <button key={x.p.repo + x.c.id} className="m-row" onClick={() => open(x.p.repo, x.c.id)}>
      <div className="m-row-title">{x.run && <span className="run-dot" />} {x.c.title || "Untitled chat"}</div>
      <div className="m-muted">{x.p.name} · {sub}</div>
    </button>
  );
  return (
    <main className="m-list">
      {waiting.length > 0 && <h2 className="m-sec">Needs you</h2>}
      <ApprovalCards list={waiting} title={(c, p) => p.chats.find((x) => x.id === c)?.title || "Untitled chat"} act={act} />
      {running.length > 0 && <h2 className="m-sec">Running</h2>}
      {running.map((x) => row(x, `on ${x.run!.host}`))}
      <h2 className="m-sec">Finished</h2>
      {done.map((x) => row(x, when(x.end)))}
      {!running.length && !done.length && <p className="m-muted m-pad">Nothing has run yet.</p>}
    </main>
  );
}

function ChatView({ project, chat, pending, send, refresh, act, stop }: { project: Project; chat: Chat; pending: Pending[]; send: (text: string, title?: string, image?: string) => Promise<void>; refresh: () => void; act: (p: Project, a: Approval, allow: boolean) => void; stop: () => void }) {
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
      <ApprovalCards list={project.approvals.filter((a) => a.chat === chat.id && !answered.get().includes(a.request)).map((a) => ({ project, a }))} title={() => chat.title || "Untitled chat"} act={act} />
      {running && <button className="ghost m-new" onClick={() => confirm("Stop this chat on the desk?") && stop()}>Stop the run</button>}
      <Composer placeholder="Message the agent on your desk" onSend={(t, _title, image) => send(t, undefined, image)} />
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
  const [tab, setTab] = useState<Tab>("projects");
  const [agentRepo, setAgentRepo] = useState(localStorage.getItem("phone.agentRepo") ?? "");
  const [q, setQ] = useState("");
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
        // Tell the user about new questions from the desk and chats that just finished.
        const seen = new Set(JSON.parse(localStorage.getItem("seen.approvals") ?? "[]") as string[]);
        const fresh = Object.values(next).flatMap((p) => p.approvals).filter((a) => !seen.has(a.request) && !answered.get().includes(a.request));
        const finished = Object.values(next).flatMap((p) => p.chats.filter((c) => old[p.repo] && isRunning(old[p.repo].jobs, c.id) && !isRunning(p.jobs, c.id)));
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          for (const a of fresh) new Notification("Needs your answer", { body: a.summary });
          for (const c of finished) new Notification("Chat finished", { body: c.title || "Untitled chat" });
        }
        if (fresh.length) navigator.vibrate?.(200);
        localStorage.setItem("seen.approvals", JSON.stringify(Object.values(next).flatMap((p) => p.approvals.map((a) => a.request)).slice(-200)));
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
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), Math.max(1, Number(localStorage.getItem("phone.refresh")) || 2) * 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!signedIn) return <SignIn done={() => setSignedIn(true)} />;

  const send = async (repo: string, msg: Out) => {
    const p = projects[repo];
    // Sent to the computer that last ran this chat (or this project), so two desks don't both run it.
    const host = (msg.chat ? p?.jobs.find((j) => j.chat === msg.chat) : p?.jobs[0])?.host;
    const id = await sendMessage(repo, { ...msg, host });
    if (!msg.text) return; // an answer or a stop has nothing to wait for in the thread
    const next = [...cache.pending(), { id, repo, chat: msg.chat, title: msg.title, text: msg.image ? `${msg.text} (photo)` : msg.text, at: Date.now() }];
    cache.setPending(next);
    setPending(next);
  };
  const act = (p: Project, a: Approval, allow: boolean) => {
    answered.add(a.request);
    setPending((v) => [...v]); // redraw without the card
    send(p.repo, { chat: a.chat, approve: { request: a.request, allow } }).catch((e: Error) => setErr(e.message));
  };
  const reload = (
    <button className="ghost" disabled={loading} onClick={refresh}>
      {loading ? "…" : "Refresh"}
    </button>
  );
  const errorLine = err && <div className="m-error">{err}</div>;

  const signOut = () => {
    if (!confirm(`Sign ${session.login()} out of this phone?`)) return;
    session.clear();
    localStorage.clear();
    setProjects({});
    setPending([]);
    setSignedIn(false);
  };

  if (screen.kind === "chat" || screen.kind === "new" || screen.kind === "project" || screen.kind === "agent" || screen.kind === "files") {
    const project = projects[screen.repo];
    if (!project) return <Header title="Not found" back={back} />;
    if (screen.kind === "files")
      return (
        <div className="m-screen">
          <Header title={`Files · ${project.name}`} back={back} />
          <FilesView repo={project.repo} />
        </div>
      );
    if (screen.kind === "agent")
      return (
        <div className="m-screen">
          <Header title={`Phone agent · ${project.name}`} back={back} />
          <AgentView repo={project.repo} />
        </div>
      );
    if (screen.kind === "new") {
      return (
        <div className="m-screen">
          <Header title={`New chat · ${project.name}`} back={back} />
          <p className="m-muted m-pad">The desk starts this chat on its next sync, in the same project folder.</p>
          <Composer
            withTitle
            placeholder="What should the agent do?"
            onSend={async (text, title, image) => {
              await send(project.repo, { text, title, image });
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
          <ChatView project={project} chat={chat} pending={pending.filter((p) => p.chat === chat.id)} send={(text, _t, image) => send(project.repo, { chat: chat.id, text, image })} refresh={refresh} act={act} stop={() => send(project.repo, { chat: chat.id, stop: true }).catch((e: Error) => setErr(e.message))} />
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
          <button className="m-primary m-new" onClick={() => go({ kind: "agent", repo: project.repo })}>
            Phone agent
          </button>
          <button className="ghost m-new" onClick={() => go({ kind: "files", repo: project.repo })}>
            Browse files
          </button>
          <input className="m-search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
          {fresh.map((p) => (
            <div key={p.id} className="m-row m-pending">
              <div className="m-row-title">{p.title || "From phone"}</div>
              <div className="m-muted">Waiting for the desk · sent {when(p.at)}</div>
            </div>
          ))}
          {project.chats
            .filter((c) => (c.title || "Untitled chat").toLowerCase().includes(q.toLowerCase()))
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

  const badge = Object.values(projects).reduce((n, p) => n + p.approvals.filter((a) => !answered.get().includes(a.request)).length, 0);
  const list = Object.values(projects).sort((a, b) => (b.chats[0] ? Math.max(...b.chats.map((c) => c.updatedAt)) : 0) - (a.chats[0] ? Math.max(...a.chats.map((c) => c.updatedAt)) : 0));
  return (
    <div className="m-screen">
      <Header title={{ inbox: "Inbox", projects: "Projects", agent: "Agent", cloud: "Cloud agents", settings: "Settings" }[tab]}>{reload}</Header>
      {errorLine}
      {tab === "cloud" && <CloudView />}
      {tab === "inbox" && <InboxView projects={projects} open={(repo, chatId) => go({ kind: "chat", repo, chatId })} act={act} />}
      {tab === "settings" && <SettingsView projects={projects} onSignOut={signOut} />}
      {tab === "agent" && (
        <>
          <select className="m-search" value={agentRepo} onChange={(e) => (setAgentRepo(e.target.value), localStorage.setItem("phone.agentRepo", e.target.value))}>
            <option value="">Choose a project</option>
            {list.map((p) => <option key={p.repo} value={p.repo}>{p.name}</option>)}
          </select>
          {projects[agentRepo] ? <AgentView key={agentRepo} repo={agentRepo} /> : <p className="m-muted m-pad">Pick a project to talk to the phone agent.</p>}
        </>
      )}
      {tab === "projects" && <main className="m-list">
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
      </main>}
      <nav className="m-tabs">
        {(["inbox", "projects", "agent", "cloud", "settings"] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === "inbox" && badge > 0 ? ` (${badge})` : ""}
          </button>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
