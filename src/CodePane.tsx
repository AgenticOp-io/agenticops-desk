import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeSnippet } from "./codeBlocks";
import { OriginLine } from "./Extras";
import { languageForFence, languageForPath } from "./monaco";

type FileTab = { path: string; name: string; contents: string; dirty: boolean };
export type DiffView = { path: string; before: string; after: string; created: boolean };

// A Cursor-style editor group: tabs, breadcrumb, then Monaco. Files are editable and save with Ctrl+S;
// code blocks from Claude's replies open as read-only tabs.
export function CodePane({
  files,
  activePath,
  snippets,
  snippetId,
  workspace,
  diff,
  onDiffKeep,
  onDiffUndo,
  onDiffClose,
  onSelectFile,
  onSelectSnippet,
  onCloseFile,
  onChangeFile,
  onSaveFile,
  onHide,
  onOpenChat,
}: {
  files: FileTab[];
  activePath: string | null;
  snippets: CodeSnippet[];
  snippetId: string | null;
  workspace: string;
  diff: DiffView | null;
  onDiffKeep: (path: string) => void;
  onDiffUndo: (path: string) => void;
  onDiffClose: () => void;
  onSelectFile: (path: string) => void;
  onSelectSnippet: (id: string) => void;
  onCloseFile: (path: string) => void;
  onChangeFile: (path: string, contents: string) => void;
  onSaveFile: (path: string) => void;
  onHide: () => void;
  onOpenChat?: (chatId: string) => void;
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

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editableRef = useRef(false);
  editableRef.current = Boolean(shownFile);
  // Quick edit: the selection (or the cursor's line) is rewritten from a one-line instruction.
  const [ask, setAsk] = useState<{ range: monaco.IRange } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
    editor.addAction({
      id: "desk.quickEdit",
      label: "Edit with AI…",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      contextMenuGroupId: "1_modification",
      run: (ed) => {
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!editableRef.current || !sel || !model) return;
        const range = sel.isEmpty()
          ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber))
          : sel;
        setNote("");
        setAsk({ range });
      },
    });
  };

  const runQuickEdit = async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !ask || !shownFile || !instruction.trim()) return;
    const r = ask.range;
    const selection = model.getValueInRange(r);
    const end = model.getFullModelRange().getEndPosition();
    setBusy(true);
    try {
      const out = await window.desk.quickEdit({
        file: shownFile.path,
        language,
        before: model.getValueInRange(new monaco.Range(1, 1, r.startLineNumber, r.startColumn)),
        selection,
        after: model.getValueInRange(new monaco.Range(r.endLineNumber, r.endColumn, end.lineNumber, end.column)),
        instruction,
      });
      // The user may have switched files or typed meanwhile; never write over code that moved.
      if (editor.getModel() !== model || model.getValueInRange(r) !== selection) {
        setNote("The code changed while waiting, so nothing was applied. Try again.");
        return;
      }
      editor.pushUndoStop();
      editor.executeEdits("quick-edit", [{ range: r, text: out.text }]);
      editor.pushUndoStop();
      setAsk(null);
      setInstruction("");
      setNote(`Edited by ${out.model}. Ctrl+Z undoes it; Ctrl+S saves.`);
      editor.focus();
    } catch (err) {
      setNote(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The diff editor keeps its models on unmount (disposing them first throws), so release them here.
  const diffKey = diff ? `${diff.path}\n${diff.before.length}\n${diff.after.length}` : "";
  useEffect(() => {
    return () => {
      setTimeout(() => {
        for (const m of monaco.editor.getModels()) {
          if (m.uri.scheme === "review-before" || m.uri.scheme === "review-after") m.dispose();
        }
      }, 0);
    };
  }, [diffKey]);

  // Drop models for closed tabs so their memory is released.
  useEffect(() => {
    const open = new Set(files.map((f) => monaco.Uri.file(f.path).toString()));
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme === "file" && !open.has(m.uri.toString())) m.dispose();
    }
  }, [files]);

  const crumbs = useMemo(() => {
    if (!shownFile) return shownSnippet ? ["Reply", shownSnippet.name] : [];
    return crumbsFor(shownFile.path, workspace);
  }, [shownFile, shownSnippet, workspace]);

  return (
    <div className="code-pane">
      <div className="editor-tabs">
        <div className="editor-tab-strip">
          {diff && (
            <div className="editor-tab review active" title={diff.path}>
              <span className="editor-tab-name">{diff.path.split(/[\\/]/).pop()} (changes)</span>
              <button type="button" className="editor-tab-close" title="Close review" onClick={onDiffClose}>
                <span className="x">×</span>
              </button>
            </div>
          )}
          {files.map((f) => (
            <div
              key={f.path}
              className={`editor-tab ${!diff && shownFile?.path === f.path ? "active" : ""} ${f.dirty ? "dirty" : ""}`}
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
              className={`editor-tab snippet ${!diff && shownSnippet?.id === s.id ? "active" : ""}`}
              title="Code from the reply (read-only)"
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
      {diff && (
        <div className="review-bar">
          <span>
            {diff.created ? "New file from the agent" : "Changes by the agent"} · <strong>{crumbsFor(diff.path, workspace).join(" › ")}</strong>
          </span>
          <span className="grow" />
          <button type="button" className="btn danger" onClick={() => onDiffUndo(diff.path)}>
            {diff.created ? "Delete file" : "Undo changes"}
          </button>
          <button type="button" className="btn primary" onClick={() => onDiffKeep(diff.path)}>
            Keep
          </button>
        </div>
      )}
      {!diff && crumbs.length > 0 && (
        <div className="editor-crumbs">
          {crumbs.map((c, i) => (
            <span key={`${i}-${c}`} className={i === crumbs.length - 1 ? "last" : ""}>
              {c}
            </span>
          ))}
          {shownSnippet && <span className="readonly">read-only</span>}
          {shownFile && onOpenChat && <OriginLine file={shownFile.path} onOpen={onOpenChat} />}
        </div>
      )}
      <div className="editor-body">
        {!diff && shownFile && (ask || note) && (
          <div className="quick-edit">
            {ask && (
              <input
                autoFocus
                disabled={busy}
                value={instruction}
                placeholder={busy ? "Editing…" : "Change the selected code: e.g. add error handling (Enter to apply, Esc to cancel)"}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void runQuickEdit();
                  }
                  if (e.key === "Escape") {
                    setAsk(null);
                    editorRef.current?.focus();
                  }
                }}
              />
            )}
            {busy && <span className="quick-edit-note">Editing…</span>}
            {!busy && note && (
              <span className="quick-edit-note">
                {note}{" "}
                <button type="button" className="more-link" onClick={() => setNote("")}>
                  OK
                </button>
              </span>
            )}
          </div>
        )}
        {diff ? (
          <DiffEditor
            theme="vs-dark"
            original={diff.before}
            modified={diff.after}
            language={languageForPath(diff.path)}
            originalModelPath={`review-before:/${diff.path}`}
            modifiedModelPath={`review-after:/${diff.path}`}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: true,
              renderSideBySide: false,
              fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderOverviewRuler: true,
              hideUnchangedRegions: { enabled: true },
            }}
          />
        ) : shownFile || shownSnippet ? (
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
            <div>Code blocks in replies show up here as tabs.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function crumbsFor(filePath: string, workspace: string) {
  const rel =
    workspace && filePath.toLowerCase().startsWith(workspace.toLowerCase())
      ? filePath.slice(workspace.length).replace(/^[\\/]+/, "")
      : filePath;
  return rel.split(/[\\/]/).filter(Boolean);
}
