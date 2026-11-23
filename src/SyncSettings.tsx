import { useEffect, useState } from "react";

type SyncView = {
  url: string;
  ok: boolean;
  note: string;
  cursor: "off" | "partial" | "full";
  projects: Array<{ id: string; remote: string; name: string; local: string | null }>;
};

export function SyncSettings({ onChanged }: { onChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [view, setView] = useState<SyncView | null>(null);
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<{ ok: boolean; image?: string; login?: string; code?: string; error?: string } | null>(null);
  // Don't leave the sign-in on screen: the code hides itself after two minutes.
  useEffect(() => {
    if (!pair?.image) return;
    const t = setTimeout(() => setPair(null), 120_000);
    return () => clearTimeout(t);
  }, [pair]);

  const [repos, setRepos] = useState<Array<{ repo: string; on: boolean; added: boolean }>>([]);
  const [newRepo, setNewRepo] = useState("");
  useEffect(() => {
    void window.desk.phoneRepos().then(setRepos);
  }, []);

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

  const missing = view?.projects.filter((project) => !project.local && project.remote).length ?? 0;
  const runRepos = (work: () => Promise<{ ok: boolean; output: string }>) => {
    setBusy(true);
    setView((cur) => (cur ? { ...cur, note: "Working on it. Cloning can take a few minutes…" } : cur));
    void work().then(async (result) => {
      const status = await window.desk.syncStatus();
      setView({ ...status, ok: result.ok, note: result.output });
      setBusy(false);
      onChanged();
    });
  };

  return (
    <>
      <div className="settings-label">Sync</div>
      <p className="settings-hint">
        A private git repository shared by your computers. Chats, memory and settings are pushed there. API keys stay on this
        computer, and passwords and tokens in a chat are hidden in the pushed copy. Leave the address empty to use your existing sync repository, or create a private one on your GitHub account if there is none. That also connects a second computer. Each project keeps its chats on every computer;
        clone it here when you want the files, or locate its folder from the sidebar.
      </p>
      <div className="provider-line">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Private repository address"
          placeholder="Created for you, or paste an address"
          spellCheck={false}
        />
      </div>
      <div className="signin-row">
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void (url.trim() ? window.desk.setSyncUrl(url) : window.desk.createSyncRepo()).then((status) => {
              apply(status);
              setBusy(false);
            });
          }}
        >
          {url.trim() ? "Save and sync" : "Create repository and sync"}
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
        <button
          className="btn"
          disabled={busy || !view?.url}
          onClick={() => {
            setBusy(true);
            void window.desk.setSyncUrl("").then((status) => {
              apply(status);
              setBusy(false);
            });
          }}
        >
          Turn off
        </button>
      </div>
      {missing > 0 && (
        <>
          <p className="settings-hint">
            {missing} project{missing === 1 ? "" : "s"} from your other computers {missing === 1 ? "has" : "have"} no folder here. Clones
            already on this computer are linked when the app starts. Find looks in a folder you pick, and Clone all downloads the rest.
          </p>
          <div className="signin-row">
            <button className="btn" disabled={busy} onClick={() => runRepos(window.desk.findLocalRepos)}>
              Find repositories…
            </button>
            <button className="btn" disabled={busy} onClick={() => runRepos(window.desk.cloneMissingRepos)}>
              Clone all ({missing})…
            </button>
          </div>
        </>
      )}
      <div className="settings-label">Phone</div>
      <p className="settings-hint">
        Open the phone app, tap Scan, and point it at this code. It carries this computer's GitHub sign-in, locked with the 8-digit code shown beside it, which the phone asks for. Keep both away from cameras. Hide it when you're done. To cut a lost phone off, revoke GitHub CLI on github.com under Settings → Applications, then sign
        in again here.
      </p>
      <div className="settings-label">Projects on the phone</div>
      <p className="settings-hint">Tick the repositories the phone shows. Show the pairing code again after changing the list.</p>
      {repos.map((r) => (
        <div className="provider-line" key={r.repo}>
          <label>
            <input type="checkbox" checked={r.on} onChange={() => void window.desk.setPhoneRepo(r.repo, r.on ? "off" : "on").then(setRepos)} /> {r.repo}
          </label>
          <button type="button" className="btn" onClick={() => void window.desk.setPhoneRepo(r.repo, "remove").then(setRepos)}>
            Remove
          </button>
        </div>
      ))}
      <div className="provider-line">
        <input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} aria-label="Add repository" placeholder="owner/name or GitHub address" spellCheck={false} />
        <button
          type="button"
          className="btn"
          disabled={!newRepo.trim()}
          onClick={() => void window.desk.setPhoneRepo(newRepo, "add").then((l) => { setRepos(l); setNewRepo(""); })}
        >
          Add
        </button>
      </div>
      <div className="signin-row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (pair) return setPair(null);
            void window.desk.phonePairQr().then(setPair);
          }}
        >
          {pair ? "Hide code" : "Show pairing code"}
        </button>
      </div>
      {pair?.error && <p className="settings-hint">{pair.error}</p>}
      {pair?.code && <div className="settings-label">Code for the phone: {pair.code.replace(/(\d{4})(\d{4})/, "$1 $2")}</div>}
      {pair?.image && <img src={pair.image} alt={`Pairing code for ${pair.login}`} width={240} height={240} style={{ background: "#fff" }} />}
    </>
  );
}
