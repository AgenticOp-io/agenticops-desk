import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ModelOption } from "./vite-env";

type MenuNode = { key: string; label: string; value?: string; hint?: string; children?: MenuNode[] };

const DEFAULT_LABEL = "Claude Code · default model";

function buildTree(models: ModelOption[]): MenuNode[] {
  const top: MenuNode[] = [{ key: "v:", label: DEFAULT_LABEL, value: "", hint: "Whatever model your Claude sign-in uses by default" }];
  const groups = [...new Set(models.map((m) => m.group ?? "Claude Code"))];
  for (const group of groups) {
    const inGroup = models.filter((m) => (m.group ?? "Claude Code") === group);
    const leaf = (m: ModelOption): MenuNode => ({ key: `v:${m.value}`, label: m.displayName, value: m.value, hint: m.description });
    if (group === "Auto") {
      top.push(...inGroup.map(leaf));
      continue;
    }
    const children: MenuNode[] = [];
    for (const m of inGroup) {
      if (!m.family) {
        children.push(leaf(m));
        continue;
      }
      let fam = children.find((c) => c.key === `f:${group}:${m.family}`);
      if (!fam) {
        fam = { key: `f:${group}:${m.family}`, label: m.family, children: [] };
        children.push(fam);
      }
      fam.children!.push(leaf(m));
    }
    top.push({ key: `g:${group}`, label: group.replace(/^Direct · /, ""), children });
  }
  return top;
}

function holds(node: MenuNode, value: string): boolean {
  return node.value === value || Boolean(node.children?.some((c) => holds(c, value)));
}

export function modelLabel(models: ModelOption[], value: string): string {
  if (!value) return DEFAULT_LABEL;
  const m = models.find((x) => x.value === value);
  if (!m) return value;
  if (m.group === "Auto") return m.displayName;
  return `${(m.group ?? "Claude Code").replace(/^Direct · /, "")} · ${m.displayName}`;
}

export function ModelPicker(props: { models: ModelOption[]; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = button.current!.getBoundingClientRect();
    setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    setPath([]);
    setOpen(true);
  };

  const pick = (value: string) => {
    setOpen(false);
    props.onChange(value);
  };

  const list = (nodes: MenuNode[], depth: number) => (
    <div className={`model-menu${nodes.some((n) => n.children) ? "" : " leaf"}`} role="menu">
      {nodes.map((n) => {
        const current = holds(n, props.value);
        const expanded = path[depth] === n.key;
        return (
          <div key={n.key} className="model-row-wrap" onMouseEnter={() => setPath([...path.slice(0, depth), n.key])}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup={n.children ? "menu" : undefined}
              aria-expanded={n.children ? expanded : undefined}
              className={`model-row${current ? " current" : ""}${expanded && n.children ? " open" : ""}`}
              title={n.hint}
              onClick={() => (n.children ? setPath([...path.slice(0, depth), n.key]) : pick(n.value ?? ""))}
            >
              <span className="model-check">{current && !n.children ? "✓" : ""}</span>
              <span className="model-name">{n.label}</span>
              {n.children && <span className="model-arrow">›</span>}
            </button>
            {n.children && expanded && list(n.children, depth + 1)}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className="pill model-pill"
        title="Model for this chat's next message"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {modelLabel(props.models, props.value)} <span className="model-caret">▾</span>
      </button>
      {open && (
        <div ref={menu} className="model-picker" style={anchor}>
          {list(buildTree(props.models), 0)}
        </div>
      )}
    </>
  );
}
