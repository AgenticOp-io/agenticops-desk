import { useEffect, useState } from "react";
import type { PlanLimits, ProviderStatus, UsageReport, UsageRow, UsageTally } from "./vite-env";

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const tokens = (t: UsageTally) => t.input + t.output + t.cacheRead + t.cacheWrite;
const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

function resetsIn(at: number | null) {
  if (!at) return "";
  const ms = at - Date.now();
  if (ms <= 0) return "resets now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  const when = new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return h >= 24 ? `resets ${when}` : `resets in ${h ? `${h}h ` : ""}${m}m (${when})`;
}

function Bar({ percent }: { percent: number | null }) {
  const p = percent ?? 0;
  return (
    <span className="limit-bar" aria-label={percent === null ? "unknown" : `${Math.round(p)}% used`}>
      <span className={p >= 90 ? "hot" : p >= 70 ? "warm" : ""} style={{ width: `${p}%` }} />
    </span>
  );
}

// Tokens per day for the last two weeks, oldest on the left.
function Spark({ daily }: { daily: number[] }) {
  const max = Math.max(1, ...daily);
  return (
    <span className="spark" title={daily.map((n, i) => `${daily.length - 1 - i === 0 ? "today" : `${daily.length - 1 - i}d ago`}: ${compact(n)}`).join("\n")}>
      {daily.map((n, i) => (
        <span key={i} style={{ height: `${Math.max(n ? 8 : 0, (n / max) * 100)}%` }} />
      ))}
    </span>
  );
}

function Totals({ rows }: { rows: UsageRow[] }) {
  const sum = (pick: (r: UsageRow) => UsageTally) => rows.reduce((a, r) => ({ t: a.t + tokens(pick(r)), c: a.c + pick(r).costUsd }), { t: 0, c: 0 });
  const cells = [
    { label: "Today", ...sum((r) => r.today) },
    { label: "7 days", ...sum((r) => r.week) },
    { label: "30 days", ...sum((r) => r.month) },
  ];
  return (
    <div className="usage-totals">
      {cells.map((c) => (
        <div key={c.label}>
          <span>{c.label}</span>
          <strong>{compact(c.t)}</strong>
          {c.c > 0 && <em>{money(c.c)}</em>}
        </div>
      ))}
    </div>
  );
}

function ModelTable({ rows, priced }: { rows: UsageRow[]; priced: boolean }) {
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Last 14 days</th>
          <th>Today</th>
          <th>30 days</th>
          {priced && <th>Cost, 30 days</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.model} title={`30 days: ${r.month.input.toLocaleString()} input, ${r.month.cacheRead.toLocaleString()} cache read, ${r.month.cacheWrite.toLocaleString()} cache write, ${r.month.output.toLocaleString()} output, ${r.month.calls} calls`}>
            <td>{r.model}</td>
            <td>
              <Spark daily={r.daily} />
            </td>
            <td>{compact(tokens(r.today))}</td>
            <td>{compact(tokens(r.month))}</td>
            {priced && <td>{r.month.costUsd ? money(r.month.costUsd) : "—"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanCard({ plan, onRefresh, busy, error }: { plan: PlanLimits | null; onRefresh: () => void; busy: boolean; error: string }) {
  const windows = [...(plan?.windows ?? [])].sort((a, b) => (a.id === "five_hour" ? -1 : b.id === "five_hour" ? 1 : a.label.localeCompare(b.label)));
  return (
    <div className="usage-plan">
      <div className="provider-head">
        <strong>Plan limits{plan?.subscription ? ` · ${plan.subscription[0].toUpperCase()}${plan.subscription.slice(1)}` : ""}</strong>
        <button className="btn" disabled={busy} onClick={onRefresh}>
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      {windows.map((w) => (
        <div key={w.id} className="limit-row">
          <span className="limit-name">{w.label}</span>
          <Bar percent={w.percent} />
          <span className="limit-pct">{w.percent === null ? "—" : `${Math.round(w.percent)}%`}</span>
          <span className="limit-reset">{resetsIn(w.resetsAt)}</span>
        </div>
      ))}
      {!windows.length && !plan?.note && <p className="settings-hint">No reading yet. Refresh asks the engine; it does not send anything to the model.</p>}
      {plan?.note && <p className="settings-hint">{plan.note}</p>}
      {plan?.updatedAt ? <p className="settings-hint">Checked {new Date(plan.updatedAt).toLocaleString()}.</p> : null}
      {error && <p className="settings-hint">{error}</p>}
    </div>
  );
}

export function UsageSettings() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await window.desk.refreshPlanLimits();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setReport(await window.desk.usageReport());
      setBusy(false);
    }
  };

  useEffect(() => {
    void window.desk.usageReport().then((r) => {
      setReport(r);
      // A reading older than ten minutes is refreshed when the page opens.
      if (!r.plan || Date.now() - r.plan.updatedAt > 10 * 60_000) void refresh();
    });
    void window.desk.listProviders().then(setProviders);
  }, []);

  if (!report) return <p className="settings-hint">Loading usage…</p>;
  const rowsFor = (source: string) => report.rows.filter((r) => r.source === source);
  const sources = [
    { id: "claude-code", label: "Claude Code", sub: "Your Claude sign-in", priced: true, ready: true },
    ...providers.map((p) => ({ id: p.id, label: p.label, sub: "Direct · API key", priced: p.id === "anthropic", ready: p.ready })),
  ];
  const known = new Set(sources.map((s) => s.id));
  for (const r of report.rows) if (!known.has(r.source)) {
    known.add(r.source);
    sources.push({ id: r.source, label: r.source, sub: "Direct", priced: false, ready: false });
  }

  return (
    <div className="usage-page">
      <div className="settings-label">Usage</div>
      <p className="settings-hint">
        Tokens used on this computer by each engine and provider, counted as runs finish. Costs for Claude Code are the engine's own estimate;
        Claude API costs use list prices. Other providers report tokens but not prices.
      </p>
      {sources.map((s) => {
        const rows = rowsFor(s.id);
        if (!rows.length && !s.ready) return null;
        return (
          <div key={s.id} className={`provider ${s.ready ? "ready" : ""}`}>
            <div className="provider-head">
              <strong>{s.label}</strong>
              <span className="provider-state">{s.sub}</span>
            </div>
            {s.id === "claude-code" && <PlanCard plan={report.plan} onRefresh={() => void refresh()} busy={busy} error={error} />}
            {rows.length ? (
              <>
                <Totals rows={rows} />
                <ModelTable rows={rows} priced={s.priced} />
              </>
            ) : (
              <p className="settings-hint">Not used in the last 30 days.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
