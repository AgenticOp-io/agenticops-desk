import { useState } from "react";

type Review = Awaited<ReturnType<typeof window.desk.reviewCursorRemoval>>;

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.ceil(bytes / 1e6)} MB`);

// Deleting is opt-in: nothing here runs until the user reviews the list and confirms it.
export function CursorFolders() {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = async () => {
    setBusy(true);
    setReview(await window.desk.reviewCursorRemoval());
    setBusy(false);
  };

  return (
    <>
      <div className="settings-label">Cursor folders</div>
      <p className="settings-hint">
        Your Cursor chats and agent files are copied here and Cursor's folders are left as they were. You can delete those folders
        to free disk space. Your project folders are never touched.
      </p>
      {!review && (
        <div className="signin-row">
          <button type="button" className="ghost" disabled={busy} onClick={() => void load()}>
            {busy ? "Measuring…" : "Review what could be deleted"}
          </button>
        </div>
      )}
      {review && (
        <>
          {review.report && (
            <p className="settings-hint">
              {review.report.converted + review.report.recovered + review.report.already} of {review.report.chats} chats are stored here.
              {review.report.recovered ? ` ${review.report.recovered} had only your own messages left to recover.` : ""}
              {review.report.empty ? ` ${review.report.empty} had no messages left in Cursor, so only their titles remain.` : ""}
            </p>
          )}
          {review.folders.map((folder) => (
            <div className="dock-row" key={folder.path}>
              <span>{folder.path}</span>
              <span>{size(folder.bytes)}</span>
            </div>
          ))}
          {review.keep && <p className="settings-hint">{review.keep} is kept: it holds code, so check it yourself.</p>}
          <p className="settings-hint">
            This cannot be undone. Cursor loses its settings, extensions, sign-in and chat history, and it has to be closed first.
            Copies of your chats, agent files and Cursor's databases stay in {review.archive}.
          </p>
          {review.folders.length > 0 && (
            <div className="signin-row">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void window.desk.removeCursorFolders().then(async (result) => {
                    if (result) {
                      setNote([result.note, ...result.failed].join(" "));
                      setReview(await window.desk.reviewCursorRemoval());
                    }
                    setBusy(false);
                  });
                }}
              >
                Delete Cursor's folders…
              </button>
            </div>
          )}
        </>
      )}
      {note && <p className="settings-hint">{note}</p>}
    </>
  );
}
