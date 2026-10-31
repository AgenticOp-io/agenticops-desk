import Editor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef } from "react";
import type { CodeSnippet } from "./codeBlocks";
import { languageForFence, languageForPath } from "./monaco";

type FileTab = { path: string; name: string; contents: string; dirty: boolean };

// A Cursor-style editor group: tabs, breadcrumb, then Monaco. Files are editable and save with Ctrl+S;
// code blocks from Claude's replies open as read-only tabs.
export function CodePane({
  files,
  activePath,
  snippets,
  snippetId,
  workspace,
  onSelectFile,
  onSelectSnippet,
  onCloseFile,
  onChangeFile,
  onSaveFile,
  onHide,
}: {
  files: FileTab[];
  activePath: string | null;
  snippets: CodeSnippet[];
  snippetId: string | null;
  workspace: string;
  onSelectFile: (path: string) => void;
  onSelectSnippet: (id: string) => void;
  onCloseFile: (path: string) => void;
  onChangeFile: (path: string, contents: string) => void;
  onSaveFile: (path: string) => void;
  onHide: () => void;
}) {
  const file = files.find((t) => t.path === activePath) ?? files[0] ?? null;
  const snippet = snippetId ? snippets.find((s) => s.id === snippetId) ?? null : null;
  const shownSnippet = snippet ?? (!file ? snippets.at(-1) ?? null : null);
  const shownFile = shownSnippet ? null : file;

  // Monaco keeps one model per path, so each tab keeps its own undo history, cursor and scroll.
  const modelPath = shownFile ? shownFile.path : shownSnippet ? `snippet:/${shownSnippet.id}` : "empty";
  const language = shownFile
    ? languageForPath(shownFile.path)
    : shownSnippet
      ? languageForFence(shownSnippet.lang)
      : "plaintext";

  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (shownFile?.dirty) onSaveFile(shownFile.path);
  };

  const onMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  // Drop models for closed tabs so their memory is released.
  useEffect(() => {
    const open = new Set(files.map((f) => monaco.Uri.file(f.path).toString()));
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme === "file" && !open.has(m.uri.toString())) m.dispose();
    }
  }, [files]);

  const crumbs = useMemo(() => {
    if (!shownFile) return shownSnippet ? ["Claude", shownSnippet.name] : [];
    const rel =
      workspace && shownFile.path.toLowerCase().startsWith(workspace.toLowerCase())
        ? shownFile.path.slice(workspace.length).replace(/^[\\/]+/, "")
        : shownFile.path;
    return rel.split(/[\\/]/).filter(Boolean);
  }, [shownFile, shownSnippet, workspace]);

  return (
    <div className="code-pane">
      <div className="editor-tabs">
        <div className="editor-tab-strip">
          {files.map((f) => (
            <div
              key={f.path}
              className={`editor-tab ${shownFile?.path === f.path ? "active" : ""} ${f.dirty ? "dirty" : ""}`}
              title={f.path}
              onClick={() => onSelectFile(f.path)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseFile(f.path);
                }
              }}
            >
              <span className="editor-tab-name">{f.name}</span>
              <button
                type="button"
                className="editor-tab-close"
                title={f.dirty ? "Unsaved changes" : "Close"}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(f.path);
                }}
              >
                <span className="dot">●</span>
                <span className="x">×</span>
              </button>
            </div>
          ))}
          {snippets.map((s) => (
            <div
              key={s.id}
              className={`editor-tab snippet ${shownSnippet?.id === s.id ? "active" : ""}`}
              title="Code from Claude's reply (read-only)"
              onClick={() => onSelectSnippet(s.id)}
            >
              <span className="editor-tab-name">{s.name}</span>
            </div>
          ))}
        </div>
        <button type="button" className="editor-hide" title="Close editor" onClick={onHide}>
          ×
        </button>
      </div>
      {crumbs.length > 0 && (
        <div className="editor-crumbs">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c}`} className={i === crumbs.length - 1 ? "last" : ""}>
              {c}
            </span>
          ))}
          {shownSnippet && <span className="readonly">read-only</span>}
        </div>
      )}
      <div className="editor-body">
        {shownFile || shownSnippet ? (
          <Editor
            theme="vs-dark"
            path={modelPath}
            language={language}
            value={shownFile ? shownFile.contents : shownSnippet?.code ?? ""}
            onMount={onMount}
            onChange={(v) => {
              if (shownFile && v !== undefined && v !== shownFile.contents) onChangeFile(shownFile.path, v);
            }}
            options={{
              readOnly: !shownFile,
              fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
              fontLigatures: true,
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: true, renderCharacters: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: "smooth",
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              stickyScroll: { enabled: true },
              padding: { top: 6 },
              automaticLayout: true,
            }}
          />
        ) : (
          <div className="editor-empty">
            <div>Open a file from Files or with Ctrl+P.</div>
            <div>Code blocks in Claude's replies show up here as tabs.</div>
          </div>
        )}
      </div>
    </div>
  );
}
