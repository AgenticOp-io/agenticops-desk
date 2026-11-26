import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "katex/dist/katex.min.css";
import "../src/styles.css";
import "./mobile.css";
import logo from "../public/logo.svg";
import { Conversation } from "../src/Conversation";
import { ChatMarkdown } from "../src/ChatMarkdown";
import jsQR from "jsqr";
import { DeskWatch, loadSecrets, native, secret } from "./secrets";
import { credential, runAgent, type AgentMsg } from "./agent";
import { CloudJobs, hasCloud, startCloudJob } from "./cloud";
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
  type Answer,
  type Approval,
  type Chat,
  type DeviceCode,
  type Msg,
  type Project,
} from "./github";


// AgenticOps Remote: a remote control, not a second desk. You send work to the desk, the cloud agents or the AI, and
// answer what they ask. All setup (projects, API key, cloud login) comes from the desk's pairing QR; nothing is configured here.
// Desk messages travel through GitHub: the desk runs them on its next sync and the replies come back the same way.

type Screen = { kind: "home" } | { kind: "chat"; repo: string; chatId: string };
type Tab = "inbox" | "send" | "settings";
type Target = "desk" | "cloud" | "ai";
type Pending = { id: string; repo: string; chat?: string; text: string; at: number };
type Out = { chat?: string; text?: string; image?: string; approve?: Answer; stop?: boolean };
type Act = (p: Project, a: Approval, allow: boolean, answers?: Record<string, string>) => void;

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

// `cancel` = re-pairing from Settings to pick up the desk's new setup: go straight to the camera.
function SignIn({ done, cancel }: { done: () => void; cancel?: () => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [scan, setScan] = useState(!!cancel);
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
      <img className="m-logo" src={logo} alt="" />
      <h1 className="m-brand">AgenticOps Remote</h1>
      <p className="m-muted">Send work to your desk, cloud agents or AI. Everything is set up from the desk.</p>
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
        <Scanner found={scanned} cancel={cancel ?? (() => setScan(false))} />
      ) : !code ? (
        <>
          <button className="m-primary" onClick={() => (setErr(""), setScan(true))}>
            Scan the code on your desk
          </button>
          {/* Device-flow sign-in only exists in builds that were given an OAuth app (VITE_GITHUB_CLIENT_ID). */}
          {cancel && <button className="ghost" onClick={cancel}>Back</button>}
          {!cancel && CLIENT_ID && (
            <button className="ghost" onClick={() => void startSignIn().then(setCode, (e: Error) => setErr(e.message))}>
              Sign in with GitHub instead
            </button>
          )}
        </>
      ) : (
        <>
          <p>Enter this code on GitHub:</p>
          <div className="m-code">{code.user_code}</div>
          {/* The system browser, never the app's own view: a page loaded there has no way back into the app. */}
          <button
            className="m-primary"
            onClick={() => {
              void navigator.clipboard?.writeText(code.user_code).then(() => setCopied(true), nothing);
              if (native) void DeskWatch.open({ url: code.verification_uri }).catch((e: Error) => setErr(e.message));
              else window.open(code.verification_uri, "_blank", "noopener");
            }}
          >
            {copied ? "Code copied · Open GitHub" : "Copy code and open GitHub"}
          </button>
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
      {back ? (
        <button className="m-back" aria-label="Back" onClick={back}>
          ‹
        </button>
      ) : (
        <img className="m-head-logo" src={logo} alt="AgenticOps" />
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

function Composer({ placeholder, onSend, photos = true }: { placeholder: string; onSend: (text: string, image?: string) => Promise<void>; photos?: boolean }) {
  const [text, setText] = useState("");
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
    onSend(text.trim(), photo)
      .then(() => (setText(""), setPhoto(undefined)))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="m-composer">
      {err && <div className="m-error">{err}</div>}
      <div className="m-composer-row">
        {photos && (
          <label className="ghost m-attach" aria-label="Attach a photo">
            {photo ? "Photo ✓" : "Photo"}
            <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && shrink(e.target.files[0]).then(setPhoto, (x: Error) => setErr(x.message))} />
          </label>
        )}
        {Speech && <button className="ghost" aria-label="Dictate" onClick={dictate}>{listening ? "Stop" : "Voice"}</button>}
        <textarea rows={3} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="m-primary" disabled={busy || !text.trim()} onClick={send}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function AgentView({ repo }: { repo: string }) {
  const [hist, setHist] = useState<AgentMsg[]>(() => JSON.parse(localStorage.getItem(`agent.${repo}`) ?? "[]") as AgentMsg[]);
  const save = (h: AgentMsg[]) => (setHist(h), localStorage.setItem(`agent.${repo}`, JSON.stringify(h)));
  const text = (m: AgentMsg) =>
    typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? String(c.text) : c.type === "tool_use" ? `▸ ${String(c.name)} ${JSON.stringify(c.input).slice(0, 120)}` : "")).filter(Boolean).join(String.fromCharCode(10));
  return (
    <div className="chat m-chat">
      <div className="messages">
        {hist.map((m, i) => (text(m) ? <div key={i} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>{text(m)}</div> : null))}
        {!hist.length && <p className="m-muted m-pad">Ask about {repo}. The AI reads its files and writes only to the phone-work branch.</p>}
      </div>
      <Composer
        photos={false}
        placeholder="Ask the AI"
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

// Pick who gets the work, pick the project, type it. Only the targets the desk set up are offered.
function SendView({ projects, send }: { projects: Project[]; send: (repo: string, msg: Out) => Promise<void> }) {
  const targets: Array<[Target, string]> = [["desk", "Desk"], ...(hasCloud() ? [["cloud", "Cloud agents"] as [Target, string]] : []), ...(credential.get() ? [["ai", "AI"] as [Target, string]] : [])];
  const [to, setTo] = useState<Target>((localStorage.getItem("phone.to") as Target) ?? "desk");
  const [repo, setRepo] = useState(localStorage.getItem("phone.agentRepo") ?? "");
  const [sent, setSent] = useState("");
  const target = targets.some(([t]) => t === to) ? to : "desk";
  const project = projects.find((p) => p.repo === repo);
  return (
    <main className="m-list m-send">
      {targets.length > 1 && (
        <div className="m-seg" role="tablist">
          {targets.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={t === target} className={t === target ? "on" : ""} onClick={() => (setTo(t), localStorage.setItem("phone.to", t), setSent(""))}>
              {label}
            </button>
          ))}
        </div>
      )}
      <select className="m-search" value={repo} onChange={(e) => (setRepo(e.target.value), localStorage.setItem("phone.agentRepo", e.target.value))}>
        <option value="">{target === "cloud" ? "No project" : "Choose a project"}</option>
        {projects.map((p) => <option key={p.repo} value={p.repo}>{p.name}</option>)}
      </select>
      {target === "ai" ? (
        project ? <AgentView key={repo} repo={repo} /> : <p className="m-muted m-pad">Pick a project to ask the AI about.</p>
      ) : (
        <>
          {sent && <p className="m-muted m-pad">{sent}</p>}
          {(target === "cloud" || project) && (
            <Composer
              photos={target === "desk"}
              placeholder={target === "desk" ? "What should the desk do?" : "What should a cloud agent do?"}
              onSend={async (text, image) => {
                if (target === "desk") {
                  await send(repo, { text, image });
                  setSent("Sent. The desk starts it on its next sync; it shows up in the Inbox.");
                } else {
                  await startCloudJob(text, repo || undefined);
                  setSent("Sent to the cloud agents.");
                }
              }}
            />
          )}
          {target === "cloud" && <CloudJobs />}
          {!project && target === "desk" && <p className="m-muted m-pad">{projects.length ? "Pick a project to send work to the desk." : "No projects yet. Scan the code on your desk (Settings → Sync → Phone)."}</p>}
        </>
      )}
    </main>
  );
}

function SettingsView({ projects, onSignOut, onPair }: { projects: Record<string, Project>; onSignOut: () => void; onPair: () => void }) {
  const [, setSaved] = useState(false); // redraws after the browser's permission prompt
  const [notify, setNotify] = useState(false);
  useEffect(() => void (native && DeskWatch.status().then((s) => setNotify(s.enabled), () => {})), []);
  // Last time each desk wrote a job, from the jobs the projects already carry.
  const desks = new Map<string, number>();
  for (const p of Object.values(projects)) for (const j of p.jobs) desks.set(j.host, Math.max(desks.get(j.host) ?? 0, j.at));
  return (
    <main className="m-list m-pad m-settings">
      <h2>Setup</h2>
      <p className="m-muted">
        Set by your desk: {Object.keys(projects).length} projects · AI {credential.get() ? "on" : "off"} · cloud agents {hasCloud() ? "on" : "off"}. Change them on the desk, then scan its code again.
      </p>
      <button className="m-primary" onClick={onPair}>Scan the desk's code again</button>
      <h2>Notifications</h2>
      {native ? (
        <>
          <p className="m-muted">While the app is closed it checks the desk about every 15 minutes and alerts you to new prompts and finished chats. Battery saver can delay the checks.</p>
          <button className="ghost" onClick={() => void DeskWatch.ask().then(() => setTimeout(() => void DeskWatch.status().then((s) => setNotify(s.enabled)), 4000))}>
            {notify ? "Notifications on" : "Turn on notifications"}
          </button>
        </>
      ) : (
        <>
          <p className="m-muted">Alerts appear while this page is open.</p>
          <button className="ghost" onClick={() => typeof Notification !== "undefined" && void Notification.requestPermission().then(() => setSaved((v) => !v))}>
            {typeof Notification === "undefined" ? "Not supported here" : Notification.permission === "granted" ? "Notifications on" : "Turn on notifications"}
          </button>
        </>
      )}
      <h2>Account</h2>
      <p className="m-muted">Signed in as {session.login() || "GitHub"}.</p>
      <button className="ghost" onClick={onSignOut}>Sign out</button>
      <h2>Desks</h2>
      {desks.size === 0 && <p className="m-muted">No desk has run a job yet.</p>}
      {[...desks].map(([h, at]) => <p key={h} className="m-muted">{h} · last seen {when(at)}</p>)}
      <h2>About</h2>
      <p className="m-muted">AgenticOps Remote. Saved-login prompts must be answered at the desk.</p>
    </main>
  );
}

// One card per desk prompt. Questions are picked like the desk's own card (src/App.tsx): multi-select joins labels with ", ".
function ApprovalCard({ project, a, title, act }: { project: Project; a: Approval; title: string; act: Act }) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const qs = a.questions ?? [];
  const ready = qs.every((q) => picks[q.question]?.trim());
  const plan = a.tool === "ExitPlanMode";
  const choose = (q: (typeof qs)[number], label: string) =>
    setPicks((cur) => {
      if (!q.multiSelect) return { ...cur, [q.question]: label };
      const on = new Set((cur[q.question] ?? "").split(", ").filter(Boolean));
      if (!on.delete(label)) on.add(label);
      return { ...cur, [q.question]: [...on].join(", ") };
    });
  return (
    <div className="m-row m-approval">
      <div className="m-row-title">{plan ? "Plan ready for approval" : a.summary}</div>
      <div className="m-muted">{title} · on {a.host}</div>
      {a.detail && (plan ? <div className="m-plan"><ChatMarkdown text={a.detail} /></div> : <pre className="m-file">{a.detail}</pre>)}
      {qs.map((q) => (
        <div key={q.question} className="m-question">
          <strong>{q.header ? `${q.header}: ` : ""}{q.question}</strong>
          {q.options.map((o) => (
            <button key={o.label} className={`m-option${(picks[q.question] ?? "").split(", ").includes(o.label) ? " on" : ""}`} aria-pressed={(picks[q.question] ?? "").split(", ").includes(o.label)} onClick={() => choose(q, o.label)}>
              {o.label}
              {o.description && <small>{o.description}</small>}
            </button>
          ))}
        </div>
      ))}
      <div className="m-composer-row">
        <button className="ghost" onClick={() => act(project, a, false)}>{plan ? "Keep planning" : "Deny"}</button>
        <button className="m-primary" disabled={!ready} onClick={() => act(project, a, true, qs.length ? picks : undefined)}>
          {plan ? "Approve plan" : qs.length ? "Answer" : "Allow"}
        </button>
      </div>
    </div>
  );
}

function ApprovalCards({ list, title, act }: { list: Array<{ project: Project; a: Approval }>; title: (chat: string, p: Project) => string; act: Act }) {
  return <>{list.map(({ project, a }) => <ApprovalCard key={a.request} project={project} a={a} title={title(a.chat, project)} act={act} />)}</>;
}

function InboxView({ projects, pending, open, act }: { projects: Record<string, Project>; pending: Pending[]; open: (repo: string, chat: string) => void; act: Act }) {
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
      {pending.length > 0 && <h2 className="m-sec">Sent, waiting for the desk</h2>}
      {pending.map((p) => (
        <div key={p.id} className="m-row m-pending">
          <div className="m-row-title">{p.text.slice(0, 80)}</div>
          <div className="m-muted">{projects[p.repo]?.name ?? p.repo} · sent {when(p.at)}</div>
        </div>
      ))}
      {running.length > 0 && <h2 className="m-sec">Running</h2>}
      {running.map((x) => row(x, `on ${x.run!.host}`))}
      <h2 className="m-sec">Finished</h2>
      {done.map((x) => row(x, when(x.end)))}
      {!running.length && !done.length && <p className="m-muted m-pad">Nothing has run yet. Use Send to give the desk some work.</p>}
    </main>
  );
}

function ChatView({ project, chat, pending, send, refresh, act, stop }: { project: Project; chat: Chat; pending: Pending[]; send: (text: string, image?: string) => Promise<void>; refresh: () => void; act: Act; stop: () => void }) {
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
      <Composer placeholder="Message the agent on your desk" onSend={send} />
    </div>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(!!session.token());
  const [projects, setProjects] = useState<Record<string, Project>>(cache.get);
  const [pending, setPending] = useState<Pending[]>(cache.pending);
  const [stack, setStack] = useState<Screen[]>([{ kind: "home" }]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("inbox");
  const [pairing, setPairing] = useState(false);
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
        if (native) void DeskWatch.setup({ token: session.token(), repos: Object.keys(next).join(" ") }).catch(() => {});
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
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 2 * 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!signedIn) return <SignIn done={() => setSignedIn(true)} />;
  if (pairing) return <SignIn done={() => (setPairing(false), refresh())} cancel={() => setPairing(false)} />;

  const send = async (repo: string, msg: Out) => {
    const p = projects[repo];
    // Sent to the computer that last ran this chat (or this project), so two desks don't both run it.
    const host = (msg.chat ? p?.jobs.find((j) => j.chat === msg.chat) : p?.jobs[0])?.host;
    const id = await sendMessage(repo, { ...msg, host });
    if (!msg.text) return; // an answer or a stop has nothing to wait for in the thread
    const next = [...cache.pending(), { id, repo, chat: msg.chat, text: msg.image ? `${msg.text} (photo)` : msg.text, at: Date.now() }];
    cache.setPending(next);
    setPending(next);
  };
  const act: Act = (p, a, allow, answers) => {
    answered.add(a.request);
    setPending((v) => [...v]); // redraw without the card
    send(p.repo, { chat: a.chat, approve: { request: a.request, allow, ...(answers ? { answers } : {}) } }).catch((e: Error) => setErr(e.message));
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
    secret.clear(); // the API key and cloud token too, as localStorage.clear() did before the vault
    localStorage.clear();
    if (native) void DeskWatch.stop().catch(() => {});
    setProjects({});
    setPending([]);
    setSignedIn(false);
  };


  if (screen.kind === "chat") {
    const project = projects[screen.repo];
    const chat = project?.chats.find((c) => c.id === screen.chatId);
    if (!project || !chat) return <Header title="Chat not found" back={back} />;
    return (
      <div className="m-screen">
        <Header title={chat.title || "Untitled chat"} back={back}>
          {reload}
        </Header>
        {errorLine}
        <ChatView project={project} chat={chat} pending={pending.filter((p) => p.chat === chat.id)} send={(text, image) => send(project.repo, { chat: chat.id, text, image })} refresh={refresh} act={act} stop={() => send(project.repo, { chat: chat.id, stop: true }).catch((e: Error) => setErr(e.message))} />
      </div>
    );
  }

  const badge = Object.values(projects).reduce((n, p) => n + p.approvals.filter((a) => !answered.get().includes(a.request)).length, 0);
  const list = Object.values(projects).sort((a, b) => (b.chats[0] ? Math.max(...b.chats.map((c) => c.updatedAt)) : 0) - (a.chats[0] ? Math.max(...a.chats.map((c) => c.updatedAt)) : 0));
  return (
    <div className="m-screen">
      <Header title={{ inbox: "Inbox", send: "Send work", settings: "Settings" }[tab]}>{reload}</Header>
      {errorLine}
      {tab === "inbox" && <InboxView projects={projects} pending={pending.filter((p) => !p.chat)} open={(repo, chatId) => go({ kind: "chat", repo, chatId })} act={act} />}
      {tab === "send" && <SendView projects={list} send={send} />}
      {tab === "settings" && <SettingsView projects={projects} onSignOut={signOut} onPair={() => setPairing(true)} />}
      <nav className="m-tabs">
        {(["inbox", "send", "settings"] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            {{ inbox: "Inbox", send: "Send", settings: "Settings" }[t]}
            {t === "inbox" && badge > 0 ? ` (${badge})` : ""}
          </button>
        ))}
      </nav>
    </div>
  );
}

void loadSecrets().then(() => createRoot(document.getElementById("root")!).render(<App />));
