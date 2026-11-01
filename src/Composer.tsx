import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ImageAttachment, ModelOption, UsageInfo } from "./vite-env";

export const MODES = [
  { value: "default", label: "Agent", hint: "Edits and runs commands; risky actions still ask" },
  { value: "plan", label: "Plan", hint: "Reads and plans; changes nothing until you approve the plan" },
  { value: "acceptEdits", label: "Auto-edit", hint: "Applies file edits without asking" },
] as const;

const SLASH = [
  ["help", "Open help"],
  ["agent", "Agent mode"],
  ["plan", "Plan mode"],
  ["auto", "Auto-edit mode"],
  ["catchup", "Catch Claude up on this chat"],
  ["terminal", "Open the terminal"],
  ["git", "Open git"],
  ["preview", "Open the page preview"],
  ["notes", "Edit project instructions and MCP servers"],
  ["rename", "Rename this chat"],
  ["pin", "Pin or unpin this chat"],
  ["branch", "Branch this chat"],
  ["theme", "Switch light and dark"],
  ["palette", "Open the command palette"],
] as const;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
type Hit = { name: string; path: string; rel: string };
export type ComposerHandle = { focus: () => void; addMention: (abs: string, rel: string) => void };

function compact(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function readImage(file: File): Promise<ImageAttachment | null> {
  if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const data = url.slice(url.indexOf(",") + 1);
      resolve(data ? { mediaType: file.type, data, name: file.name || "pasted image" } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (v: string) => void;
    running: boolean;
    mode: string;
    onMode: (m: string) => void;
    model: string;
    onModel: (m: string) => void;
    models: ModelOption[];
    usage?: UsageInfo;
    onSend: (extra: { images: ImageAttachment[]; mentions: string[] }) => void;
    onCommand: (command: string) => void;
    onCatchUp: () => void;
    onStop: () => void;
  }
>(function Composer(props, ref) {
  const { value, onChange, running } = props;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentions, setMentions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [note, setNote] = useState("");

  const valueRef = useRef(value);
  valueRef.current = value;
  useImperativeHandle(
    ref,
    () => ({
      focus: () => areaRef.current?.focus(),
      addMention: (abs: string, rel: string) => {
        const r = rel.replace(/\\/g, "/");
        const cur = valueRef.current;
        onChange(`${cur}${cur && !/\s$/.test(cur) ? " " : ""}@${r} `);
        setMentions((m) => ({ ...m, [r]: abs }));
        areaRef.current?.focus();
      },
    }),
    [onChange],
  );

  useEffect(() => {
    if (query === null) return;
    const t = setTimeout(() => {
      void window.desk.searchFiles(query).then((h) => {
        setHits(h.slice(0, 12));
        setPick(0);
      });
    }, 80);
    return () => clearTimeout(t);
  }, [query]);

  const trackMention = (text: string, caret: number) => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    setQuery(m ? m[1] : null);
  };

  const insertMention = (hit: Hit) => {
    const el = areaRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, `@${hit.rel.replace(/\\/g, "/")} `);
    const next = before + value.slice(caret);
    onChange(next);
    setMentions((m) => ({ ...m, [hit.rel.replace(/\\/g, "/")]: hit.path }));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files];
    const read = (await Promise.all(list.map(readImage))).filter((x): x is ImageAttachment => Boolean(x));
    if (read.length < list.filter((f) => f.type.startsWith("image/")).length) setNote("Images over 5 MB were skipped.");
    if (read.length) setImages((cur) => [...cur, ...read].slice(0, 10));
  };

  const slash = value.trim().match(/^\/([a-z]+)(?:\s+(\S.*))?$/i);
  const slashHits = slash
    ? SLASH.filter(([cmd]) => cmd.startsWith(slash[1].toLowerCase()))
    : value.trim() === "/"
      ? [...SLASH]
      : [];

  const send = () => {
    if (slash && slashHits.some(([cmd]) => cmd === slash[1].toLowerCase()) && !slash[2]) {
      props.onCommand(slash[1].toLowerCase());
      onChange("");
      return;
    }
    if (running || (!value.trim() && !images.length)) return;
    // Only mentions still present in the text count; deleting "@file" drops it.
    const live = Object.entries(mentions)
      .filter(([rel]) => value.includes(`@${rel}`))
      .map(([, abs]) => abs);
    props.onSend({ images, mentions: live });
    setImages([]);
    setMentions({});
    setNote("");
    setQuery(null);
  };

  const ctxPct = props.usage?.contextWindow
    ? Math.min(100, Math.round((props.usage.contextTokens / props.usage.contextWindow) * 100))
    : 0;

  return (
    <div
      className={`composer ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      {images.length > 0 && (
        <div className="attach-row">
          {images.map((img, i) => (
            <div key={i} className="attach-chip" title={img.name}>
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? "image"} />
              <button type="button" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} title="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-input">
        {slashHits.length > 0 && (
          <div className="mention-pop">
            {slashHits.map(([cmd, label]) => (
              <button
                type="button"
                key={cmd}
                className="mention-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onCommand(cmd);
                  onChange("");
                }}
              >
                <span className="mention-name">/{cmd}</span>
                <span className="mention-rel">{label}</span>
              </button>
            ))}
          </div>
        )}
        {query !== null && hits.length > 0 && (
          <div className="mention-pop">
            {hits.map((h, i) => (
              <button
                type="button"
                key={h.path}
                className={`mention-item ${i === pick ? "active" : ""}`}
                onMouseEnter={() => setPick(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(h);
                }}
              >
                <span className="mention-name">{h.name}</span>
                <span className="mention-rel">{h.rel}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          placeholder="Message Claude Code…  @ to add a file, paste or drop images"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            trackMention(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => trackMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
          }}
          onKeyDown={(e) => {
            if (query !== null && hits.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(hits[pick]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery(null);
                return;
              }
            }
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              send();
              return;
            }
            if (e.shiftKey) return;
            // Enter on an empty trailing line (a second Enter in a row) sends; otherwise it is a newline.
            const el = e.currentTarget;
            const before = el.value.slice(0, el.selectionStart);
            const after = el.value.slice(el.selectionEnd);
            if (before.endsWith("\n") && after.trim() === "") {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      <div className="composer-tools">
        <select
          className="pill"
          value={props.mode}
          onChange={(e) => props.onMode(e.target.value)}
          title={MODES.find((m) => m.value === props.mode)?.hint}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value} title={m.hint}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          className="pill"
          value={props.model}
          onChange={(e) => props.onModel(e.target.value)}
          title="Model for this chat's next message"
        >
          <option value="">Claude Code · default model</option>
          {[...new Set(props.models.map((m) => m.group ?? "Claude Code"))].map((group) => (
            <optgroup key={group} label={group}>
              {props.models
                .filter((m) => (m.group ?? "Claude Code") === group)
                .map((m) => (
                  <option key={m.value} value={m.value} title={m.description}>
                    {m.displayName}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="pill" title="Attach images" onClick={() => fileRef.current?.click()}>
          Image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {note && <span className="hint">{note}</span>}
        <span className="grow" />
        {props.usage && (
          <span
            className="usage"
            title={`Context: ${props.usage.contextTokens.toLocaleString()} of ${props.usage.contextWindow.toLocaleString()} tokens${props.usage.model ? ` · ${props.usage.model}` : ""}\nEstimated cost of this chat since ClaudeDesk started: $${props.usage.costUsd.toFixed(4)}`}
          >
            <span className="usage-meter">
              <span style={{ width: `${ctxPct}%` }} className={ctxPct > 80 ? "hot" : ""} />
            </span>
            {props.usage.contextWindow
              ? `${compact(props.usage.contextTokens)} / ${compact(props.usage.contextWindow)} · $${props.usage.costUsd.toFixed(2)}`
              : `${compact(props.usage.contextTokens)} tokens`}
          </span>
        )}
      </div>
      <div className="row">
        <button className="btn" disabled={running} onClick={props.onCatchUp}>
          {running ? "Running…" : "Catch Claude up"}
        </button>
        <button className="btn primary" disabled={running} onClick={send}>
          Send
        </button>
        <button className="btn danger" onClick={props.onStop}>
          Stop
        </button>
        <span className="grow" />
        <span className="hint">Enter twice or Ctrl+Enter send · @ files · Ctrl+P open</span>
      </div>
    </div>
  );
});
