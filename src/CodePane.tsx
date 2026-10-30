import { useMemo, useRef } from "react";
import { copyText, type CodeSnippet } from "./codeBlocks";

type FileTab = { path: string; name: string; contents: string };

export function CodePane({
  files,
  activePath,
  snippets,
  snippetId,
  onSelectFile,
  onSelectSnippet,
  onCloseFile,
  onHide,
}: {
  files: FileTab[];
  activePath: string | null;
  snippets: CodeSnippet[];
  snippetId: string | null;
  onSelectFile: (path: string) => void;
  onSelectSnippet: (id: string) => void;
  onCloseFile: (path: string) => void;
  onHide: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const file = files.find((t) => t.path === activePath) ?? files[0] ?? null;
  const snippet = snippets.find((s) => s.id === snippetId) ?? null;
  const usingSnippet = snippetId != null && Boolean(snippet);
  const shownSnippet = usingSnippet ? snippet : !file ? snippets[0] : null;
  const body = shownSnippet?.code ?? file?.contents ?? "";
  const title = shownSnippet?.name ?? file?.name ?? "Code";

  const tabs = useMemo(
    () => [
      ...files.map((f) => ({ id: f.path, name: f.name, kind: "file" as const })),
      ...snippets.map((s) => ({ id: s.id, name: s.name, kind: "snippet" as const })),
    ],
    [files, snippets],
  );

  const copyAll = () => void copyText(body);
  const copySel = () => {
    const sel = window.getSelection()?.toString();
    void copyText(sel && sel.length ? sel : body);
  };

  return (
    <div className="code-pane">
      <div className="code-pane-head">
        <span className="code-pane-title">Code</span>
        <span className="grow" />
        <button className="ghost" onClick={() => void copySel()} disabled={!body} title="Copy selection or all">
          Copy
        </button>
        <button className="ghost" onClick={() => void copyAll()} disabled={!body}>
          Copy all
        </button>
        <button className="ghost" onClick={onHide}>
          Hide
        </button>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${
              t.kind === "file"
                ? !shownSnippet && t.id === file?.path
                  ? "active"
                  : ""
                : t.id === (shownSnippet?.id ?? "")
                  ? "active"
                  : ""
            }`}
            onClick={() => (t.kind === "file" ? onSelectFile(t.id) : onSelectSnippet(t.id))}
            title={t.id}
          >
            {t.name}
            {t.kind === "file" && (
              <span
                className="tab-x"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(t.id);
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
        {tabs.length === 0 && <span className="tab">No code yet</span>}
      </div>
      <pre
        ref={preRef}
        className="code-view"
        tabIndex={0}
        spellCheck={false}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            const sel = window.getSelection()?.toString();
            if (!sel) {
              e.preventDefault();
              void copyText(body);
            }
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(preRef.current!);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        }}
      >
        {body || `Select text in ${title}, then Copy. Open a file or wait for code in the agent reply.`}
      </pre>
    </div>
  );
}
