import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { copyText } from "./codeBlocks";

type Entry = { name: string; path: string; isDir: boolean };
type Editing = { kind: "file" | "folder"; parent: string } | { kind: "rename"; path: string; name: string };
// win is the window the menu opened in (the main one or a popped-out Files window).
type Menu = { x: number; y: number; entry: Entry | null; win: Window };

const sep = (p: string) => (p.includes("/") && !p.includes("\\") ? "/" : "\\");
const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${sep(dir)}${name}`;
const parentOf = (p: string) => p.replace(/[\\/][^\\/]+$/, "");
const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

const ICONS: Record<string, string> = {
  newFile: "M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9.5 1.5ZM9 2v3.5h3.5M8 7.5v5M5.5 10h5",
  newFolder: "M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9ZM8 6.5v5M5.5 9h5",
  refresh: "M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3.5H10",
  collapse: "M3 5.5 8 1.5l5 4M3 10.5l5 4 5-4",
  folder: "M2.2 4.4h4l1.2 1.3h6.4v6.8H2.2Z",
  folderOpen: "M2.2 6.2h11.6v6.2H2.2ZM2.2 6.2 3.6 4.2h3.2l1.1 1.2",
  page: "M4.2 2.2h5L12 4.8v8.8H4.2ZM9 2.4v2.8h2.6",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="tree-input"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(v.trim() || null)}
    />
  );
}

function Node({
  entry,
  depth,
  ctx,
}: {
  entry: Entry;
  depth: number;
  ctx: {
    active: string | null;
    changed: Set<string>;
    refreshKey: number;
    openDirs: Set<string>;
    toggleDir: (p: string, open?: boolean) => void;
    editing: Editing | null;
    finishEdit: (name: string | null) => void;
    onOpen: (p: string) => void;
    onMenu: (e: ReactMouseEvent, entry: Entry) => void;
  };
}) {
  const open = entry.isDir && ctx.openDirs.has(norm(entry.path));
  const [kids, setKids] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (!open) return;
    void window.desk.listDir(entry.path).then(setKids).catch(() => setKids([]));
  }, [open, entry.path, ctx.refreshKey]);
  const renaming = ctx.editing?.kind === "rename" && norm(ctx.editing.path) === norm(entry.path);
  const creating = ctx.editing && ctx.editing.kind !== "rename" && norm(ctx.editing.parent) === norm(entry.path);
  const changed = !entry.isDir && ctx.changed.has(norm(entry.path));
  return (
    <>
      <div
        className={`tree-item ${ctx.active && norm(ctx.active) === norm(entry.path) ? "active" : ""} ${changed ? "changed" : ""}`}
        style={{ ["--depth" as string]: depth }}
        title={entry.path}
        onClick={() => (entry.isDir ? ctx.toggleDir(entry.path) : ctx.onOpen(entry.path))}
        onContextMenu={(e) => ctx.onMenu(e, entry)}
      >
        <span className="tree-icon">
          <Icon name={entry.isDir ? (open ? "folderOpen" : "folder") : "page"} />
        </span>
        {renaming ? <NameInput initial={entry.name} onDone={ctx.finishEdit} /> : <span className="tree-name">{entry.name}</span>}
        {changed && <span className="tree-badge" title="Changed by the agent">M</span>}
      </div>
      {open && creating && (
        <div className="tree-item" style={{ ["--depth" as string]: depth + 1 }}>
          <span className="tree-icon">
            <Icon name={ctx.editing?.kind === "folder" ? "folder" : "page"} />
          </span>
          <NameInput initial="" onDone={ctx.finishEdit} />
        </div>
      )}
      {open && kids?.map((k) => <Node key={k.path} entry={k} depth={depth + 1} ctx={ctx} />)}
    </>
  );
}

// Cursor-style explorer: the project's files, with create / rename / delete and markers on files Claude changed.
export function Explorer({
  root,
  roots,
  active,
  changed,
  refreshKey,
  onRefresh,
  onOpen,
  onMention,
  onMoved,
}: {
  root: string;
  roots: Entry[];
  active: string | null;
  changed: string[];
  refreshKey: number;
  onRefresh: () => void;
  onOpen: (p: string) => void;
  onMention: (p: string) => void;
  // A file or folder was renamed (to) or deleted (to = null), so open tabs can follow.
  onMoved: (from: string, to: string | null) => void;
}) {
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const w = menu.win;
    w.addEventListener("click", close);
    w.addEventListener("blur", close);
    return () => {
      w.removeEventListener("click", close);
      w.removeEventListener("blur", close);
    };
  }, [menu]);

  const toggleDir = (p: string, force?: boolean) =>
    setOpenDirs((cur) => {
      const next = new Set(cur);
      const k = norm(p);
      if (force ?? !next.has(k)) next.add(k);
      else next.delete(k);
      return next;
    });

  const startCreate = (kind: "file" | "folder", entry: Entry | null) => {
    const parent = entry ? (entry.isDir ? entry.path : parentOf(entry.path)) : root;
    if (norm(parent) !== norm(root)) toggleDir(parent, true);
    setEditing({ kind, parent });
  };

  const finishEdit = async (name: string | null) => {
    const cur = editing;
    setEditing(null);
    if (!cur || !name) return;
    // New files may include sub-folders ("src/util.ts"); a rename stays in its folder.
    if (/[:*?"<>|]/.test(name) || (cur.kind === "rename" && /[\\/]/.test(name))) {
      setError(`"${name}" is not a valid name.`);
      return;
    }
    try {
      if (cur.kind === "rename") {
        if (name === cur.name) return;
        const to = join(parentOf(cur.path), name);
        await window.desk.renamePath(cur.path, to);
        onMoved(cur.path, to);
      } else {
        const target = join(cur.parent, name);
        await window.desk.createPath(target, cur.kind === "folder");
        if (cur.kind === "file") onOpen(target);
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    }
    onRefresh();
  };

  const remove = async (entry: Entry) => {
    if (!window.confirm(`Delete ${entry.name}${entry.isDir ? " and everything in it" : ""}? It goes to the Recycle Bin.`)) return;
    try {
      await window.desk.deletePath(entry.path);
      onMoved(entry.path, null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    onRefresh();
  };

  const ctx = {
    active,
    changed: new Set(changed.map(norm)),
    refreshKey,
    openDirs,
    toggleDir,
    editing,
    finishEdit: (n: string | null) => void finishEdit(n),
    onOpen,
    onMenu: (e: ReactMouseEvent, entry: Entry | null) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, entry, win: (e.currentTarget as Element).ownerDocument.defaultView ?? window });
    },
  };
  const creatingAtRoot = editing && editing.kind !== "rename" && norm(editing.parent) === norm(root);

  return (
    <div className="explorer">
      <div className="explorer-head">
        <span className="explorer-title" title={root}>
          {root.split(/[\\/]/).pop() || "No folder"}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn" title="New file" onClick={() => startCreate("file", null)}>
          <Icon name="newFile" />
        </button>
        <button type="button" className="icon-btn" title="New folder" onClick={() => startCreate("folder", null)}>
          <Icon name="newFolder" />
        </button>
        <button type="button" className="icon-btn" title="Refresh" onClick={onRefresh}>
          <Icon name="refresh" />
        </button>
        <button type="button" className="icon-btn" title="Collapse all" onClick={() => setOpenDirs(new Set())}>
          <Icon name="collapse" />
        </button>
      </div>
      {error && (
        <div className="explorer-error" onClick={() => setError("")}>
          {error}
        </div>
      )}
      <div className="explorer-tree" onContextMenu={(e) => ctx.onMenu(e, null)}>
        {creatingAtRoot && (
          <div className="tree-item" style={{ ["--depth" as string]: 0 }}>
            <span className={`tree-icon ${editing?.kind === "folder" ? "dir" : "file"}`} />
            <NameInput initial="" onDone={ctx.finishEdit} />
          </div>
        )}
        {roots.map((e) => (
          <Node key={e.path} entry={e} depth={0} ctx={ctx} />
        ))}
        {!roots.length && <div className="explorer-empty">This folder is empty.</div>}
      </div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { startCreate("file", menu.entry); setMenu(null); }}>New file</button>
          <button onClick={() => { startCreate("folder", menu.entry); setMenu(null); }}>New folder</button>
          {menu.entry && (
            <>
              <div className="ctx-sep" />
              {!menu.entry.isDir && (
                <button onClick={() => { onMention(menu.entry!.path); setMenu(null); }}>Add to chat</button>
              )}
              <button
                onClick={() => {
                  setEditing({ kind: "rename", path: menu.entry!.path, name: menu.entry!.name });
                  setMenu(null);
                }}
              >
                Rename
              </button>
              <button onClick={() => { void copyText(menu.entry!.path); setMenu(null); }}>Copy path</button>
              <button onClick={() => { void window.desk.revealInFolder(menu.entry!.path); setMenu(null); }}>
                Reveal in File Explorer
              </button>
              <div className="ctx-sep" />
              <button className="danger-text" onClick={() => { const e = menu.entry!; setMenu(null); void remove(e); }}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
