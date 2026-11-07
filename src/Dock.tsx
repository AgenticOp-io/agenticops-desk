import { useEffect, useRef, useState } from "react";
import { Rules } from "./Extras";
import { localServerUrl } from "./preview";

export type DockTab = "terminal" | "git" | "preview" | "notes" | "rules";

export function Dock({
  tab,
  workspace,
  previewUrl,
  onPreviewUrl,
  onStatus,
}: {
  tab: DockTab;
  workspace: string;
  previewUrl: string;
  onPreviewUrl: (url: string) => void;
  onStatus: (text: string) => void;
}) {
  if (tab === "terminal") return <Terminal workspace={workspace} />;
  if (tab === "git") return <GitPanel workspace={workspace} onStatus={onStatus} />;
  if (tab === "preview") return <Preview url={previewUrl} onUrl={onPreviewUrl} workspace={workspace} />;
  if (tab === "rules") return <Rules workspace={workspace} onStatus={onStatus} />;
  return <Notes workspace={workspace} onStatus={onStatus} />;
}

function Terminal({ workspace }: { workspace: string }) {
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const idRef = useRef("");
  const bottom = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    idRef.current = "";
    setText("");
    // The shell keeps running while the tab is hidden; its saved output comes back with the id.
    void window.desk.openShell(workspace).then(({ id, backlog }) => {
      if (!alive) return;
      idRef.current = id;
      setText(backlog.slice(-20_000));
    });
    const off = window.desk.onShellData((payload) => {
      if (!idRef.current || payload.cwd !== idRef.current) return;
      setText((cur) => (cur + payload.chunk).slice(-20_000));
    });
    return () => {
      alive = false;
      off();
    };
  }, [workspace]);

  // There is no Ctrl+C over a pipe, so Restart is how to stop a dev server or a stuck command.
  const restart = () => {
    idRef.current = "";
    setText("");
    void window.desk.restartShell(workspace).then(({ id, backlog }) => {
      idRef.current = id;
      setText(backlog.slice(-20_000));
    });
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [text]);

  return (
    <div className="dock-body">
      <pre className="term-out">
        {text || "The shell is starting…"}
        <span ref={bottom} />
      </pre>
      <form
        className="term-line"
        onSubmit={(e) => {
          e.preventDefault();
          const cmd = line;
          if (!cmd.trim() || !idRef.current) return;
          setLine("");
          setText((cur) => `${cur}${cmd}\n`);
          void window.desk.writeShell(idRef.current, cmd);
        }}
      >
        <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Type a command and press Enter" spellCheck={false} />
        <button type="button" className="btn" title="Stop everything running here and start a fresh shell" onClick={restart}>
          Restart
        </button>
      </form>
    </div>
  );
}

function GitPanel({ workspace, onStatus }: { workspace: string; onStatus: (text: string) => void }) {
  const [info, setInfo] = useState<{ branch: string; lines: string; diff: string } | null>(null);
  const [history, setHistory] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [out, setOut] = useState("");

  const refresh = () => {
    if (!workspace) return;
    void window.desk.gitStatus(workspace).then((s) => setInfo(s));
    void window.desk.gitHistory(workspace).then((s) => setHistory(s.output));
  };
  useEffect(() => {
    refresh();
  }, [workspace]);

  const run = (label: string, work: Promise<{ ok: boolean; output: string }>) => {
    void work.then((result) => {
      setOut(result.output);
      onStatus(result.ok ? label : `${label} did not finish`);
      refresh();
    });
  };

  return (
    <div className="dock-body git-panel">
      <div className="dock-row">
        <strong>{info?.branch || "Git"}</strong>
        <button type="button" className="ghost" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="dock-row">
        <button type="button" className="btn" onClick={() => run("Fetched", window.desk.gitFetch(workspace))}>
          Fetch
        </button>
        <button type="button" className="btn" onClick={() => run("Pulled", window.desk.gitPull(workspace))}>
          Pull
        </button>
        <button type="button" className="btn" onClick={() => run("Pushed", window.desk.gitPush(workspace))}>
          Push
        </button>
      </div>
      <pre className="term-out small">{info ? `${info.lines}\n\n${info.diff}` : "Reading git status…"}</pre>
      {history && <pre className="term-out small">{history}</pre>}
      <div className="dock-row">
        <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch name" spellCheck={false} />
        <button type="button" className="btn" disabled={!branch.trim()} onClick={() => run("Checked out", window.desk.gitCheckout(workspace, branch))}>
          Checkout
        </button>
      </div>
      <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
      <div className="dock-row">
        <button
          type="button"
          className="btn"
          disabled={!message.trim()}
          onClick={() =>
            void window.desk.gitCommit(workspace, message).then((r) => {
              setOut(r.output);
              onStatus(r.ok ? "Committed" : "Commit did not finish");
              if (r.ok) setMessage("");
              refresh();
            })
          }
        >
          Commit
        </button>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pull request title" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Pull request description" rows={3} />
      <div className="dock-row">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.desk.gitPullRequest(workspace, title, body).then((r) => {
              setOut(r.output);
              onStatus(r.ok ? "Pull request created" : "Pull request did not finish");
            })
          }
        >
          Create pull request
        </button>
      </div>
      {out && <pre className="term-out small">{out}</pre>}
    </div>
  );
}

// The preview page must never be able to reach AgenticOps Desk itself: it is sandboxed without top-navigation,
// and AgenticOps Desk's own address is refused (same origin would let it lift the sandbox).
function previewable(url: string) {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function Preview({ url, onUrl, workspace }: { url: string; onUrl: (url: string) => void; workspace: string }) {
  const [draft, setDraft] = useState(url);
  const [error, setError] = useState("");
  const [command, setCommand] = useState<string | null>(null);
  const [shellId, setShellId] = useState("");

  useEffect(() => {
    let alive = true;
    setCommand(null);
    if (workspace) void window.desk.previewCommand(workspace).then((c) => alive && setCommand(c));
    return () => {
      alive = false;
    };
  }, [workspace]);

  // The dev server runs in the project's terminal shell, so its output is in Terminal and Restart there stops it.
  useEffect(() => {
    if (!shellId) return;
    let seen = "";
    const off = window.desk.onShellData((payload) => {
      if (payload.cwd !== shellId) return;
      seen = (seen + payload.chunk).slice(-8_000);
      const found = localServerUrl(seen);
      if (!found) return;
      setShellId("");
      setDraft(found);
      onUrl(found);
    });
    const giveUp = setTimeout(() => {
      setShellId("");
      setError("No local address appeared within two minutes. The Terminal tab shows what the server printed.");
    }, 120_000);
    return () => {
      off();
      clearTimeout(giveUp);
    };
  }, [shellId, onUrl]);

  const startServer = async () => {
    if (!command) return;
    setError("");
    const { id } = await window.desk.openShell(workspace);
    setShellId(id);
    await window.desk.writeShell(id, `${command}\n`);
  };

  return (
    <div className="dock-body preview-pane">
      <form
        className="term-line"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (!next) return;
          const full = /^https?:\/\//i.test(next) ? next : `http://${next}`;
          if (!previewable(full)) {
            setError("That address can't be previewed here. AgenticOps Desk's own page is blocked.");
            return;
          }
          setError("");
          onUrl(full);
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="http://localhost:5173" spellCheck={false} />
        <button className="btn" type="submit">
          Open
        </button>
        {command && (
          <button className="btn" type="button" disabled={Boolean(shellId)} title={`Runs ${command} in this project's terminal`} onClick={() => void startServer()}>
            {shellId ? "Starting…" : `Run ${command}`}
          </button>
        )}
      </form>
      {error && <p className="settings-hint">{error}</p>}
      {url && previewable(url) ? (
        <iframe
          className="preview-frame"
          title="Preview"
          src={url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="settings-hint">Enter a page address to preview it here.</p>
      )}
    </div>
  );
}

const DOC_NAMES = ["CLAUDE.md", "AGENTS.md", ".mcp.json"] as const;

function Notes({ workspace, onStatus }: { workspace: string; onStatus: (text: string) => void }) {
  const [name, setName] = useState<(typeof DOC_NAMES)[number]>("CLAUDE.md");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!workspace) return;
    void window.desk.readProjectDoc(workspace, name).then(setText);
  }, [workspace, name]);

  return (
    <div className="dock-body">
      <div className="dock-row">
        {DOC_NAMES.map((n) => (
          <button key={n} type="button" className={`pill ${n === name ? "on" : ""}`} onClick={() => setName(n)}>
            {n === ".mcp.json" ? "MCP servers" : n}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (name === ".mcp.json" && text.trim()) {
              try {
                JSON.parse(text);
              } catch {
                onStatus("MCP file is not valid JSON");
                return;
              }
            }
            void window.desk.writeProjectDoc(workspace, name, text).then(() => onStatus(`Saved ${name}`));
          }}
        >
          Save
        </button>
      </div>
      <textarea
        className="notes-edit"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={name === ".mcp.json" ? '{ "mcpServers": { } }' : "Project instructions for the agent"}
        spellCheck={false}
      />
    </div>
  );
}
