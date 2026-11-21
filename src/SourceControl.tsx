import { useEffect, useState } from "react";
import type { DiffView } from "./CodePane";
import type { GitFile } from "../electron/pureFeatures";
import { webLink as link, type RemoteHost, type WebPage } from "../electron/gitHosts";

type Changes = Awaited<ReturnType<typeof window.desk.gitChanges>>;
type Branch = Awaited<ReturnType<typeof window.desk.gitBranches>>[number];
type Commit = Awaited<ReturnType<typeof window.desk.gitLog>>[number];
type Pr = Awaited<ReturnType<typeof window.desk.gitPrs>>["prs"][number];

const HOST: Record<RemoteHost["kind"], string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", azure: "Azure DevOps", other: "the web" };
const LETTER: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflict", "?": "Untracked", T: "Type changed" };

// A VS Code-style Source Control view: stage, unstage, discard, commit, branches, sync, history,
// plus pull requests and web links for GitHub, GitLab, Bitbucket and Azure DevOps.
export function SourceControl({
  workspace,
  refreshKey,
  activeFile,
  onDiff,
  onOpen,
}: {
  workspace: string;
  refreshKey: number;
  activeFile: string | null;
  onDiff: (d: DiffView) => void;
  onOpen: (path: string) => void;
}) {
  const [info, setInfo] = useState<Changes | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [log, setLog] = useState<Commit[]>([]);
  const [prs, setPrs] = useState<Pr[] | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState("");
  const [out, setOut] = useState("");
  const [clone, setClone] = useState("");
  const [repos, setRepos] = useState<{ nameWithOwner: string; url: string; description: string }[] | null>(null);

  const refresh = async () => {
    if (!workspace) return;
    const next = await window.desk.gitChanges(workspace).catch(() => null);
    setInfo(next);
    if (!next?.repo) return;
    setBranches(await window.desk.gitBranches(workspace).catch(() => []));
    setLog(await window.desk.gitLog(workspace).catch(() => []));
  };
  useEffect(() => {
    setPrs(null);
    void refresh();
  }, [workspace, refreshKey]);

  const act = async (label: string, work: () => Promise<{ ok: boolean; output: string }>) => {
    setBusy(label);
    const r = await work().catch((e: unknown) => ({ ok: false, output: String(e) }));
    setBusy("");
    setOut(r.ok ? "" : r.output || `${label} did not finish.`);
    await refresh();
    return r.ok;
  };

  const root = info?.root || workspace;
  const sep = workspace.includes("\\") ? "\\" : "/";
  const abs = (rel: string) => `${root.replace(/[\\/]+$/, "")}/${rel}`.replace(/[\\/]/g, sep);
  const rel = (p: string) => {
    const r = root.replace(/[\\/]/g, "/").replace(/\/+$/, "").toLowerCase();
    const f = p.replace(/[\\/]/g, "/");
    return f.toLowerCase().startsWith(`${r}/`) ? f.slice(r.length + 1) : null;
  };

  const showDiff = async (f: GitFile) => {
    const path = abs(f.path);
    const [before, after] = await Promise.all([
      f.staged === "A" || f.unstaged === "?" ? Promise.resolve("") : window.desk.gitShowHead(workspace, f.path),
      f.unstaged === "D" || f.staged === "D" ? Promise.resolve("") : window.desk.readFile(path).catch(() => ""),
    ]);
    onDiff({ path, before, after, created: !before, labels: { title: "Changes since the last commit", keep: "Stage", undo: "Discard" } });
  };

  const discard = (files: GitFile[]) => {
    if (!files.length) return;
    const names = files.length === 1 ? files[0].path : `${files.length} files`;
    if (!window.confirm(`Discard changes to ${names}? This cannot be undone.`)) return;
    const untracked = files.filter((f) => f.unstaged === "?").map((f) => f.path);
    const tracked = files.filter((f) => f.unstaged !== "?").map((f) => f.path);
    void act("Discard", async () => {
      const a = tracked.length ? await window.desk.gitDiscard(workspace, tracked, false) : { ok: true, output: "" };
      const b = untracked.length ? await window.desk.gitDiscard(workspace, untracked, true) : { ok: true, output: "" };
      return { ok: a.ok && b.ok, output: [a.output, b.output].filter(Boolean).join("\n") };
    });
  };

  const files = info?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => f.unstaged);
  const remote = info?.remote ?? null;
  const branch = info?.branch ?? "";

  const commit = () => {
    const all = staged.length === 0;
    if (all && !unstaged.length && !amend) return;
    void act("Commit", () => window.desk.gitCommitWith(workspace, message, { all, amend })).then((ok) => {
      if (ok) { setMessage(""); setAmend(false); }
    });
  };

  const sync = () =>
    void act("Sync", async () => {
      if (!info?.upstream) return window.desk.gitPublish(workspace);
      const pulled = info.behind ? await window.desk.gitPull(workspace) : { ok: true, output: "" };
      if (!pulled.ok) return pulled;
      return info.ahead || !info.behind ? window.desk.gitPush(workspace) : pulled;
    });

  const switchTo = (value: string) => {
    if (value === "+new") {
      const name = window.prompt("New branch name");
      if (name) void act("New branch", () => window.desk.gitNewBranch(workspace, name));
      return;
    }
    const b = branches.find((x) => x.name === value);
    // A remote branch: check out the local branch of the same name, which git sets to track it.
    const target = b?.remote ? value.replace(/^[^/]+\//, "") : value;
    void act("Checkout", () => window.desk.gitCheckout(workspace, target));
  };

  const web = (p: WebPage) => remote && void window.desk.openExternal(link(remote, p));
  const loadPrs = async () => {
    if (!remote) return;
    setBusy("Pull requests");
    const r = await window.desk.gitPrs(workspace, remote.kind);
    setBusy("");
    setPrs(r.prs);
    if (!r.ok) setOut(r.output);
  };

  if (!workspace) return <div className="scm"><p className="muted">Open a folder first.</p></div>;

  if (info && !info.repo) {
    return (
      <div className="scm">
        <p className="muted">This folder is not a git repository.</p>
        <CloneBox clone={clone} setClone={setClone} repos={repos} setRepos={setRepos} onDone={setOut} />
        {out && <pre className="term-out small">{out}</pre>}
      </div>
    );
  }

  const row = (f: GitFile, isStaged: boolean) => {
    const letter = isStaged ? f.staged : f.unstaged;
    const name = f.path.split("/").pop() ?? f.path;
    const dir = f.path.slice(0, -name.length).replace(/\/$/, "");
    return (
      <div key={`${isStaged}-${f.path}`} className="scm-file" title={`${f.path}${f.from ? ` (from ${f.from})` : ""}`} onClick={() => void showDiff(f)}>
        <span className="scm-name">{name}</span>
        <span className="scm-dir">{dir}</span>
        <span className="scm-actions" onClick={(e) => e.stopPropagation()}>
          {letter !== "D" && (
            <button type="button" className="ghost" title="Open file" onClick={() => onOpen(abs(f.path))}>⎘</button>
          )}
          {letter === "U" && (
            <>
              <button type="button" className="ghost" title="Keep my version (ours) and stage" onClick={() => void act("Resolve", () => window.desk.gitResolve(workspace, [f.path], "ours"))}>Mine</button>
              <button type="button" className="ghost" title="Take their version and stage" onClick={() => void act("Resolve", () => window.desk.gitResolve(workspace, [f.path], "theirs"))}>Theirs</button>
            </>
          )}
          {isStaged ? (
            <button type="button" className="ghost" title="Unstage" onClick={() => void act("Unstage", () => window.desk.gitUnstage(workspace, [f.path]))}>−</button>
          ) : (
            <>
              <button type="button" className="ghost" title="Discard changes" onClick={() => discard([f])}>↶</button>
              <button type="button" className="ghost" title="Stage" onClick={() => void act("Stage", () => window.desk.gitStage(workspace, [f.path]))}>+</button>
            </>
          )}
        </span>
        {/* Untracked shows as U and a conflict as !, as in VS Code. */}
        <span className={`scm-letter l-${letter === "?" ? "A" : letter === "U" ? "D" : letter}`} title={LETTER[letter] ?? letter}>{letter === "?" ? "U" : letter === "U" ? "!" : letter}</span>
      </div>
    );
  };

  const activeRel = activeFile ? rel(activeFile) : null;
  return (
    <div className="scm">
      <div className="scm-head">
        <select value={branch} onChange={(e) => switchTo(e.target.value)} title="Switch branch">
          {!branch && <option value="">(detached)</option>}
          {branches.filter((b) => !b.remote).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          {branches.some((b) => b.remote) && (
            <optgroup label="Remote">
              {branches.filter((b) => b.remote).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </optgroup>
          )}
          <option value="+new">+ New branch…</option>
        </select>
        <button type="button" className="btn" disabled={!!busy} onClick={sync} title={info?.upstream ? `Pull and push with ${info.upstream}` : "Publish this branch to origin"}>
          {info?.upstream ? `↓${info.behind ?? 0} ↑${info.ahead ?? 0}` : "Publish"}
        </button>
        <button type="button" className="ghost" disabled={!!busy} title="Fetch" onClick={() => void act("Fetch", () => window.desk.gitFetch(workspace))}>⟳</button>
      </div>
      {busy && <p className="muted">{busy}…</p>}

      <textarea
        value={message}
        rows={3}
        placeholder={`Message (Ctrl+Enter to commit on ${branch || "HEAD"})`}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit(); } }}
      />
      <div className="scm-row">
        <button type="button" className="btn primary" disabled={!!busy || (!message.trim() && !amend) || (!files.length && !amend)} onClick={commit}>
          {amend ? "Amend" : staged.length ? "Commit" : "Commit all"}
        </button>
        <label className="muted"><input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend</label>
      </div>

      {staged.length > 0 && (
        <section>
          <div className="scm-section">
            <span>Staged changes ({staged.length})</span>
            <button type="button" className="ghost" title="Unstage all" onClick={() => void act("Unstage", () => window.desk.gitUnstage(workspace, staged.map((f) => f.path)))}>−</button>
          </div>
          {staged.map((f) => row(f, true))}
        </section>
      )}
      <section>
        <div className="scm-section">
          <span>Changes ({unstaged.length})</span>
          {unstaged.length > 0 && (
            <span>
              <button type="button" className="ghost" title="Discard all" onClick={() => discard(unstaged)}>↶</button>
              <button type="button" className="ghost" title="Stage all" onClick={() => void act("Stage", () => window.desk.gitStage(workspace, unstaged.map((f) => f.path)))}>+</button>
            </span>
          )}
        </div>
        {unstaged.map((f) => row(f, false))}
        {!files.length && <p className="muted">No changes.</p>}
      </section>

      {remote && (
        <section>
          <div className="scm-section"><span>{HOST[remote.kind]} · {remote.name}</span></div>
          <div className="scm-row wrap">
            <button type="button" className="btn" onClick={() => web({ page: "repo" })}>Repository</button>
            {remote.kind !== "other" && (
              <>
                {branch && <button type="button" className="btn" onClick={() => web({ page: "branch", ref: branch })}>Branch</button>}
                {activeRel && <button type="button" className="btn" onClick={() => web({ page: "file", ref: branch || info?.head, file: activeRel })}>This file</button>}
                {branch && <button type="button" className="btn" disabled={!info?.upstream} title={info?.upstream ? "" : "Publish the branch first"} onClick={() => web({ page: "newPr", ref: branch })}>New pull request</button>}
                <button type="button" className="btn" onClick={() => web({ page: "prs" })}>All pull requests</button>
              </>
            )}
          </div>
          {(remote.kind === "github" || remote.kind === "gitlab" || remote.kind === "azure") && (
            prs === null ? (
              <button type="button" className="ghost" onClick={() => void loadPrs()}>Show open pull requests</button>
            ) : (
              <>
                {!prs.length && <p className="muted">No open pull requests.</p>}
                {prs.map((p) => (
                  <div key={p.number} className="scm-file" title={`${p.branch} by ${p.author}`} onClick={() => void window.desk.openExternal(p.url)}>
                    <span className="scm-name">#{p.number} {p.title}</span>
                    <span className="scm-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="ghost" title="Check out this pull request" onClick={() => void act("Checkout", () => window.desk.gitPrCheckout(workspace, remote.kind, p.number))}>Checkout</button>
                    </span>
                  </div>
                ))}
              </>
            )
          )}
        </section>
      )}

      {log.length > 0 && (
        <section>
          <div className="scm-section"><span>History</span></div>
          {log.map((c) => (
            <div
              key={c.sha}
              className="scm-file"
              title={`${c.sha}\n${c.author}, ${c.when}${c.refs ? `\n${c.refs}` : ""}`}
              onClick={() => remote && remote.kind !== "other" && web({ page: "commit", ref: c.sha })}
            >
              <span className="scm-name">{c.subject}</span>
              <span className="scm-dir">{c.short} · {c.when}</span>
            </div>
          ))}
        </section>
      )}

      <details>
        <summary className="muted">Clone another repository</summary>
        <CloneBox clone={clone} setClone={setClone} repos={repos} setRepos={setRepos} onDone={setOut} />
      </details>
      {out && <pre className="term-out small">{out}</pre>}
    </div>
  );
}

function CloneBox({
  clone,
  setClone,
  repos,
  setRepos,
  onDone,
}: {
  clone: string;
  setClone: (v: string) => void;
  repos: { nameWithOwner: string; url: string; description: string }[] | null;
  setRepos: (v: { nameWithOwner: string; url: string; description: string }[]) => void;
  onDone: (out: string) => void;
}) {
  const go = (url: string) => void window.desk.gitClone(url).then((r) => onDone(r.ok ? "" : r.output));
  return (
    <div className="scm-clone">
      <div className="scm-row">
        <input value={clone} onChange={(e) => setClone(e.target.value)} placeholder="https://… or git@…:owner/repo.git" spellCheck={false} />
        <button type="button" className="btn" disabled={!clone.trim()} onClick={() => go(clone.trim())}>Clone</button>
      </div>
      {repos === null ? (
        <button type="button" className="ghost" onClick={() => void window.desk.gitRepos().then(setRepos)}>List my GitHub repositories</button>
      ) : !repos.length ? (
        <p className="muted">None found. Sign in with the GitHub CLI (gh auth login) to list them.</p>
      ) : (
        repos.map((r) => (
          <div key={r.url} className="scm-file" title={r.description} onClick={() => go(`${r.url}.git`)}>
            <span className="scm-name">{r.nameWithOwner}</span>
          </div>
        ))
      )}
    </div>
  );
}
