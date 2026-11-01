import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

// Renders the rows that are on screen. Short lists render in full so drag targets stay put.
export function Windowed<T>({
  items,
  heightOf,
  keyOf,
  className,
  overscan = 8,
  min = 48,
  onContextMenu,
  children,
}: {
  items: T[];
  heightOf: (item: T) => number;
  keyOf: (item: T) => string;
  className?: string;
  overscan?: number;
  min?: number;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  children: (item: T, index: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState({ start: 0, end: min });
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + heightOf(items[i]);
    return out;
  }, [items, heightOf]);

  useEffect(() => {
    const el = ref.current;
    if (!el || items.length < min) return;
    const measure = () => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1] <= top) lo = mid + 1;
        else hi = mid;
      }
      const start = Math.max(0, lo - overscan);
      lo = start;
      hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < bottom) lo = mid + 1;
        else hi = mid;
      }
      const end = Math.min(items.length, lo + overscan);
      setSpan((cur) => (cur.start === start && cur.end === end ? cur : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [offsets, items.length, min, overscan]);

  if (items.length < min) {
    return (
      <div className={className} onContextMenu={onContextMenu}>
        {items.map((item, index) => (
          <div key={keyOf(item)} className="tree-slot" style={{ height: heightOf(item) }}>
            {children(item, index)}
          </div>
        ))}
      </div>
    );
  }

  const start = Math.min(span.start, items.length);
  const end = Math.min(Math.max(span.end, start), items.length);
  return (
    <div ref={ref} className={className} onContextMenu={onContextMenu}>
      <div style={{ height: offsets[items.length] ?? 0, position: "relative" }}>
        <div style={{ position: "absolute", top: offsets[start] ?? 0, left: 0, right: 0 }}>
          {items.slice(start, end).map((item, index) => (
            <div key={keyOf(item)} className="tree-slot" style={{ height: heightOf(item) }}>
              {children(item, start + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
