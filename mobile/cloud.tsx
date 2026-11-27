import { useEffect, useState } from "react";
import { DeskWatch, native, secret } from "./secrets";

// Cloud agents run by the superadmin desk. The login (address + token) arrives in the desk's pairing QR (github.ts);
// nothing is typed here. Without one, the phone simply has no cloud option.
type Job = { id: string; prompt: string; status: string; agent?: string; costUsd: number; log: string[]; result?: string };
type Me = { jobs: Job[] };

const login = () => JSON.parse(secret.get("cloud.desk") || "null") as { url: string; token: string; pin: string; key?: string; cert?: string } | null;
// A login from before client certificates can't reach the desk; it shows as off until the next scan.
export const hasCloud = () => native && !!login()?.cert;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const d = login();
  if (!native || !d?.pin || !d.key || !d.cert) throw new Error("No cloud agents. Turn them on at the desk, then scan its code again.");
  const json = body ? JSON.stringify(body) : undefined;
  // DeskWatchPlugin.cloud trusts only the desk's pinned key and presents the phone's client certificate; the desk
  // hangs up on anything without one it signed. A browser preview can't do that, so it has no cloud agents.
  const r = await DeskWatch.cloud({ url: d.url + path, pin: d.pin, token: d.token, key: d.key, cert: d.cert, body: json });
  const v = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
  if (r.status < 200 || r.status >= 300) throw new Error(v.error ?? `The desk said ${r.status}`);
  return v as T;
}

// Any free agent, the desk's default model. `repo` is owner/name on GitHub.
export const startCloudJob = (prompt: string, repo?: string) => api("/user/jobs", { prompt, repo: repo ? `https://github.com/${repo}.git` : undefined });

export function CloudJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState("");
  const load = () => api<Me>("/user/me").then((m) => (setJobs(m.jobs), setErr("")), (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {err && <p className="m-muted m-pad">{err}</p>}
      {jobs.map((j) => (
        <details key={j.id} className="m-row">
          <summary>
            <b>{j.status}</b> · {j.agent ?? "waiting for an agent"} · {j.prompt.slice(0, 60)}
          </summary>
          <pre className="m-file">{j.result ?? j.log.join("\n")}</pre>
          {(j.status === "queued" || j.status === "running") && <button className="ghost" onClick={() => void api(`/user/jobs/${j.id}/cancel`, {}).then(load)}>Cancel</button>}
        </details>
      ))}
    </>
  );
}
