import { useEffect, useState } from "react";
import type { CleanupProposal } from "./vite-env";

// Offers to merge projects that look like one project in two places. Nothing changes until Merge is pressed.
export function ProjectCleanup({ onDone }: { onDone: () => void }) {
  const [plan, setPlan] = useState<CleanupProposal[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    window.desk.projectCleanupPlan().then((rows) => {
      setPlan(rows);
      // A live folder may be a separate copy, so those start unticked.
      setPicked(new Set(rows.filter((row) => !row.bothExist).map((row) => row.from.id)));
    });

  useEffect(() => {
    void load();
  }, []);

  if (!plan.length && !note) return null;
  return (
    <>
      <div className="settings-label">Project cleanup</div>
      <p className="settings-hint">
        These look like one project in two places. Tick the ones to merge: the chats move into the second folder, and the first
        one stops being its own project. Chats themselves are not changed, and a copy of the list is saved first.
      </p>
      {plan.map((row) => (
        <label className="cleanup-row" key={row.from.id}>
          <input
            type="checkbox"
            checked={picked.has(row.from.id)}
            onChange={(e) =>
              setPicked((cur) => {
                const next = new Set(cur);
                if (e.target.checked) next.add(row.from.id);
                else next.delete(row.from.id);
                return next;
              })
            }
          />
          <span title={`${row.from.path} → ${row.to.path}`}>
            {row.from.path} ({row.from.chats} chat{row.from.chats === 1 ? "" : "s"}
            {row.bothExist ? ", folder still there" : ", folder gone"}) → {row.to.path} ({row.to.chats})
          </span>
        </label>
      ))}
      {plan.length > 0 && (
        <div className="signin-row">
          <button
            type="button"
            className="btn"
            disabled={busy || picked.size === 0}
            onClick={() => {
              setBusy(true);
              const merges = plan.filter((row) => picked.has(row.from.id)).map((row) => ({ from: row.from.id, to: row.to.id }));
              void window.desk.applyProjectCleanup(merges).then(async (result) => {
                setNote(`Moved ${result.moved} chat${result.moved === 1 ? "" : "s"}. The list from before is saved at ${result.backup}.`);
                await load();
                setBusy(false);
                onDone();
              });
            }}
          >
            Merge selected
          </button>
        </div>
      )}
      {note && <p className="settings-hint">{note}</p>}
    </>
  );
}
