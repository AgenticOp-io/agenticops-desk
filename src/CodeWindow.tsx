import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { SourceControl } from "./SourceControl";
import { Explorer } from "./Explorer";
import type { DiffView } from "./CodePane";

const CodePane = lazy(() => import("./CodePane").then((m) => ({ default: m.CodePane })));

type Tab = { path: string; name: string; contents: string; dirty: boolean };
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// The separate coding window (?code=1): file tree and editor only. Chats stay in the main window.
export function CodeWindow() {
  const [workspace, setWorkspace] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // From the main window: reply code blocks, the diff under review, files the agent changed.
  const [shared, setShared] = useState<{ diff: DiffView | null; changed: string[] }>({ diff: null, changed: [] });
  const [side, setSide] = useState<"files" | "git">("files");
  // A git diff opened from Source Control; it shows over the agent's diff until closed.
  const [gitDiff, setGitDiff] = useState<DiffView | null>(null);
  const [gitKey, setGitKey] = useState(0);
  const [roots, setRoots] = useState<{ name: string; path: string; isDir: boolean }[]>([]);
  useEffect(() => {
    if (workspace) void window.desk.listDir(workspace).then(setRoots).catch(() => setRoots([]));
  }, [workspace, gitKey]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const load = async () => {
      const ws = await window.desk.getWorkspace();
      // A different folder: the old tabs belong to the old project.
      setWorkspace((old) => { if (old && old !== ws) { setTabs([]); setActive(null); } return ws; });
      setGitKey((n) => n + 1);
      // Files the agent just changed: reload tabs with no unsaved edits.
      for (const t of tabsRef.current) {
        if (t.dirty) continue;
        const text = await window.desk.readFile(t.path).catch(() => null);
        if (text !== null) setTabs((all) => all.map((x) => (x.path === t.path && !x.dirty ? { ...x, contents: text } : x)));
      }
    };
    void load();
    return window.desk.onWorkspaceChanged?.(() => void load());
  }, []);

  useEffect(() => {
    void window.desk.codeTake().then((p) => p && void open(p));
    return window.desk.onCodeFile((p) => void open(p));
  }, []);

  useEffect(() => {
    const take = (s: unknown) => s && setShared(s as typeof shared);
    void window.desk.codeState().then(take);
    return window.desk.onCodeState(take);
  }, []);

  useEffect(() => {
    document.title = workspace ? `Code: ${baseName(workspace)}` : "Code";
  }, [workspace]);

  const open = async (p: string) => {
    if (!tabsRef.current.some((t) => t.path === p)) {
      const contents = await window.desk.readFile(p);
      setTabs((all) => [...all.filter((t) => t.path !== p), { path: p, name: baseName(p), contents, dirty: false }]);
    }
    setActive(p);
  };

  const save = async (p: string) => {
    const tab = tabsRef.current.find((t) => t.path === p);
    if (!tab) return;
    await window.desk.writeFile(p, tab.contents);
    setTabs((all) => all.map((t) => (t.path === p && t.contents === tab.contents ? { ...t, dirty: false } : t)));
  };

  const close = (p: string) => {
    const tab = tabsRef.current.find((t) => t.path === p);
    if (tab?.dirty && !window.confirm(`${tab.name} has unsaved changes. Close it anyway?`)) return;
    const next = tabsRef.current.filter((t) => t.path !== p);
    setTabs(next);
    if (active === p) setActive(next.at(-1)?.path ?? null);
  };

  // Stage or Discard from the git diff bar. Paths there are absolute; git wants them from the repo root.
  const gitAct = async (kind: "stage" | "discard", p: string) => {
    const info = await window.desk.gitChanges(workspace);
    const root = (info.root ?? "").replace(/\\/g, "/").toLowerCase();
    const relPath = p.replace(/\\/g, "/").slice(root.length + 1);
    const f = info.files?.find((x) => x.path === relPath);
    if (!f || !root || !p.replace(/\\/g, "/").toLowerCase().startsWith(`${root}/`)) return setGitDiff(null);
    if (kind === "discard" && !window.confirm(`Discard changes to ${relPath}? This cannot be undone.`)) return;
    const r = kind === "stage" ? await window.desk.gitStage(workspace, [relPath]) : await window.desk.gitDiscard(workspace, [relPath], f.unstaged === "?");
    if (!r.ok) window.alert(r.output);
    setGitDiff(null);
    setGitKey((n) => n + 1);
  };

  return (
    <div className="workspace ide code-window">
      <aside className="sidebar">
        <div className="side-panel">
          <button className="btn" title={workspace} onClick={() => void window.desk.openFolder().then((d) => d && setWorkspace(d))}>
            {workspace ? baseName(workspace) : "Open folder…"}
          </button>
          <div className="side-tabs">
            <button type="button" className={side === "files" ? "btn primary" : "btn"} onClick={() => setSide("files")}>Files</button>
            <button type="button" className={side === "git" ? "btn primary" : "btn"} onClick={() => setSide("git")}>Source control</button>
          </div>
          {side === "git" ? (
            <SourceControl workspace={workspace} refreshKey={gitKey} activeFile={active} onDiff={setGitDiff} onOpen={(p) => { setGitDiff(null); void open(p); }} />
          ) : (
          <Explorer
            root={workspace}
            roots={roots}
            active={active}
            changed={shared.changed}
            refreshKey={gitKey}
            onRefresh={() => setGitKey((n) => n + 1)}
            onOpen={(p) => { setGitDiff(null); void open(p); }}
            onMention={() => {}}
            onMoved={(from, to) => {
              const f = from.toLowerCase();
              const under = (p: string) => p.toLowerCase() === f || p.toLowerCase().startsWith(f + "\\") || p.toLowerCase().startsWith(f + "/");
              if (to === null) setTabs((all) => all.filter((t) => !under(t.path)));
              else {
                const re = (p: string) => (under(p) ? to + p.slice(from.length) : p);
                setTabs((all) => all.map((t) => (under(t.path) ? { ...t, path: re(t.path), name: baseName(re(t.path)) } : t)));
                setActive((a) => (a ? re(a) : a));
              }
            }}
          />
          )}
        </div>
      </aside>
      <section className="agent with-code">
        <Suspense fallback={<div className="editor-wait">Opening the editor…</div>}>
          <CodePane
            files={tabs}
            activePath={active}
            workspace={workspace}
            diff={gitDiff ?? shared.diff}
            onDiffKeep={(p) => (gitDiff ? gitAct("stage", p) : window.desk.codeAct({ kind: "keep", path: p }))}
            onDiffUndo={(p) => (gitDiff ? gitAct("discard", p) : window.desk.codeAct({ kind: "undo", path: p }))}
            onDiffClose={() => (gitDiff ? setGitDiff(null) : window.desk.codeAct({ kind: "closeDiff" }))}
            onSelectFile={(p) => { setActive(p); setGitDiff(null); if (shared.diff) window.desk.codeAct({ kind: "closeDiff" }); }}
            onCloseFile={close}
            onChangeFile={(p, contents) => setTabs((all) => all.map((t) => (t.path === p ? { ...t, contents, dirty: true } : t)))}
            onSaveFile={(p) => void save(p)}
            onHide={() => window.close()}
          />
        </Suspense>
      </section>
    </div>
  );
}
