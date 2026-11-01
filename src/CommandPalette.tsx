import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteAction = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? actions.filter((a) => `${a.label} ${a.hint ?? ""}`.toLowerCase().includes(needle)) : actions;
  }, [actions, q]);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    setIndex(0);
  }, [q]);

  return (
    <div className="modal" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Run a command…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, Math.max(0, shown.length - 1)));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const hit = shown[index];
              if (hit) {
                hit.run();
                onClose();
              }
            }
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="palette-list">
          {shown.map((a, i) => (
            <button
              key={a.id}
              className={`list-item ${i === index ? "active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                a.run();
                onClose();
              }}
            >
              <span className="list-title">{a.label}</span>
              {a.hint && <span className="list-sub">{a.hint}</span>}
            </button>
          ))}
          {shown.length === 0 && <div className="bubble system">No command matches that.</div>}
        </div>
      </div>
    </div>
  );
}
