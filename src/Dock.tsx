import { useEffect, useRef, useState } from "react";

export type DockTab = "terminal" | "git" | "preview" | "notes";

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
  if (tab === "preview") return <Preview url={previewUrl} onUrl={onPreviewUrl} />;
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
    void window.desk.openShell(workspace).then((id) => {
      if (alive) idRef.current = id;
    });
    const off = window.desk.onShellData((payload) => {
      if (payload.cwd !== workspace.toLowerCase() && payload.cwd !== idRef.current) return;
      setText((cur) => (cur + payload.chunk).slice(-20_000));
    });
    return () => {
      alive = false;
      off();
    };
  }, [workspace]);

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
      </form>
    </div>
  );
}

function GitPanel({ workspace, onStatus }: { workspace: string; onStatus: (text: string) => void }) {
  const [info, setInfo] = useState<{ branch: string; lines: string; diff: string } | null>(null);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [out, setOut] = useState("");

  const refresh = () => {
    if (!workspace) return;
    void window.desk.gitStatus(workspace).then((s) => setInfo(s));
  };
  useEffect(() => {
    refresh();
  }, [workspace]);

  return (
    <div className="dock-body git-panel">
      <div className="dock-row">
        <strong>{info?.branch || "Git"}</strong>
        <button type="button" className="ghost" onClick={refresh}>
          Refresh
        </button>
      </div>
      <pre className="term-out small">{info ? `${info.lines}\n\n${info.diff}` : "Reading git status…"}</pre>
      <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
      <div className="dock-row">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.desk.gitCommit(workspace, message).then((r) => {
              setOut(r.output);
              onStatus(r.ok ? "Committed" : "Commit did not finish");
              setMessage("");
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

function Preview({ url, onUrl }: { url: string; onUrl: (url: string) => void }) {
  const [draft, setDraft] = useState(url);
  return (
    <div className="dock-body preview-pane">
      <form
        className="term-line"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (!next) return;
          onUrl(/^https?:\/\//i.test(next) ? next : `http://${next}`);
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="http://localhost:5173" spellCheck={false} />
        <button className="btn" type="submit">
          Open
        </button>
      </form>
      {url ? <iframe className="preview-frame" title="Preview" src={url} /> : <p className="settings-hint">Enter a page address to preview it here.</p>}
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
        placeholder={name === ".mcp.json" ? '{ "mcpServers": { } }' : "Project instructions for Claude"}
        spellCheck={false}
      />
    </div>
  );
}
