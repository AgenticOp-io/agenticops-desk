import { useEffect, useRef, useState } from "react";
import type { UiPrefs } from "./prefs";
import type { PrivacyStatus } from "./vite-env";

type Mode = UiPrefs["privacy"];

const MODES: Array<{ id: Mode; title: string; short: string; long: string }> = [
  {
    id: "protect",
    title: "Privacy Mode",
    short: "Secrets are swapped for placeholders before sending",
    long:
      "Passwords, keys and tokens in your messages, files and command output are replaced with placeholders like {{SECRET_3}} before anything reaches the AI. Real values are put back on this computer only when a command runs or a file is written. Key, certificate and credential files are blocked.",
  },
  {
    id: "local",
    title: "Local only",
    short: "Nothing leaves this computer",
    long:
      "Chats run only on an Ollama model on this computer. Claude Code and cloud providers are turned off. Placeholders still apply, so nothing changes if you switch back.",
  },
  {
    id: "standard",
    title: "Standard",
    short: "The AI sees exactly what it reads",
    long:
      "No filtering. Anything Claude reads, runs or receives from you is sent as is. Use this only for work that holds no secrets.",
  },
];

function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d={open ? "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" : "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"} />
    </svg>
  );
}

export function PrivacySettings({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [value, setValue] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];

  useEffect(() => {
    void window.desk.privacyStatus().then(setStatus);
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const pin = async () => {
    if (value.trim().length < 3) return;
    setStatus(await window.desk.pinSecret(value));
    setValue("");
  };

  return (
    <div className={`privacy-card ${mode}`}>
      <div className="privacy-top">
        <div className="privacy-text">
          <div className="privacy-title">
            <LockIcon open={mode === "standard"} />
            {current.title}
          </div>
          <p>{current.long}</p>
        </div>
        <div className="privacy-menu" ref={menuRef}>
          <button className="privacy-configure" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            Configure <span aria-hidden>▾</span>
          </button>
          {open && (
            <div className="privacy-options" role="listbox">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={m.id === mode}
                  className={m.id === mode ? "on" : ""}
                  onClick={() => {
                    onMode(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="privacy-option-text">
                    <strong>{m.title}</strong>
                    <em>{m.short}</em>
                  </span>
                  {m.id === mode && <span className="privacy-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {mode !== "standard" && (
        <div className="privacy-extra">
          <div className="settings-label">Always hide these values</div>
          <p className="settings-hint">
            For secrets with no label next to them, like a VPN key or a password you mention in passing. They are hidden
            wherever they appear. Stored encrypted on this computer and shown here only partly.
          </p>
          <div className="provider-line">
            <input
              type="password"
              placeholder="Paste a password or key"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void pin();
              }}
              autoComplete="off"
            />
            <button className="btn" disabled={value.trim().length < 3} onClick={() => void pin()}>
              Add
            </button>
          </div>
          {status && status.pinned.length > 0 && (
            <ul className="privacy-pinned">
              {status.pinned.map((p) => (
                <li key={p.index}>
                  <code>{p.masked}</code>
                  <button className="ghost" onClick={() => void window.desk.unpinSecret(p.index).then(setStatus)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {status && (
            <div className="privacy-foot">
              <span>
                {status.stored} placeholder{status.stored === 1 ? "" : "s"} saved
                {status.encrypted ? ", encrypted" : ", kept in memory until restart (Windows encryption is unavailable)"}
              </span>
              <span className="grow" />
              {confirmForget ? (
                <>
                  <span>Older chats will keep placeholders that no longer fill in.</span>
                  <button
                    className="btn danger"
                    onClick={() => {
                      setConfirmForget(false);
                      void window.desk.forgetPlaceholders().then(setStatus);
                    }}
                  >
                    Forget
                  </button>
                  <button className="btn" onClick={() => setConfirmForget(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn" disabled={!status.stored} onClick={() => setConfirmForget(true)}>
                  Forget placeholders
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
