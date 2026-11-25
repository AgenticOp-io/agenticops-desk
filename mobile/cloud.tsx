import { useEffect, useState } from "react";

// Cloud agents run by a superadmin desk. The admin gives this phone a one-time code; it becomes a token kept here.
// shortcut: token in localStorage like the API key in agent.ts; move both to the keystore together.
type Job = { id: string; prompt: string; status: string; agent?: string; costUsd: number; log: string[]; result?: string };
type Me = { name: string; maxAgents: number; agents: Array<{ id: string; name: string; os: string; online: boolean }>; jobs: Job[] };

const store = {
  get: () => JSON.parse(localStorage.getItem("cloud.desk") ?? "null") as { url: string; token: string } | null,
  set: (v: { url: string; token: string } | null) => (v ? localStorage.setItem("cloud.desk", JSON.stringify(v)) : localStorage.removeItem("cloud.desk")),
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const d = store.get()!;
  const res = await fetch(d.url + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` }, body: body ? JSON.stringify(body) : undefined });
  const v = await res.json().catch(() => ({}));
  if (res.status === 401) store.set(null);
  if (!res.ok) throw new Error(v.error ?? `The desk said ${res.status}`);
  return v as T;
}

export function CloudView() {
  const [desk, setDesk] = useState(store.get());
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("claude-sonnet-5-5");

  const load = () => api<Me>("/user/me").then((m) => (setMe(m), setErr(""))).catch((e) => (setErr(e.message), setDesk(store.get())));
  useEffect(() => {
    if (!desk) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [desk]);

  if (!desk)
    return (
      <main className="m-list m-pad m-settings">
        <p className="m-muted">Your admin's desk address and the access code they made for you.</p>
        <input placeholder="Desk address, e.g. https://10.0.0.5:7377" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoCapitalize="off" />
        <input placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
        <button
          className="m-primary"
          disabled={!url.trim() || !code.trim()}
          onClick={async () => {
            try {
              const base = url.trim().replace(/\/+$/, "");
              if (!/^https:\/\//i.test(base)) throw new Error("The desk address must start with https://");
              const res = await fetch(`${base}/user/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, device: navigator.userAgent.slice(0, 60) }) });
              const v = await res.json();
              if (!res.ok) throw new Error(v.error);
              store.set({ url: base, token: v.token });
              setDesk(store.get());
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Connect
        </button>
        {err && <p className="m-muted">{err}</p>}
      </main>
    );

  return (
    <main className="m-list m-pad m-settings">
      {me && <p className="m-muted">{me.name} · up to {me.maxAgents} agent{me.maxAgents === 1 ? "" : "s"} at once</p>}
      {err && <p className="m-muted">{err}</p>}
      <textarea rows={4} placeholder="What should the agent do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <input placeholder="Git repository (optional)" value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="off" />
      <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        <option value="">Any free agent</option>
        {me?.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.os}{a.online ? "" : ", offline"})</option>)}
      </select>
      <select value={model} onChange={(e) => setModel(e.target.value)}>
        <option value="claude-sonnet-5-5">Sonnet</option>
        <option value="claude-haiku-5-5">Haiku</option>
        <option value="claude-opus-5-5">Opus</option>
      </select>
      <button
        className="m-primary"
        disabled={!prompt.trim()}
        onClick={() => void api("/user/jobs", { prompt, repo: repo.trim() || undefined, agentId: agentId || undefined, model }).then(() => (setPrompt(""), load())).catch((e) => setErr(e.message))}
      >
        Start job
      </button>
      {me?.jobs.map((j) => (
        <details key={j.id} className="m-row">
          <summary>
            <b>{j.status}</b> · {j.agent ?? "waiting for an agent"} · ${j.costUsd.toFixed(3)} · {j.prompt.slice(0, 60)}
          </summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{j.result ?? j.log.join("\n")}</pre>
          {(j.status === "queued" || j.status === "running") && <button className="ghost" onClick={() => void api(`/user/jobs/${j.id}/cancel`, {}).then(load)}>Cancel</button>}
        </details>
      ))}
      <button className="ghost" onClick={() => confirm("Disconnect from this desk? You'll need a new code from your admin.") && (store.set(null), setDesk(null), setMe(null))}>Disconnect</button>
    </main>
  );
}
