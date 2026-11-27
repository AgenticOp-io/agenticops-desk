import { useEffect, useState } from "react";

type Fleet = Awaited<ReturnType<typeof window.desk.fleetState>>;
type Row = Awaited<ReturnType<typeof window.desk.fleetReport>>[number];

const thisMonth = () => new Date().toISOString().slice(0, 7);
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString();
};

// A desktop worker's side: join a superadmin's pool with the join key it was given.
function JoinPool() {
  const [p, setP] = useState<Awaited<ReturnType<typeof window.desk.poolState>> | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const refresh = () => void window.desk.poolState().then(setP);
  useEffect(refresh, []);
  if (!p) return null;
  return (
    <>
      <div className="settings-label">Join a pool</div>
      {p.joined ? (
        <div className="signin-row">
          <span>
            This desk is the worker <strong>{p.name}</strong> in the pool at {p.url}. Cloud work and your phone's cloud login (from the phone pairing QR) go there.
          </span>
          <span className="grow" />
          <button className="btn" onClick={() => confirm("Leave the pool? Ask the superadmin to delete this worker too.") && void window.desk.poolLeave().then(refresh)}>Leave</button>
        </div>
      ) : (
        <>
          <p className="settings-hint">If another desk runs the cloud agents, paste the join key its superadmin gave you.</p>
          <div className="provider-line">
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="https://…#…#ABCD-EFGH#…" aria-label="Join key" spellCheck={false} />
            <button
              className="btn"
              disabled={!key.trim()}
              onClick={() =>
                void window.desk.poolJoin(key).then((err) => {
                  setMsg(err ?? "Joined.");
                  if (!err) setKey("");
                  refresh();
                })
              }
            >
              Join
            </button>
          </div>
        </>
      )}
      {msg && <p className="settings-hint">{msg}</p>}
    </>
  );
}

// Superadmin page: this desk runs the control server, pairs cloud agents, hands out user codes, and reports use.
export function FleetSettings() {
  const [f, setF] = useState<Fleet | null>(null);
  const [msg, setMsg] = useState("");
  const [code, setCode] = useState("");
  const [agentKey, setAgentKey] = useState("");
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

  return (
    <>
      <JoinPool />
      <p className="settings-hint">
        This desk is the superadmin for its cloud agents (ID {f.adminId.slice(0, 8)}, since {new Date(f.createdAt).toLocaleDateString()}). Agents and users pair only with this desk.
        This desk and its agents never connect: jobs, including the ones a manager chat sends, go to the job channel repository in git,
        and agents check it every 15 seconds. Each agent calls the Claude API with its own key.
      </p>

      <div className="settings-label">Job channel</div>
      <p className="settings-hint">
        A private git repository only this desk and its agents can push to (not one with your code or chats). Jobs live on its
        agent-jobs branch, signed by this desk; agents sign what they write back.
      </p>
      <div className="provider-line">
        <input
          key={f.channel}
          defaultValue={f.channel}
          placeholder="git@github.com:you/desk-jobs.git"
          aria-label="Job channel repository"
          spellCheck={false}
          onBlur={(e) => e.target.value.trim() !== f.channel && void window.desk.fleetSetup({ channel: e.target.value }).then(setF)}
        />
      </div>
      {f.channelError && <p className="settings-hint">{f.channelError}</p>}

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
          Listening on {f.urls.join(", ")}. This desk is its own certificate authority (SHA-256 {f.tlsFingerprint}). It accepts a
          connection only from an agent, worker desk or phone holding a certificate it made, and drops it once you remove that agent or device.
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
        Make a Claude API key for each agent in the Claude Console, with a spend limit, and paste it here. This desk saves the agent
        script with that key, the job channel address and the agent's signing key as one file. Copy it to a Windows, macOS or Linux
        machine with Node 18 or newer and git that can push to the job channel, and run <code>node agentd-NAME.mjs</code> (Linux
        packages: see /etc/agenticops-agent/agent.env). No ports or public addresses are needed. Keep the file private, like an SSH key.
      </p>
      <div className="provider-line">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Agent name, e.g. build-box-1" aria-label="Agent name" spellCheck={false} />
        <input type="password" value={agentKey} onChange={(e) => setAgentKey(e.target.value)} placeholder="This agent's Claude API key" aria-label="Agent API key" spellCheck={false} autoComplete="off" />
        <button
          className="btn"
          disabled={!code.trim() || !agentKey.trim() || !f.channel}
          onClick={() =>
            void window.desk.fleetAddAgent(code, agentKey).then((r) => {
              if (!r) return;
              setMsg(r.error ?? `Saved ${r.path}. Copy it to the agent's computer and run it there; it shows online after its first check of the job channel.`);
              if (!r.error) {
                setCode("");
                setAgentKey("");
              }
              refresh();
            })
          }
        >
          Add agent
        </button>
      </div>
      {approved.map((a) => (
        <div key={a.id} className="signin-row">
          <span>
            {a.online ? "● " : "○ "}
            <strong>{a.name}</strong>{a.os ? ` · ${a.os}` : ""} · {a.oldFile ? "added before agents used the job channel; remove it and add it again" : a.online ? "online" : a.lastSeen ? `last seen ${ago(a.lastSeen)}` : "not seen yet"}
          </span>
          <span className="grow" />
          <button className="btn" onClick={() => confirm(`Remove ${a.name}? This desk ignores it from now on. Also revoke its API key in the Claude Console.`) && void window.desk.fleetRemoveAgent(a.id).then(refresh)}>
            Remove
          </button>
        </div>
      ))}

      <div className="settings-label">Desktop workers</div>
      <p className="settings-hint">
        Add each person's desktop here. They paste its join key into Settings → Cloud agents → Join a pool, and can then send work to the
        cloud agents and pair their own phone from their desk. "Agents at once" is how many cloud agents that worker may keep busy, phones included.
      </p>
      <div className="provider-line">
        <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Worker name" aria-label="Worker name" />
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
          Add worker
        </button>
      </div>
      {newCode && (
        <p className="settings-hint">
          Join key for {newCode.name} (works once): <code style={{ userSelect: "all" }}>{newCode.code}</code>
        </p>
      )}
      {f.users.map((u) => (
        <div key={u.id} className="settings-hidden">
          <div className="signin-row">
            <span>
              <strong>{u.name}</strong>{u.paused ? " · paused" : ""}{!u.redeemed && !u.code ? " · no device" : ""}
              {u.joinKey && <> · join key <code style={{ userSelect: "all" }}>{u.joinKey}</code></>}
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
            <button className="btn" onClick={() => void window.desk.fleetUpdateUser(u.id, { newCode: true }).then(refresh)}>New join key</button>
            <button className="btn" onClick={() => void window.desk.fleetUpdateUser(u.id, { paused: !u.paused }).then(refresh)}>{u.paused ? "Allow" : "Deny"}</button>
            <button className="btn" onClick={() => confirm(`Delete ${u.name}? Their desktop and phones are signed out and their jobs stop.`) && void window.desk.fleetUpdateUser(u.id, { revoke: true }).then(refresh)}>
              Delete
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
            <strong>{j.status}</strong> ·{j.agent ?? "waiting for an agent"} · ${j.costUsd.toFixed(3)} · {j.prompt.slice(0, 80)}
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
