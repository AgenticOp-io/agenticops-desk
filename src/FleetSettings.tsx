import { useEffect, useState } from "react";

type Fleet = Awaited<ReturnType<typeof window.desk.fleetState>>;
type Row = Awaited<ReturnType<typeof window.desk.fleetReport>>[number];

const thisMonth = () => new Date().toISOString().slice(0, 7);
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString();
};

// Superadmin page: this desk runs the control server, pairs cloud agents, hands out user codes, and reports use.
export function FleetSettings() {
  const [f, setF] = useState<Fleet | null>(null);
  const [msg, setMsg] = useState("");
  const [code, setCode] = useState("");
  const [userName, setUserName] = useState("");
  const [userMax, setUserMax] = useState("1");
  const [newCode, setNewCode] = useState<{ name: string; code: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<Row[]>([]);

  const refresh = () => void window.desk.fleetState().then(setF);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => void window.desk.fleetReport(month).then(setRows), [month, f?.jobs.length]);

  if (!f) return <p className="settings-hint">Loading…</p>;
  const approved = f.agents.filter((a) => a.status === "approved");
  const url = f.urls[0];

  return (
    <>
      <p className="settings-hint">
        This desk is the superadmin for its cloud agents (ID {f.adminId.slice(0, 8)}, since {new Date(f.createdAt).toLocaleDateString()}). Agents and users pair only with this desk.
        Model calls from every agent run through this desk with its Claude API key, so keys never leave this computer.
      </p>
      {!f.hasKey && <p className="settings-hint">No Claude API key is saved. Add one in AI models first, or agents can't do any work.</p>}

      <div className="settings-label">Server</div>
      <label className="settings-check">
        <input type="checkbox" checked={f.on} onChange={(e) => void window.desk.fleetSetup({ on: e.target.checked }).then(setF)} />
        Accept cloud agents and users on port
        <input
          style={{ width: 80, marginLeft: 6 }}
          defaultValue={f.port}
          inputMode="numeric"
          onBlur={(e) => Number(e.target.value) !== f.port && void window.desk.fleetSetup({ port: Number(e.target.value) }).then(setF)}
        />
      </label>
      {f.error && <p className="settings-hint">{f.error}</p>}
      {f.on && f.listening && (
        <p className="settings-hint">
          Listening on {f.urls.join(", ")}, HTTPS only, with this desk's own certificate (SHA-256 {f.tlsFingerprint}). Phones and
          browsers must trust it: download <code>{url}/desk.crt</code>, check the fingerprint matches, and install it as a CA certificate.
        </p>
      )}
      <label className="settings-row">
        <span>Most cloud agents this desk will pair</span>
        <input
          defaultValue={f.maxAgents}
          inputMode="numeric"
          style={{ width: 80 }}
          onBlur={(e) => Number(e.target.value) !== f.maxAgents && void window.desk.fleetSetup({ maxAgents: Number(e.target.value) }).then(setF)}
        />
      </label>

      <div className="settings-label">Cloud agents ({approved.length} of {f.maxAgents})</div>
      <p className="settings-hint">
        On a Windows, macOS or Linux machine with Node 18 or newer, run:
        <br />
        <code>curl -k --pinnedpubkey "sha256//{f.tlsPin}" -o agentd.mjs {url}/agent.mjs && node agentd.mjs --desk {url} --key {f.deskKey}</code>
        <br />
        In Windows PowerShell: <code>curl.exe -k --pinnedpubkey "sha256//{f.tlsPin}" -o agentd.mjs {url}/agent.mjs; node agentd.mjs --desk {url} --key {f.deskKey}</code>
        <br />
        It prints a pairing code. Type it here. <code>--pinnedpubkey</code> makes the download accept only this desk's certificate, and the
        script carries that certificate, so the agent talks to nothing else. <code>--key</code> checks the desk's agent key on top.
      </p>
      <div className="provider-line">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the agent, e.g. ABCD-EFGH" aria-label="Agent pairing code" spellCheck={false} />
        <button
          className="btn"
          disabled={!code.trim()}
          onClick={() =>
            void window.desk.fleetApprove(code).then((err) => {
              setMsg(err ?? "Agent paired.");
              if (!err) setCode("");
              refresh();
            })
          }
        >
          Pair
        </button>
      </div>
      {f.agents.filter((a) => a.status === "pending").length > 0 && (
        <p className="settings-hint">{f.agents.filter((a) => a.status === "pending").length} agent(s) waiting for their code to be typed here.</p>
      )}
      {approved.map((a) => (
        <div key={a.id} className="signin-row">
          <span>
            {a.online ? "● " : "○ "}
            <strong>{a.name}</strong> · {a.os} · {a.online ? "online" : `last seen ${ago(a.lastSeen)}`}
          </span>
          <span className="grow" />
          <button className="btn" onClick={() => confirm(`Remove ${a.name}? It stops taking jobs and must pair again.`) && void window.desk.fleetRemoveAgent(a.id).then(refresh)}>
            Remove
          </button>
        </div>
      ))}

      <div className="settings-label">Users</div>
      <p className="settings-hint">
        Each user gets a one-time access code for the phone app (Settings → Cloud agents) or any browser at {url}. "Agents at once" is how many cloud agents they may keep busy.
      </p>
      <div className="provider-line">
        <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Name" aria-label="User name" />
        <input value={userMax} onChange={(e) => setUserMax(e.target.value.replace(/\D/g, ""))} aria-label="Agents at once" style={{ width: 60 }} inputMode="numeric" />
        <button
          className="btn"
          disabled={!userName.trim()}
          onClick={() =>
            void window.desk.fleetAddUser(userName, Number(userMax) || 0, []).then((c) => {
              setNewCode({ name: userName, code: c });
              setUserName("");
              refresh();
            })
          }
        >
          Make code
        </button>
      </div>
      {newCode && <div className="settings-label">Code for {newCode.name}: {newCode.code}</div>}
      {f.users.map((u) => (
        <div key={u.id} className="settings-hidden">
          <div className="signin-row">
            <span>
              <strong>{u.name}</strong>{u.code ? ` · code ${u.code}` : ""}{!u.redeemed && !u.code ? " · no device" : ""}
            </span>
            <span className="grow" />
            <label>
              Agents at once{" "}
              <input
                defaultValue={u.maxAgents}
                style={{ width: 50 }}
                inputMode="numeric"
                onBlur={(e) => Number(e.target.value) !== u.maxAgents && void window.desk.fleetUpdateUser(u.id, { maxAgents: Number(e.target.value) || 0 }).then(refresh)}
              />
            </label>
            <button className="btn" onClick={() => void window.desk.fleetUpdateUser(u.id, { newCode: true }).then(refresh)}>New code (another device)</button>
            <button className="btn" onClick={() => confirm(`Revoke ${u.name}? Their device is signed out and their jobs stop.`) && void window.desk.fleetUpdateUser(u.id, { revoke: true }).then(refresh)}>
              Revoke
            </button>
          </div>
          {u.devices.map((d) => (
            <div key={d.id} className="signin-row">
              <span className="settings-hint">Device: {d.name}</span>
              <span className="grow" />
              <button className="btn" onClick={() => confirm(`Sign out ${d.name}? Only that device loses access.`) && void window.desk.fleetUpdateUser(u.id, d.id === "legacy" ? { signOutAll: true } : { revokeDevice: d.id }).then(refresh)}>Revoke device</button>
            </div>
          ))}
          {approved.length > 1 && (
            <div className="signin-row">
              <span className="settings-hint">May use:</span>
              {approved.map((a) => (
                <label key={a.id} className="settings-check">
                  <input
                    type="checkbox"
                    checked={!u.agentIds.length || u.agentIds.includes(a.id)}
                    onChange={(e) => {
                      const all = u.agentIds.length ? u.agentIds : approved.map((x) => x.id);
                      const next = e.target.checked ? [...all, a.id] : all.filter((x) => x !== a.id);
                      void window.desk.fleetUpdateUser(u.id, { agentIds: next.length === approved.length ? [] : next }).then(refresh);
                    }}
                  />
                  {a.name}
                </label>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="settings-label">Jobs</div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Give a cloud agent a job" style={{ width: "100%" }} />
      <div className="provider-line">
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Git repository (optional)" spellCheck={false} />
        <button
          className="btn"
          disabled={!prompt.trim()}
          onClick={() =>
            void window.desk.fleetSubmit({ prompt, repo: repo.trim() || undefined }).then((err) => {
              setMsg(err ?? "Job queued.");
              if (!err) setPrompt("");
              refresh();
            })
          }
        >
          Start job
        </button>
      </div>
      {msg && <p className="settings-hint">{msg}</p>}
      {f.jobs.slice(0, 20).map((j) => (
        <details key={j.id} className="settings-hidden">
          <summary>
            <strong>{j.status}</strong> · {j.user} · {j.agent ?? "waiting for an agent"} · ${j.costUsd.toFixed(3)} · {j.prompt.slice(0, 80)}
            {(j.status === "queued" || j.status === "running") && (
              <button className="more-link" onClick={(e) => (e.preventDefault(), void window.desk.fleetCancel(j.id).then(refresh))}>
                Cancel
              </button>
            )}
          </summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{j.result ?? j.log.join("\n")}</pre>
        </details>
      ))}

      <div className="settings-label">Report</div>
      <div className="signin-row">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} aria-label="Month" />
        <span className="grow" />
        <button className="btn" onClick={() => void window.desk.fleetExport(month).then((p) => p && setMsg(`Saved ${p}`))}>Export CSV</button>
      </div>
      {rows.length === 0 ? (
        <p className="settings-hint">No jobs that month.</p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr><th></th><th>Name</th><th>Jobs</th><th>Failed</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th><th>Minutes</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}${r.id}`}>
                <td>{r.kind}</td><td>{r.name}</td><td>{r.jobs}</td><td>{r.failed}</td><td>{r.input.toLocaleString()}</td><td>{r.output.toLocaleString()}</td><td>${r.costUsd.toFixed(2)}</td><td>{r.minutes.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
