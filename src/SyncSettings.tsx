import { useEffect, useState } from "react";

type SyncView = {
  url: string;
  ok: boolean;
  note: string;
  cursor: "off" | "partial" | "full";
  projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
};

const CURSOR_MODES = [
  ["off", "Off"],
  ["partial", "Archive"],
  ["full", "Full"],
] as const;

export function SyncSettings({ onChanged }: { onChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [view, setView] = useState<SyncView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.desk.syncStatus().then((status) => {
      setView(status);
      setUrl(status.url);
    });
  }, []);

  const apply = (status: SyncView) => {
    setView(status);
    setUrl(status.url);
    if (status.ok) onChanged();
  };

  return (
    <>
      <div className="settings-label">Sync</div>
      <p className="settings-hint">
        A private git repository shared by your computers. Chats, memory and settings are pushed there. API keys stay on this
        computer. Create an empty private repository and paste its address. Each project keeps its chats on every computer;
        clone it here when you want the files, or locate its folder from the sidebar.
      </p>
      <div className="provider-line">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/you/desk-sync.git"
          spellCheck={false}
        />
      </div>
      <div className="signin-row">
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.desk.setSyncUrl(url).then((status) => {
              apply(status);
              setBusy(false);
            });
          }}
        >
          Save and sync
        </button>
        <button
          className="btn"
          disabled={busy || !view?.url}
          onClick={() => {
            setBusy(true);
            void window.desk.syncNow().then((status) => {
              apply(status);
              setBusy(false);
            });
          }}
        >
          Sync now
        </button>
      </div>
      <div className="settings-label">Cursor</div>
      <p className="settings-hint">
        Off leaves Cursor alone. Archive copies a finished Cursor chat into this repository and shows it here. Full also adds
        chats from the repository to Cursor's list. Quit Cursor before choosing Full. A Cursor update can change that list, and a
        restored chat can open empty; the messages stay in the desk.
      </p>
      <div className="signin-row">
        {CURSOR_MODES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={view?.cursor === id ? "ghost on" : "ghost"}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.desk.setCursorIntegration(id).then((status) => {
                apply(status);
                setBusy(false);
              });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {view?.note && <p className="settings-hint">{view.note}</p>}
      {view?.projects.map((project) => (
        <div className="dock-row" key={project.id}>
          <span>
            {project.name} {project.local ? "· on this computer" : "· not on this computer"}
          </span>
          {!project.local && project.remote && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setBusy(true);
                void window.desk.cloneSyncedProject(project.remote, project.id).then((result) => {
                  setBusy(false);
                  setView((cur) => (cur ? { ...cur, ok: result.ok, note: result.output } : cur));
                  if (result.ok) {
                    onChanged();
                    void window.desk.syncStatus().then(setView);
                  }
                });
              }}
            >
              Clone
            </button>
          )}
        </div>
      ))}
    </>
  );
}
