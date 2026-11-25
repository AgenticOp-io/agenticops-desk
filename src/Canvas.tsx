import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasDoc } from "./vite-env";
import { ChatMarkdown } from "./ChatMarkdown";
import logoSvg from "../public/logo.svg?raw";

// What the agent puts on the Canvas (the show_canvas tool) is untrusted: it is shown in a sandbox with no
// scripts, and this policy stops it loading anything from outside, so a page can't phone home.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`;
const BASE = `<style>body{font-family:system-ui,sans-serif;line-height:1.5;margin:24px;color:#18181b;background:#fff}table{border-collapse:collapse}th,td{border:1px solid #d4d4d8;padding:4px 8px}pre{background:#f4f4f5;padding:8px;overflow:auto}svg{width:100%;height:auto}</style>`;
// A lone SVG fills the whole window (scaled to fit), so its text is as big as the window allows.
const SVG_FULL = `<style>body{margin:0;display:flex;flex-direction:column;height:100vh}svg{display:block;flex:1;min-height:0;width:100vw}</style>`;
// agenticop.io branding on every canvas, from the app's own shield logo and its colours (public/logo.svg).
const LOGO = `data:image/svg+xml,${encodeURIComponent(logoSvg)}`;
const BRAND = `<style>.ao-h{display:flex;align-items:center;justify-content:space-between;padding:8px 20px;background:#020617;color:#f0fdfa;border-bottom:3px solid;border-image:linear-gradient(90deg,#06b6d4,#22d3ee,#a855f7) 1;font:700 17px Inter,system-ui,sans-serif}.ao-h div{display:flex;align-items:center;gap:10px}.ao-h img{width:30px;height:30px}.ao-h b{color:#22d3ee}.ao-h span{font-weight:400;color:#94a3b8;font-size:13px}.ao-f{padding:6px 20px;background:#020617;color:#94a3b8;font:12px Inter,system-ui,sans-serif;text-align:right}</style>`;

export function canvasPage(doc: CanvasDoc): string {
  const body =
    doc.kind === "markdown" ? renderToStaticMarkup(<ChatMarkdown text={doc.content} />) : doc.content.replace(/^\s*<!doctype[^>]*>/i, "");
  const title = doc.title.replace(/</g, "&lt;");
  const head = `<div class="ao-h"><div><img src="${LOGO}" alt="">Agentic<b>Op</b>.io</div><span>${title}</span></div>`;
  const foot = `<div class="ao-f">agenticop.io</div>`;
  return `<!doctype html>${CSP}<meta charset="utf-8"><title>${title}</title>${BASE}${BRAND}${doc.kind === "svg" ? SVG_FULL : ""}${head}${body}${foot}`;
}

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// The Canvas popup window (the app page opened with ?canvas=<chatId>). It shows the chat's saved document
// and follows it when the agent shows a new one.
export function Canvas({ chatId }: { chatId: string }) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    void window.desk.canvasGet(chatId).then(setDoc);
    return window.desk.onCanvas(setDoc);
  }, [chatId]);
  const page = doc ? canvasPage(doc) : "";
  const name = (doc?.title ?? "canvas").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  const exportAs = (format: "pdf" | "png") => void window.desk.canvasExport(format, page, name).then((ok) => ok && setNote(`Saved ${format.toUpperCase()}`));
  return (
    <div className="canvas-window">
      <div className="pane-head">
        <strong className="grow">{doc?.title ?? "Canvas"}</strong>
        {note && <span className="settings-hint">{note}</span>}
        {doc && (
          <>
            <button type="button" className="ghost" onClick={() => exportAs("pdf")}>
              PDF
            </button>
            <button type="button" className="ghost" onClick={() => exportAs("png")}>
              PNG
            </button>
            <button type="button" className="ghost" onClick={() => save(new Blob([page], { type: "text/html" }), `${name}.html`)}>
              HTML
            </button>
            {doc.kind === "svg" && (
              <button type="button" className="ghost" onClick={() => save(new Blob([doc.content], { type: "image/svg+xml" }), `${name}.svg`)}>
                SVG
              </button>
            )}
            {doc.kind === "markdown" && (
              <button type="button" className="ghost" onClick={() => save(new Blob([doc.content], { type: "text/markdown" }), `${name}.md`)}>
                Markdown
              </button>
            )}
          </>
        )}
      </div>
      {doc ? (
        <iframe className="preview-frame" title={doc.title} sandbox="" srcDoc={page} />
      ) : (
        <p className="settings-hint canvas-empty">
          Ask the agent for a report, a network diagram, a chart or a summary page in the chat, and it appears here. Export it as PDF, PNG or HTML from the buttons above.
        </p>
      )}
    </div>
  );
}
