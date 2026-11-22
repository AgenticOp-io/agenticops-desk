import { memo, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { roundsToShow } from "./sideChats";
import { type TranscriptMsg } from "./transcript";

export type { TranscriptMsg, TranscriptPart } from "./transcript";
export { appendStep, appendText, appendThinking } from "./transcript";

type Step = { text: string };
type Piece =
  | { kind: "steps"; steps: Step[] }
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string }
  | { kind: "steer"; text: string; index: number }
  | { kind: "error"; text: string }
  | { kind: "note"; text: string };

type Turn = { prompt?: string; promptIndex?: number; pieces: Piece[] };

function buildTurns(msgs: TranscriptMsg[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  const open = () => {
    if (!turn) {
      turn = { pieces: [] };
      turns.push(turn);
    }
    return turn;
  };
  const pushStep = (text: string) => {
    const current = open();
    const last = current.pieces[current.pieces.length - 1];
    if (last?.kind === "steps") {
      if (last.steps[last.steps.length - 1]?.text === text) return;
      last.steps.push({ text });
      return;
    }
    current.pieces.push({ kind: "steps", steps: [{ text }] });
  };
  msgs.forEach((msg, index) => {
    if (msg.role === "user" && !msg.steer) {
      turn = { prompt: msg.text, promptIndex: index, pieces: [] };
      turns.push(turn);
      return;
    }
    if (msg.role === "user" && msg.steer) {
      open().pieces.push({ kind: "steer", text: msg.text, index });
      return;
    }
    if (msg.role === "system" && /^[▸►]\s/.test(msg.text)) {
      pushStep(msg.text.replace(/^[▸►]\s*/, ""));
      return;
    }
    if (msg.role === "assistant") {
      if (msg.parts?.length) {
        for (const part of msg.parts) {
          if (part.kind === "step") pushStep(part.text);
          else if (part.kind === "thinking") {
            if (part.text) open().pieces.push({ kind: "thought", text: part.text });
          } else if (part.text) open().pieces.push({ kind: "text", text: part.text });
        }
      } else if (msg.text) {
        open().pieces.push({ kind: "text", text: msg.text });
      }
      return;
    }
    if (msg.role === "error") open().pieces.push({ kind: "error", text: msg.text });
    else if (msg.text) open().pieces.push({ kind: "note", text: msg.text });
  });
  return turns;
}

function workLabel(steps: Step[]): string {
  if (steps.length === 0) return "Working";
  if (steps.length === 1) return steps[0].text;
  const counts = new Map<string, number>();
  for (const step of steps) {
    const verb = step.text.split(" ")[0] || "Did";
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, 3)
    .map(([verb, count]) => `${verb} ${count}`)
    .join(" · ");
}

function Work({ steps, live, liveStatus }: { steps: Step[]; live: boolean; liveStatus?: string }) {
  const [opened, setOpened] = useState(live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) setOpened(true);
    if (!live && wasLive.current) setOpened(false);
    wasLive.current = live;
  }, [live]);
  // One step is already the header's label; listing it again would duplicate it.
  const shown = opened && steps.length !== 1 ? steps.slice(-8) : [];
  const earlier = steps.length === 1 ? 0 : steps.length - shown.length;
  const status = live && liveStatus && liveStatus !== steps[steps.length - 1]?.text ? liveStatus : "";
  // With no steps the header already shows the status; listing it again would duplicate it.
  const listStatus = steps.length === 0 ? "" : status;
  return (
    <div className={`work ${opened ? "open" : ""} ${live ? "live" : ""}`}>
      <button type="button" className="work-toggle" onClick={() => setOpened((value) => !value)}>
        <span className="work-caret" aria-hidden>{opened ? "▾" : "▸"}</span>
        <span>{steps.length === 0 ? status || "Working" : workLabel(steps)}</span>
      </button>
      {opened && (shown.length > 0 || listStatus) && (
        <ol className="work-list">
          {earlier > 0 && <li className="work-earlier">{earlier} earlier</li>}
          {shown.map((step, index) => (
            <li key={`${step.text}-${index}`} className={!status && index === shown.length - 1 ? "current" : ""}>
              {step.text}
            </li>
          ))}
          {listStatus && <li className="current">{listStatus}</li>}
        </ol>
      )}
    </div>
  );
}

function Thought({ text, live }: { text: string; live: boolean }) {
  const [opened, setOpened] = useState(live);
  const wasLive = useRef(live);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && !wasLive.current) setOpened(true);
    if (!live && wasLive.current) setOpened(false);
    wasLive.current = live;
  }, [live]);
  useEffect(() => {
    const el = body.current;
    if (live && opened && el) el.scrollTop = el.scrollHeight;
  }, [text, live, opened]);
  return (
    <div className={`thought ${live ? "live" : ""}`}>
      <button type="button" className="work-toggle" onClick={() => setOpened((value) => !value)}>
        <span className="work-caret" aria-hidden>{opened ? "▾" : "▸"}</span>
        <span>{live ? "Thinking" : "Thought"}</span>
      </button>
      {opened && (
        <div className="thought-body" ref={body}>
          {text}
        </div>
      )}
    </div>
  );
}

const PAGE = 12;

function turnSignature(turn: Turn) {
  const bits = [String(turn.promptIndex ?? ""), String(turn.prompt?.length ?? 0)];
  for (const piece of turn.pieces) {
    if (piece.kind === "text") bits.push("t", String(piece.text.length), piece.text.slice(-32));
    else if (piece.kind === "thought") bits.push("h", String(piece.text.length), piece.text.slice(-32));
    else if (piece.kind === "steps") bits.push("s", String(piece.steps.length), piece.steps[piece.steps.length - 1]?.text ?? "");
    else if (piece.kind === "steer") bits.push("g", String(piece.index), String(piece.text.length));
    else bits.push(piece.kind, String(piece.text.length), piece.text.slice(-32));
  }
  return bits.join("|");
}

const TurnView = memo(function TurnView({
  turn,
  live,
  liveStatus,
  onRewind,
  onRetry,
  onBranch,
  onReplay,
}: {
  turn: Turn;
  live: boolean;
  liveStatus?: string;
  onRewind: (index: number) => void;
  onRetry: (index: number) => void;
  onBranch: (index: number) => void;
  onReplay: (index: number) => void;
}) {
  const waiting = live && turn.pieces.every((piece) => piece.kind !== "steps" && piece.kind !== "text" && piece.kind !== "thought");
  return (
    <section className={`turn ${live ? "live" : ""}`}>
      {turn.prompt !== undefined && turn.promptIndex !== undefined && (
        <div className="bubble user turn-prompt">
          <ChatMarkdown text={turn.prompt} />
          <div className="msg-actions">
            <button type="button" onClick={() => onRewind(turn.promptIndex!)}>Rewind</button>
            <button type="button" onClick={() => onRetry(turn.promptIndex!)}>Retry</button>
            <button type="button" onClick={() => onBranch(turn.promptIndex!)}>Branch</button>
            <button type="button" title="Run this request again on another model, in a branch, to compare" onClick={() => onReplay(turn.promptIndex!)}>Replay on…</button>
          </div>
        </div>
      )}
      {turn.pieces.map((piece, pieceIndex) => {
        const trailing = pieceIndex === turn.pieces.length - 1;
        if (piece.kind === "steps") {
          return (
            <Work
              key={`steps-${pieceIndex}`}
              steps={piece.steps}
              live={live && trailing}
              liveStatus={live && trailing ? liveStatus : undefined}
            />
          );
        }
        if (piece.kind === "thought") {
          return <Thought key={`thought-${pieceIndex}`} text={piece.text} live={live && trailing} />;
        }
        if (piece.kind === "text") {
          return (
            <div key={`text-${pieceIndex}`} className="bubble assistant">
              <ChatMarkdown text={piece.text} />
            </div>
          );
        }
        if (piece.kind === "steer") {
          return (
            <div key={`steer-${piece.index}`} className="steer bubble">
              <span>Added while it worked</span>
              <ChatMarkdown text={piece.text} />
            </div>
          );
        }
        if (piece.kind === "error") {
          return (
            <div key={`error-${pieceIndex}`} className="bubble error">
              {piece.text}
            </div>
          );
        }
        return (
          <div key={`note-${pieceIndex}`} className={`bubble system ${piece.text.startsWith("Second opinion") ? "second-opinion" : ""}`}>
            {piece.text}
          </div>
        );
      })}
      {waiting && <Work steps={[]} live liveStatus={liveStatus} />}
    </section>
  );
}, (prev, next) => prev.live === next.live && prev.liveStatus === next.liveStatus && turnSignature(prev.turn) === turnSignature(next.turn));

export function Conversation({
  msgs,
  live,
  liveStatus,
  onRewind,
  onRetry,
  onBranch,
  onReplay,
}: {
  msgs: TranscriptMsg[];
  live: boolean;
  liveStatus?: string;
  onRewind: (index: number) => void;
  onRetry: (index: number) => void;
  onBranch: (index: number) => void;
  onReplay: (index: number) => void;
}) {
  const turns = buildTurns(msgs);
  const [shown, setShown] = useState(PAGE);
  const handlers = useRef({ onRewind, onRetry, onBranch, onReplay });
  handlers.current = { onRewind, onRetry, onBranch, onReplay };
  const call = useRef({
    rewind: (index: number) => handlers.current.onRewind(index),
    retry: (index: number) => handlers.current.onRetry(index),
    branch: (index: number) => handlers.current.onBranch(index),
    replay: (index: number) => handlers.current.onReplay(index),
  });
  useEffect(() => {
    setShown((count) => roundsToShow(count, turns.length, PAGE));
  }, [turns.length]);
  const start = Math.max(0, turns.length - shown);
  const hidden = start;
  return (
    <>
      {hidden > 0 && (
        <button type="button" className="earlier" onClick={() => setShown((count) => count + PAGE)}>
          {hidden} earlier {hidden === 1 ? "round" : "rounds"}
        </button>
      )}
      {turns.slice(start).map((turn, offset) => {
        const turnIndex = start + offset;
        const last = turnIndex === turns.length - 1;
        return (
          <TurnView
            key={turn.promptIndex ?? `loose-${turnIndex}`}
            turn={turn}
            live={live && last}
            liveStatus={live && last ? liveStatus : undefined}
            onRewind={call.current.rewind}
            onRetry={call.current.retry}
            onBranch={call.current.branch}
            onReplay={call.current.replay}
          />
        );
      })}
    </>
  );
}
