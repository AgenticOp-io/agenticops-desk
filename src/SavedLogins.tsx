import { useEffect, useState } from "react";

type Logins = Awaited<ReturnType<typeof window.desk.listCredentials>>;

const KINDS = [
  ["password", "Password"],
  ["token", "Token or PAT"],
  ["ssh-key", "SSH private key"],
] as const;

const blank = { name: "", kind: "password", username: "", host: "", secret: "", passphrase: "" };

// A saved value only goes one way: into the main process. Nothing here can read one back.
export function SavedLogins({ privacyOn }: { privacyOn: boolean }) {
  const [state, setState] = useState<Logins | null>(null);
  const [form, setForm] = useState(blank);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState("");

  useEffect(() => {
    void window.desk.listCredentials().then(setState);
  }, []);

  const put = (patch: Partial<typeof blank>) => setForm((cur) => ({ ...cur, ...patch }));

  const save = async () => {
    setSaving(true);
    const result = await window.desk.saveCredential(form);
    setSaving(false);
    setNote(result.note);
    if (!result.ok) return;
    setForm(blank);
    setState(await window.desk.listCredentials());
  };

  const remove = async (name: string) => {
    setRemoving("");
    setNote((await window.desk.removeCredential(name)).note);
    setState(await window.desk.listCredentials());
  };

  return (
    <div className="saved-logins" id="settings-logins">
      <div className="settings-label">Saved logins</div>
      <p className="settings-hint">
        Passwords, tokens and SSH keys the agent can use by name, for SSH, telnet, git and web services, without seeing them.
        They are encrypted for your Windows account on this computer and never synced, so add them again on another computer.
        The agent asks once per chat before using each one. Telnet sends passwords unencrypted, so use SSH where you can.
      </p>
      {!privacyOn && <p className="settings-hint danger-text">Saved logins only work with Privacy Mode on, because that is what hides a value if a command prints it.</p>}
      {state && !state.encrypted && <p className="settings-hint danger-text">Windows encryption is unavailable, so nothing can be saved here.</p>}
      {state?.logins.map((login) => (
        <div className="plugin-row" key={login.name}>
          <div className="grow">
            <strong>{login.name}</strong>
            <span className="settings-hint">
              {" "}
              {KINDS.find(([id]) => id === login.kind)?.[1]}
              {login.username ? ` · ${login.username}` : ""}
              {login.host ? ` · ${login.host}` : ""}
              {login.passphrase ? " · with passphrase" : ""}
            </span>
          </div>
          {removing === login.name ? (
            <>
              <button className="btn danger" onClick={() => void remove(login.name)}>
                Remove
              </button>
              <button className="btn" onClick={() => setRemoving("")}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button
                className="btn"
                title="Saving with the same name replaces it"
                onClick={() => {
                  setForm({ ...blank, name: login.name, kind: login.kind, username: login.username, host: login.host });
                  setNote(`Enter the new value for ${login.name}, then save.`);
                }}
              >
                Replace
              </button>
              <button className="btn danger" onClick={() => setRemoving(login.name)}>
                Remove
              </button>
            </>
          )}
        </div>
      ))}
      <div className="provider-line">
        <input aria-label="Login name" placeholder="Name, like core-router" value={form.name} onChange={(e) => put({ name: e.target.value })} spellCheck={false} autoComplete="off" />
        <select aria-label="Kind" value={form.kind} onChange={(e) => put({ kind: e.target.value })}>
          {KINDS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="provider-line">
        <input aria-label="Username" placeholder="Username (optional)" value={form.username} onChange={(e) => put({ username: e.target.value })} spellCheck={false} autoComplete="off" />
        <input aria-label="Host" placeholder="Host or service (optional)" value={form.host} onChange={(e) => put({ host: e.target.value })} spellCheck={false} autoComplete="off" />
      </div>
      <div className="provider-line">
        {form.kind === "ssh-key" ? (
          <textarea
            className="login-key"
            aria-label="Private key"
            placeholder="Paste the private key, starting with -----BEGIN"
            rows={4}
            value={form.secret}
            onChange={(e) => put({ secret: e.target.value })}
            spellCheck={false}
            autoComplete="off"
          />
        ) : null}
        {form.kind === "ssh-key" ? (
          <input
            type="password"
            aria-label="Key passphrase"
            placeholder="Passphrase, if the key has one"
            value={form.passphrase}
            onChange={(e) => put({ passphrase: e.target.value })}
            autoComplete="new-password"
          />
        ) : (
          <input
            type="password"
            aria-label="Secret"
            placeholder={form.kind === "token" ? "Token" : "Password"}
            value={form.secret}
            onChange={(e) => put({ secret: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            autoComplete="new-password"
          />
        )}
        <button className="btn" disabled={saving || !form.name.trim() || form.secret.trim().length < 3 || state?.encrypted === false} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {note && <p className="settings-hint" role="status">{note}</p>}
    </div>
  );
}
