import { useEffect, useState } from "react";
import type { ApprovalRequest, BriefingItem, Orders, WatchInfo } from "./vite-env";

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

type Card = ApprovalRequest & { chatId: string };
type Decision = { allow: boolean; always?: boolean };

// Decisions inbox: every chat's waiting permission requests and questions in one list, so you can clear
// them in one sitting while you work in another chat. Questions and plans open their chat to answer there.
export function Inbox({
  cards,
  chatTitle,
  onAnswer,
  onOpen,
  onClose,
}: {
  cards: Card[];
  chatTitle: (id: string) => string;
  onAnswer: (card: Card, decision: Decision) => void;
  onOpen: (chatId: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="inbox" aria-label="Decisions inbox">
      <div className="inbox-head">
        <strong>Decisions inbox</strong>
        <span className="grow" />
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {cards.length === 0 && <p className="settings-hint">Nothing is waiting on you.</p>}
      {cards.map((card) => {
        const needsReading = Boolean(card.questions?.length) || card.toolName === "ExitPlanMode";
        return (
          <div key={card.requestId} className="inbox-card">
            <div className="inbox-chat">{chatTitle(card.chatId)}</div>
            <div className="inbox-summary">{card.summary}</div>
            {card.reason && <div className="inbox-reason">{card.reason}</div>}
            {card.detail && <pre className="inbox-detail">{card.detail}</pre>}
            <div className="inbox-actions">
              {needsReading ? (
                <button type="button" className="btn primary" onClick={() => onOpen(card.chatId)}>
                  Open to answer
                </button>
              ) : (
                <>
                  <button type="button" className="btn danger" onClick={() => onAnswer(card, { allow: false })}>
                    Deny
                  </button>
                  <button type="button" className="btn primary" onClick={() => onAnswer(card, { allow: true })}>
                    Allow
                  </button>
                  <button type="button" className="ghost" onClick={() => onOpen(card.chatId)}>
                    Open chat
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

// Standing orders editor, shown as the "Rules" dock tab.
export function Rules({ workspace, onStatus }: { workspace: string; onStatus: (text: string) => void }) {
  const [orders, setOrders] = useState<Orders | null>(null);
  const [rules, setRules] = useState("");
  const [protect, setProtect] = useState("");
  const [checks, setChecks] = useState("");
  const [maxFixes, setMaxFixes] = useState(3);
  useEffect(() => {
    if (!workspace) return;
    void window.desk.getOrders(workspace).then((o) => {
      setOrders(o);
      setRules(o.rules.join("\n"));
      setProtect(o.protect.join("\n"));
      setChecks(o.checks.join("\n"));
      setMaxFixes(o.maxFixes);
    });
  }, [workspace]);
  const save = () =>
    void window.desk
      .setOrders(workspace, { rules: lines(rules), protect: lines(protect), checks: lines(checks), maxFixes })
      .then((o) => {
        setOrders(o);
        onStatus("Saved standing orders. They apply from the next message.");
      });
  return (
    <div className="dock-body rules">
      <p className="settings-hint">
        Standing orders for this folder. Unlike instructions, AgenticOps Desk enforces them: protected paths are refused, and a
        run that changed files is not done until every check passes (failures go back to the agent).
      </p>
      {orders?.team && (orders.team.rules.length > 0 || orders.team.protect.length > 0) && (
        <p className="settings-hint" title={[...orders.team.rules, ...orders.team.protect.map((p) => `protected: ${p}`)].join("\n")}>
          Also applied from this repo's .agenticops/orders.json: {orders.team.rules.length} rule
          {orders.team.rules.length === 1 ? "" : "s"}, {orders.team.protect.length} protected path
          {orders.team.protect.length === 1 ? "" : "s"}. Edit that file to change them for the whole team.
        </p>
      )}
      <label className="rules-field">
        <span>Rules (one per line, added to every run)</span>
        <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} placeholder="No new dependencies without asking" />
      </label>
      <label className="rules-field">
        <span>Protected paths (one per line; edits are refused)</span>
        <textarea value={protect} onChange={(e) => setProtect(e.target.value)} rows={3} placeholder={"migrations/**\n*.lock\n.github/**"} spellCheck={false} />
      </label>
      <label className="rules-field">
        <span>Checks that must pass (one command per line)</span>
        <textarea value={checks} onChange={(e) => setChecks(e.target.value)} rows={3} placeholder={"npx tsc --noEmit\nnpm test"} spellCheck={false} />
      </label>
      <div className="dock-row">
        <label className="rules-inline">
          Fix attempts before giving up
          <input type="number" min={0} max={10} value={maxFixes} onChange={(e) => setMaxFixes(Number(e.target.value))} />
        </label>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={!orders} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<BriefingItem["state"], string> = {
  waiting: "Waiting on you",
  running: "Still working",
  error: "Stopped with an error",
  done: "Finished",
};

// "While you were away": where every recent chat stands.
export function Briefing({ items, onOpen, onClose }: { items: BriefingItem[]; onOpen: (chatId: string) => void; onClose: () => void }) {
  const order = { waiting: 0, error: 1, running: 2, done: 3 };
  const sorted = [...items].sort((a, b) => order[a.state] - order[b.state] || b.lastUsedAt - a.lastUsedAt);
  return (
    <div className="modal" onClick={onClose}>
      <div className="briefing" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <strong>While you were away</strong>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {sorted.length === 0 && <p className="settings-hint">No chats were active recently.</p>}
        {sorted.map((it) => (
          <button key={it.chatId} type="button" className={`brief-row state-${it.state}`} onClick={() => onOpen(it.chatId)}>
            <span className="brief-top">
              <strong>{it.title}</strong>
              <span className="brief-state">{STATE_LABEL[it.state]}</span>
            </span>
            <span className="brief-meta">
              {it.project && `${it.project} · `}
              {ago(it.lastUsedAt)}
              {it.changes ? ` · ${it.changes} changed file${it.changes === 1 ? "" : "s"} not reviewed` : ""}
            </span>
            {it.asked && <span className="brief-asked">You: {it.asked}</span>}
            {it.answer && <span className="brief-answer">{it.answer}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Watched log files for the active chat, shown in its header.
export function WatchChips({ chatId, watches, onChange }: { chatId: string; watches: WatchInfo[]; onChange: (w: WatchInfo[]) => void }) {
  return (
    <>
      {watches.map((w) => (
        <span key={w.file} className="watch-chip" title={`Watching ${w.file} for errors; this chat reacts when one appears`}>
          ◉ {w.file.split(/[\\/]/).pop()}
          <button type="button" title="Stop watching" onClick={() => void window.desk.removeWatch(chatId, w.file).then(onChange)}>
            ×
          </button>
        </span>
      ))}
    </>
  );
}

// A chat's own git worktree: off by default. On, the chat edits a copy on its own branch until Merge.
export function WorktreeChip({ chatId, folder, running, onNote }: { chatId: string; folder: string; running: boolean; onNote: (text: string) => void }) {
  const [tree, setTree] = useState<{ path: string; branch: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setTree(null);
    if (folder) void window.desk.worktreeGet(chatId, folder).then((t) => alive && setTree(t));
    return () => {
      alive = false;
    };
  }, [chatId, folder]);
  if (!folder) return null;
  const act = (job: () => Promise<void>) => {
    setBusy(true);
    void job().finally(() => setBusy(false));
  };
  if (!tree) {
    return (
      <button
        type="button"
        className="ghost"
        disabled={running || busy}
        title="Run this chat in its own git worktree and branch, so other chats in this repository don't edit the same files"
        onClick={() =>
          act(async () => {
            const made = await window.desk.worktreeCreate(chatId, folder);
            if (typeof made === "string") onNote(made);
            else {
              setTree(made);
              onNote(`This chat now works on ${made.branch}`);
            }
          })
        }
      >
        Own worktree
      </button>
    );
  }
  return (
    <span className="watch-chip" title={`Edits go to ${tree.path} on branch ${tree.branch}`}>
      ⑂ {tree.branch}
      <button
        type="button"
        disabled={running || busy}
        title="Commit this chat's changes and merge its branch into the main folder"
        onClick={() => act(async () => onNote((await window.desk.worktreeMerge(chatId)).note))}
      >
        Merge
      </button>
      <button
        type="button"
        disabled={running || busy}
        title="Remove the worktree and its branch"
        onClick={() =>
          act(async () => {
            const result = await window.desk.worktreeRemove(chatId);
            if (result.note) onNote(result.note);
            if (result.ok) setTree(null);
          })
        }
      >
        ×
      </button>
    </span>
  );
}

// The "why" line for an open file: which instruction last changed it, and from which chat.
export function OriginLine({ file, onOpen }: { file: string; onOpen: (chatId: string) => void }) {
  const [origin, setOrigin] = useState<{ chatId: string; prompt: string; at: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void window.desk.originsOf(file).then((list) => {
      if (alive) setOrigin(list[0] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [file]);
  if (!origin?.prompt) return null;
  return (
    <button type="button" className="origin-line" title={origin.prompt} onClick={() => onOpen(origin.chatId)}>
      Why: “{origin.prompt.length > 120 ? `${origin.prompt.slice(0, 119)}…` : origin.prompt}” · {ago(origin.at)}
    </button>
  );
}
