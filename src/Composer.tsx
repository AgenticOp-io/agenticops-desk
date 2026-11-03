import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ImageAttachment, ModelOption, PluginCommand, UsageInfo } from "./vite-env";

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
  ["plugins", "Browse and install Claude Code plugins"],
  ["autopick", "Choose which AIs the Auto model uses"],
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

const STOP = new Set(
  "about after again also because before being between could does doing don't every first from have into just like make maybe more most much need only other please really should since some still than that their them then there these they this those through until very want what when where which while will with would your".split(" "),
);

// Preview before sending: likely files and a similar earlier chat, from words in the message.
// Local searches only (file names and saved chats); nothing is sent anywhere.
function useSendPreview(value: string, activeChatId?: string, chatTitle?: (id: string) => string | undefined) {
  const [files, setFiles] = useState<string[]>([]);
  const [similar, setSimilar] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    const text = value.trim();
    if (text.length < 20 || text.startsWith("/")) {
      setFiles([]);
      setSimilar(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      const words = [...new Set((text.match(/[A-Za-z_][\w.-]{3,}/g) ?? []).map((w) => w.toLowerCase()))].filter((w) => !STOP.has(w));
      const keys = words.sort((a, b) => b.length - a.length).slice(0, 3);
      if (!keys.length) return;
      void Promise.all(keys.map((k) => window.desk.searchFiles(k))).then((lists) => {
        if (!alive) return;
        const hits = lists.flat().filter((h) => keys.some((k) => h.name.toLowerCase().includes(k)));
        setFiles([...new Set(hits.map((h) => h.rel.replace(/\\/g, "/")))].slice(0, 4));
      });
      const phrase = keys.slice(0, 2).sort((a, b) => text.toLowerCase().indexOf(a) - text.toLowerCase().indexOf(b));
      void window.desk.searchMessages(phrase[0]).then((ids) => {
        if (!alive) return;
        const id = ids.find((x) => x !== activeChatId && chatTitle?.(x));
        setSimilar(id ? { id, title: chatTitle!(id)! } : null);
      });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, activeChatId]);
  return { files, similar, tokens: Math.ceil(value.length / 4) };
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
    pluginCommands?: PluginCommand[];
    // With the Auto model: the AI it handed this chat's latest run to.
    routedTo?: string;
    usage?: UsageInfo;
    onSend: (extra: { images: ImageAttachment[]; mentions: string[] }) => void;
    onCommand: (command: string) => void;
    onCatchUp: () => void;
    onStop: () => void;
    // For the preview line: which earlier chat covered something similar.
    activeChatId?: string;
    chatTitle?: (id: string) => string | undefined;
    onOpenChat?: (id: string) => void;
  }
>(function Composer(props, ref) {
  const { value, onChange, running } = props;
  const preview = useSendPreview(value, props.activeChatId, props.chatTitle);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentions, setMentions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [note, setNote] = useState("");
  // Windows text suggestions (and other input methods) hold the last word as an unfinished composition.
  // Enter then only finishes the word, so remember the Enter and send once the composition has landed.
  const [sendAfterCompose, setSendAfterCompose] = useState(false);
  const enterDuringCompose = useRef(false);

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
  // Plugin commands and skills go to Claude Code as typed, so picking one only fills it in.
  const pluginTyped = /^\/([\w:-]*)$/.exec(value.trim());
  const pluginHits = pluginTyped
    ? (props.pluginCommands ?? []).filter((c) => c.command.toLowerCase().includes(pluginTyped[1].toLowerCase())).slice(0, 8)
    : [];

  const send = () => {
    if (slash && slashHits.some(([cmd]) => cmd === slash[1].toLowerCase()) && !slash[2]) {
      props.onCommand(slash[1].toLowerCase());
      onChange("");
      return;
    }
    if (!value.trim() && !images.length) return;
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

  useEffect(() => {
    if (!sendAfterCompose) return;
    setSendAfterCompose(false);
    send();
  }, [sendAfterCompose]);

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
        {(slashHits.length > 0 || pluginHits.length > 0) && (
          <div className="mention-pop">
            {pluginHits.map((c) => (
              <button
                type="button"
                key={`plugin:${c.command}`}
                className="mention-item"
                title={c.description}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(`/${c.command} `);
                  areaRef.current?.focus();
                }}
              >
                <span className="mention-name">/{c.command}</span>
                <span className="mention-rel">
                  {c.kind === "skill" ? "skill · " : ""}
                  {c.description || `from ${c.plugin}`}
                </span>
              </button>
            ))}
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
          onCompositionEnd={(e) => {
            if (!enterDuringCompose.current) return;
            enterDuringCompose.current = false;
            // Latin text means a suggestion box, so the Enter was meant as "send". Asian input methods
            // use Enter to pick characters, so those are left alone.
            if (/^[\x00-\x7F]*$/.test(e.data ?? "")) setSendAfterCompose(true);
          }}
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
            if (e.key !== "Enter" || e.shiftKey) return;
            if (e.nativeEvent.isComposing || e.keyCode === 229) {
              enterDuringCompose.current = true;
              return;
            }
            e.preventDefault();
            send();
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
        {props.model === "auto" && props.routedTo && (
          <span className="route-chip" title="The AI Auto used for this chat's latest message">
            → {props.routedTo}
          </span>
        )}
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
      {(preview.files.length > 0 || preview.similar) && (
        <div className="send-preview">
          {preview.files.length > 0 && <span title="Files whose names match words in your message">Likely files: {preview.files.join(", ")}</span>}
          {preview.similar && (
            <button type="button" className="link" title="An earlier chat mentioned the same thing" onClick={() => props.onOpenChat?.(preview.similar!.id)}>
              Similar: “{preview.similar.title}”
            </button>
          )}
          <span className="hint">~{preview.tokens.toLocaleString()} tokens</span>
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={running} onClick={props.onCatchUp}>
          {running ? "Running…" : "Catch Claude up"}
        </button>
        <button className="btn primary" disabled={!value.trim() && !images.length} onClick={send}>
          {running ? "Guide" : "Send"}
        </button>
        <button className="btn danger" onClick={props.onStop}>
          Stop
        </button>
        <span className="grow" />
        <span className="hint">Enter sends · Shift+Enter new line · @ files · Ctrl+P open</span>
      </div>
    </div>
  );
});
