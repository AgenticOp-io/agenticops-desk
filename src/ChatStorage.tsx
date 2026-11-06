import { useState } from "react";

const OPTIONS = [
  {
    id: "github",
    title: "GitHub",
    text: "Chats are copied here and sync through a private GitHub repository. Cursor's folders are no longer needed, and Settings can delete them.",
  },
  {
    id: "hybrid",
    title: "Hybrid",
    text: "Chats are copied here and sync through GitHub the same way, and Cursor keeps all its files.",
  },
  {
    id: "local",
    title: "Cursor on this computer",
    text: "Chats stay in Cursor's local database and are read from there. Nothing is copied, and nothing goes to GitHub.",
  },
] as const;

type Mode = (typeof OPTIONS)[number]["id"];

// Where chats live: asked once when Cursor chats are found, and changeable in Settings.
export function ChatStorage({ current, url: savedUrl = "", onChosen }: { current?: string; url?: string; onChosen: (mode: Mode) => void }) {
  const [url, setUrl] = useState(savedUrl);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const choose = (mode: Mode) => {
    setBusy(true);
    setNote(mode === "local" ? "" : "Copying your chats and pushing them. This can take a minute…");
    void window.desk.setChatStorage(mode, url).then((result) => {
      setBusy(false);
      setNote(result.note);
      if (result.ok) onChosen(mode);
    });
  };

  return (
    <>
      <div className="provider-line">
        <input
          aria-label="Private GitHub repository address"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Private repository for GitHub or Hybrid: https://github.com/you/desk-sync.git"
          spellCheck={false}
        />
      </div>
      <div className="palette-list">
        {OPTIONS.map((option) => (
          <button key={option.id} type="button" className={`list-item ${current === option.id ? "active" : ""}`} disabled={busy} onClick={() => choose(option.id)}>
            <span className="list-title">{option.title}{current === option.id ? " · current" : ""}</span>
            <span className="storage-text">{option.text}</span>
          </button>
        ))}
      </div>
      {note && <p className="settings-hint" role="status">{note}</p>}
    </>
  );
}
