import { useState } from "react";

// Files Claude edited in this chat that the user has not reviewed yet, like Cursor's "N files changed" strip.
export function ChangesBar({
  files,
  workspace,
  reviewing,
  onReview,
  onKeep,
  onUndo,
}: {
  files: string[];
  workspace: string;
  reviewing: string | null;
  onReview: (path: string) => void;
  onKeep: (paths?: string[]) => void;
  onUndo: (paths?: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!files.length) return null;
  const rel = (p: string) =>
    workspace && p.toLowerCase().startsWith(workspace.toLowerCase())
      ? p.slice(workspace.length).replace(/^[\\/]+/, "")
      : p;
  return (
    <div className="changes-bar">
      <div className="changes-head">
        <button type="button" className="changes-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} Claude changed {files.length} file{files.length === 1 ? "" : "s"}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="ghost danger-text"
          onClick={() => {
            if (window.confirm(`Undo Claude's changes to ${files.length} file${files.length === 1 ? "" : "s"}?`)) onUndo();
          }}
        >
          Undo all
        </button>
        <button type="button" className="ghost" onClick={() => onKeep()}>
          Keep all
        </button>
      </div>
      {open && (
        <div className="changes-list">
          {files.map((f) => (
            <div key={f} className={`changes-row ${reviewing === f ? "active" : ""}`}>
              <button type="button" className="changes-file" title={f} onClick={() => onReview(f)}>
                <span className="changes-name">{f.split(/[\\/]/).pop()}</span>
                <span className="changes-dir">{rel(f).split(/[\\/]/).slice(0, -1).join("/")}</span>
              </button>
              <button type="button" className="ghost" title="Undo this file" onClick={() => onUndo([f])}>
                Undo
              </button>
              <button type="button" className="ghost" title="Keep this file" onClick={() => onKeep([f])}>
                Keep
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
