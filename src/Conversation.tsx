import { memo, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown";

export type TranscriptPart = { kind: "text"; text: string } | { kind: "step"; text: string };
export type TranscriptMsg = {
  role: "user" | "assistant" | "system" | "error";
  text: string;
  steer?: boolean;
  parts?: TranscriptPart[];
};

const STEP_CAP = 80;

export function appendStep(msgs: TranscriptMsg[], text: string): TranscriptMsg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    const parts = last.parts ?? (last.text ? [{ kind: "text" as const, text: last.text }] : []);
    const prev = parts[parts.length - 1];
    if (prev?.kind === "step" && prev.text === text) return msgs;
    return [...msgs.slice(0, -1), { ...last, parts: capSteps([...parts, { kind: "step", text }]) }];
  }
  return [...msgs, { role: "assistant", text: "", parts: [{ kind: "step", text }] }];
}

export function appendText(msgs: TranscriptMsg[], chunk: string): TranscriptMsg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") {
    const parts = last.parts ? [...last.parts] : last.text ? [{ kind: "text" as const, text: last.text }] : [];
    const prev = parts[parts.length - 1];
    if (prev?.kind === "text") parts[parts.length - 1] = { kind: "text", text: prev.text + chunk };
    else parts.push({ kind: "text", text: chunk });
    return [...msgs.slice(0, -1), { ...last, text: last.text + chunk, parts }];
  }
  return [...msgs, { role: "assistant", text: chunk, parts: [{ kind: "text", text: chunk }] }];
}

function capSteps(parts: TranscriptPart[]): TranscriptPart[] {
  let steps = 0;
  for (const part of parts) if (part.kind === "step") steps += 1;
  if (steps <= STEP_CAP) return parts;
  let drop = steps - STEP_CAP;
  return parts.filter((part) => {
    if (part.kind === "step" && drop > 0) {
      drop -= 1;
      return false;
    }
    return true;
  });
}

type Step = { text: string };
type Piece =
  | { kind: "steps"; steps: Step[] }
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
          else if (part.text) open().pieces.push({ kind: "text", text: part.text });
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
  const shown = opened ? steps.slice(-8) : [];
  const earlier = steps.length - shown.length;
  const status = live && liveStatus && liveStatus !== steps[steps.length - 1]?.text ? liveStatus : "";
  return (
    <div className={`work ${opened ? "open" : ""} ${live ? "live" : ""}`}>
      <button type="button" className="work-toggle" onClick={() => setOpened((value) => !value)}>
        <span className="work-caret" aria-hidden>{opened ? "▾" : "▸"}</span>
        <span>{steps.length === 0 ? status || "Working" : workLabel(steps)}</span>
      </button>
      {opened && (shown.length > 0 || status) && (
        <ol className="work-list">
          {earlier > 0 && <li className="work-earlier">{earlier} earlier</li>}
          {shown.map((step, index) => (
            <li key={`${step.text}-${index}`} className={!status && index === shown.length - 1 ? "current" : ""}>
              {step.text}
            </li>
          ))}
          {status && <li className="current">{status}</li>}
        </ol>
      )}
    </div>
  );
}

const PAGE = 12;

function turnSignature(turn: Turn) {
  const bits = [String(turn.promptIndex ?? ""), String(turn.prompt?.length ?? 0)];
  for (const piece of turn.pieces) {
    if (piece.kind === "text") bits.push("t", String(piece.text.length), piece.text.slice(-32));
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
}: {
  turn: Turn;
  live: boolean;
  liveStatus?: string;
  onRewind: (index: number) => void;
  onRetry: (index: number) => void;
  onBranch: (index: number) => void;
}) {
  const waiting = live && turn.pieces.every((piece) => piece.kind !== "steps" && piece.kind !== "text");
  return (
    <section className={`turn ${live ? "live" : ""}`}>
      {turn.prompt !== undefined && turn.promptIndex !== undefined && (
        <div className="bubble user turn-prompt">
          <ChatMarkdown text={turn.prompt} />
          <div className="msg-actions">
            <button type="button" onClick={() => onRewind(turn.promptIndex!)}>Rewind</button>
            <button type="button" onClick={() => onRetry(turn.promptIndex!)}>Retry</button>
            <button type="button" onClick={() => onBranch(turn.promptIndex!)}>Branch</button>
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
          <div key={`note-${pieceIndex}`} className="bubble system">
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
}: {
  msgs: TranscriptMsg[];
  live: boolean;
  liveStatus?: string;
  onRewind: (index: number) => void;
  onRetry: (index: number) => void;
  onBranch: (index: number) => void;
}) {
  const turns = buildTurns(msgs);
  const [shown, setShown] = useState(PAGE);
  const handlers = useRef({ onRewind, onRetry, onBranch });
  handlers.current = { onRewind, onRetry, onBranch };
  const call = useRef({
    rewind: (index: number) => handlers.current.onRewind(index),
    retry: (index: number) => handlers.current.onRetry(index),
    branch: (index: number) => handlers.current.onBranch(index),
  });
  useEffect(() => {
    setShown((count) => (count >= turns.length - 1 ? turns.length : count));
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
          />
        );
      })}
    </>
  );
}
