import { useLayoutEffect, useRef } from "react";
import { Conversation } from "./Conversation";

type Msgs = Parameters<typeof Conversation>[0]["msgs"];
const nothing = () => {};

// A worker chat's live transcript, read-only, for its own window: commands, their output and replies as they arrive.
export function WorkerWatch(props: { title: string; msgs: Msgs; live: boolean; status: string; onOpen: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  return (
    <div className="chat worker-watch">
      <div className="pane-head chat-head">
        <span className="chat-title">{props.title}</span>
        {props.live && <span className="run-dot" />}
        <span className="phase">{props.status}</span>
        <button type="button" className="ghost" title="Open this worker in the main window to reply to it" onClick={props.onOpen}>
          Open chat
        </button>
      </div>
      <div
        className="messages"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <Conversation msgs={props.msgs} live={props.live} liveStatus={props.live ? props.status : undefined} onRewind={nothing} onRetry={nothing} onBranch={nothing} onReplay={nothing} />
      </div>
    </div>
  );
}
