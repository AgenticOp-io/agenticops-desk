import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type Look = { theme: string; style: CSSProperties };

// Renders children in their own OS window. React state stays in this window, so the
// panel stays live. With windowed off, or if the window can't open, it shows in the app:
// as a modal, or in place when modal is false.
export function PopOut(props: {
  name: string;
  title: string;
  width: number;
  height: number;
  look: Look;
  onClose: () => void;
  children: ReactNode;
  windowed?: boolean;
  modal?: boolean;
}) {
  const { windowed = true, modal = true, onClose, children } = props;
  if (windowed) return <Window {...props} />;
  return modal ? (
    <div className="modal" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  ) : (
    <>{children}</>
  );
}

function Window({
  name,
  title,
  width,
  height,
  look,
  onClose,
  children,
  modal = true,
}: {
  name: string;
  title: string;
  width: number;
  height: number;
  look: Look;
  onClose: () => void;
  children: ReactNode;
  modal?: boolean;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // main.ts only lets "desk-popout-" windows open.
    const w = window.open("", `desk-popout-${name}`, `width=${width},height=${height}`);
    if (!w) {
      setFailed(true);
      return;
    }
    const doc = w.document;
    doc.title = title;
    for (const node of document.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')) {
      const copy = node.cloneNode(true) as HTMLElement;
      if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href;
      doc.head.appendChild(copy);
    }
    const root = doc.createElement("div");
    root.id = "root";
    doc.body.appendChild(root);
    setHost(root);
    const gone = () => closeRef.current();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    w.addEventListener("pagehide", gone);
    w.addEventListener("keydown", esc);
    w.focus();
    return () => {
      w.removeEventListener("pagehide", gone);
      w.removeEventListener("keydown", esc);
      w.close();
      setHost(null);
    };
  }, [name, title, width, height]);

  const shell = (
    <div className="app popout" data-theme={look.theme} style={look.style}>
      {children}
    </div>
  );
  if (failed) return <PopOut {...{ name, title, width, height, look, onClose, modal }} windowed={false}>{children}</PopOut>;
  return host ? createPortal(shell, host) : null;
}
