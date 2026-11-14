import { useEffect, useState } from "react";
import type { ActivityEvent } from "./vite-env";

const KIND_LABEL: Record<ActivityEvent["kind"], string> = {
  run: "Run",
  tool: "Tool",
  git: "Git",
  approval: "Approval",
  error: "Error",
  system: "System",
};

const OUTCOME_LABEL: Record<ActivityEvent["outcome"], string> = {
  started: "started",
  ok: "ok",
  failed: "failed",
  denied: "denied",
  info: "info",
};

function ago(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// The activity log: a read-only timeline of what the desk has done (runs, git, approvals, errors). No prompts,
// replies or secrets are stored, only labels and outcomes.
export function ActivityLog() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.desk.activityReport().then((rows) => {
      if (!alive) return;
      setEvents(rows);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <p className="settings-hint">Reading activity…</p>;
  if (!events.length) return <p className="settings-hint">No activity yet. Runs, git operations, approvals and errors will appear here.</p>;

  return (
    <div className="activity-log">
      {events.map((e, i) => (
        <div key={`${e.at}-${i}`} className={`activity-row outcome-${e.outcome}`}>
          <span className="activity-time">{ago(e.at)}</span>
          <span className="activity-kind">{KIND_LABEL[e.kind]}</span>
          <span className="activity-action">{e.action ?? ""}</span>
          <span className="activity-outcome">{OUTCOME_LABEL[e.outcome]}</span>
          {e.title && <span className="activity-title" title={e.title}>{e.title}</span>}
          {e.model && <span className="activity-model">{e.model}</span>}
          {e.note && <span className="activity-note" title={e.note}>{e.note}</span>}
        </div>
      ))}
    </div>
  );
}
