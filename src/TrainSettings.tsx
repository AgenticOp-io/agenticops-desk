import { useEffect, useState } from "react";

type TrainState = Awaited<ReturnType<Window["desk"]["trainState"]>>;

const STAGES: Record<string, string> = {
  setup: "Installing the training tools and the base model",
  train: "Training (about 2 hours for 2,000 examples on one L4)",
  merge: "Merging what it learned into the model",
  convert: "Converting and loading it into Ollama",
  done: "Done: pick desk-coder under Cloud GPU in the model menu",
};

export function TrainSettings() {
  const [s, setS] = useState<TrainState | null>(null);
  const [host, setHost] = useState("");
  const [leaveOut, setLeaveOut] = useState("");

  useEffect(() => {
    void window.desk.trainState().then((t) => {
      setS(t);
      setHost(t.host);
      setLeaveOut(t.leaveOut.join(", "));
    });
  }, []);

  // While this computer is reading or sending, show its progress.
  useEffect(() => {
    if (!s?.busy) return;
    const t = setInterval(() => void window.desk.trainState().then(setS), 1500);
    return () => clearInterval(t);
  }, [s?.busy]);

  const save = () => window.desk.trainSetup({ host, leaveOut: leaveOut.split(",") }).then(setS);
  const act = async (fn: () => Promise<TrainState>) => {
    await save();
    setS((p) => p && { ...p, busy: "Working" });
    setS(await fn());
  };
  const busy = Boolean(s?.busy);

  return (
    <div>
      <div className="settings-label">Train your own model</div>
      <p className="settings-hint">
        Teaches an open model (Qwen2.5-Coder 7B) from your own chats: what you asked and how the agent answered, from
        this app, the agent's transcripts and Cursor. Only the text of the conversation is used. Tool output is left
        out and passwords and keys are masked. Training runs on a GPU machine you reach over SSH, such as your Cloud
        GPU, and the result is loaded into its Ollama as <code>desk-coder</code>.
      </p>

      <div className="settings-label">GPU machine</div>
      <p className="settings-hint">
        An SSH host this computer can reach without a password prompt, with an NVIDIA GPU (24 GB or more), Python 3
        and Ollama. Start the machine first. For a Google Cloud VM, run <code>gcloud compute config-ssh</code> and use
        the name it adds. A VM without an external IP also needs a <code>ProxyCommand</code> through{" "}
        <code>gcloud compute start-iap-tunnel</code> in your SSH config.
      </p>
      <div className="provider-line">
        <input placeholder="user@host or an SSH alias" value={host} onChange={(e) => setHost(e.target.value)} onBlur={() => void save()} spellCheck={false} />
      </div>

      <div className="settings-label">Leave out chats that mention</div>
      <p className="settings-hint">Comma-separated words, such as a client's name. A chat whose folder or text contains one is skipped.</p>
      <div className="provider-line">
        <input placeholder="client name, project name" value={leaveOut} onChange={(e) => setLeaveOut(e.target.value)} onBlur={() => void save()} spellCheck={false} />
      </div>

      <div className="provider-line">
        <button className="btn" disabled={busy} onClick={() => void act(window.desk.trainPreview)}>
          Count examples
        </button>
        <button className="btn primary" disabled={busy || !host.trim()} onClick={() => void act(window.desk.trainStart)}>
          Train
        </button>
        <button className="btn" disabled={busy || !host.trim()} onClick={() => void act(window.desk.trainCheck)}>
          Check progress
        </button>
      </div>

      {s?.busy && <p className="settings-hint">{s.busy}…</p>}
      {s?.error && <p className="settings-hint error">{s.error}</p>}
      {s?.examples && (
        <p className="settings-hint">
          {s.examples.rows.toLocaleString()} examples from {s.examples.chats.toLocaleString()} chats
          {s.examples.leftOut ? `, ${s.examples.leftOut} left out` : ""} ({(s.examples.bytes / 1e6).toFixed(1)} MB).
        </p>
      )}
      {s?.remote && (
        <p className="settings-hint">
          {s.remote.stage ? (STAGES[s.remote.stage] ?? s.remote.stage) : "Not started on that machine"}
          {s.remote.running ? " (running)" : s.remote.stage && s.remote.stage !== "done" ? " (stopped: press Train to resume)" : ""}
          {s.remote.line && s.remote.stage !== "done" && (
            <>
              <br />
              <code>{s.remote.line}</code>
            </>
          )}
        </p>
      )}
    </div>
  );
}
