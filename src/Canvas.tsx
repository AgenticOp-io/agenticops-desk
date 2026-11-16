import { useRef, useState } from "react";

// A small vector canvas. Everything is SVG, so SVG export is lossless and PNG/JPG/WebP/PDF are rendered from it.
const W = 1200;
const H = 800;

type Shape =
  | { id: number; t: "pen"; pts: string; c: string; w: number }
  | { id: number; t: "line" | "rect" | "ellipse"; x: number; y: number; x2: number; y2: number; c: string; w: number }
  | { id: number; t: "text"; x: number; y: number; s: string; c: string; size: number }
  | { id: number; t: "image"; x: number; y: number; w: number; h: number; href: string };
type Tool = "select" | "pen" | "line" | "rect" | "ellipse" | "text";

const TOOLS: Tool[] = ["select", "pen", "line", "rect", "ellipse", "text"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function shapeSvg(s: Shape): string {
  if (s.t === "pen") return `<polyline points="${s.pts}" fill="none" stroke="${s.c}" stroke-width="${s.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (s.t === "line") return `<line x1="${s.x}" y1="${s.y}" x2="${s.x2}" y2="${s.y2}" stroke="${s.c}" stroke-width="${s.w}" stroke-linecap="round"/>`;
  if (s.t === "rect") return `<rect x="${Math.min(s.x, s.x2)}" y="${Math.min(s.y, s.y2)}" width="${Math.abs(s.x2 - s.x)}" height="${Math.abs(s.y2 - s.y)}" fill="none" stroke="${s.c}" stroke-width="${s.w}"/>`;
  if (s.t === "ellipse") return `<ellipse cx="${(s.x + s.x2) / 2}" cy="${(s.y + s.y2) / 2}" rx="${Math.abs(s.x2 - s.x) / 2}" ry="${Math.abs(s.y2 - s.y) / 2}" fill="none" stroke="${s.c}" stroke-width="${s.w}"/>`;
  if (s.t === "text") return `<text x="${s.x}" y="${s.y}" fill="${s.c}" font-size="${s.size}" font-family="sans-serif">${esc(s.s)}</text>`;
  if (s.t !== "image") return "";
  return `<image x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" href="${s.href}"/>`;
}

const toSvg = (shapes: Shape[], bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${shapes.map(shapeSvg).join("")}</svg>`;

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function raster(svg: string, type: string, scale = 2): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = W * scale;
  c.height = H * scale;
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Export failed"))), type, 0.92));
}

// One-page PDF holding the canvas as a JPEG. shortcut: the page is a picture, not vector; upgrade if text must stay selectable.
async function pdf(svg: string): Promise<Blob> {
  const jpg = new Uint8Array(await (await raster(svg, "image/jpeg", 2)).arrayBuffer());
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offs: number[] = [];
  let len = 0;
  const add = (p: Uint8Array | string) => {
    const b = typeof p === "string" ? enc.encode(p) : p;
    parts.push(b);
    len += b.length;
  };
  const obj = (n: number, body: string) => {
    offs[n] = len;
    add(`${n} 0 obj\n${body}\nendobj\n`);
  };
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im 4 0 R >> >> /Contents 5 0 R >>`);
  offs[4] = len;
  add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W * 2} /Height ${H * 2} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
  add(jpg);
  add("\nendstream\nendobj\n");
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offs[n]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

export function Canvas({ onStatus }: { onStatus: (text: string) => void }) {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#1f2937");
  const [bg, setBg] = useState("#ffffff");
  const [width, setWidth] = useState(4);
  const [label, setLabel] = useState("Text");
  const [sel, setSel] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; lx: number; ly: number } | null>(null);
  const nextId = useRef(1);

  const point = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };
  const patch = (id: number, f: (s: Shape) => Shape) => setShapes((cur) => cur.map((s) => (s.id === id ? f(s) : s)));

  const down = (e: React.PointerEvent) => {
    const { x, y } = point(e);
    const id = nextId.current;
    if (tool === "select") {
      const hit = (e.target as Element).closest("[data-id]");
      const hid = hit ? Number(hit.getAttribute("data-id")) : null;
      setSel(hid);
      drag.current = hid ? { id: hid, lx: x, ly: y } : null;
      if (hid) svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    nextId.current++;
    svgRef.current!.setPointerCapture(e.pointerId);
    if (tool === "text") return void setShapes((c) => [...c, { id, t: "text", x, y, s: label, c: color, size: width * 6 }]);
    drag.current = { id, lx: x, ly: y };
    setShapes((c) => [...c, tool === "pen" ? { id, t: "pen", pts: `${x},${y}`, c: color, w: width } : { id, t: tool, x, y, x2: x, y2: y, c: color, w: width }]);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = point(e);
    if (tool === "select") {
      const dx = x - d.lx;
      const dy = y - d.ly;
      d.lx = x;
      d.ly = y;
      patch(d.id, (s) =>
        s.t === "pen"
          ? { ...s, pts: s.pts.split(" ").map((p) => { const [a, b] = p.split(",").map(Number); return `${a + dx},${b + dy}`; }).join(" ") }
          : s.t === "line" || s.t === "rect" || s.t === "ellipse"
            ? { ...s, x: s.x + dx, y: s.y + dy, x2: s.x2 + dx, y2: s.y2 + dy }
            : { ...s, x: s.x + dx, y: s.y + dy },
      );
    } else patch(d.id, (s) => (s.t === "pen" ? { ...s, pts: `${s.pts} ${x},${y}` } : s.t === "line" || s.t === "rect" || s.t === "ellipse" ? { ...s, x2: x, y2: y } : s));
  };

  const addImage = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      const href = String(r.result);
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 600 / im.width, 600 / im.height);
        setShapes((c) => [...c, { id: nextId.current++, t: "image", x: 40, y: 40, w: im.width * k, h: im.height * k, href }]);
      };
      im.src = href;
    };
    r.readAsDataURL(file);
  };

  const svg = toSvg(shapes, bg);
  const out = (label: string, run: () => Promise<void>) => void run().then(() => onStatus(label)).catch((e) => onStatus(`Export failed: ${e.message}`));
  const exports: Array<[string, () => Promise<void>]> = [
    ["SVG", async () => saveBlob(new Blob([svg], { type: "image/svg+xml" }), "canvas.svg")],
    ["PNG", async () => saveBlob(await raster(svg, "image/png"), "canvas.png")],
    ["JPG", async () => saveBlob(await raster(svg, "image/jpeg"), "canvas.jpg")],
    ["WebP", async () => saveBlob(await raster(svg, "image/webp"), "canvas.webp")],
    ["PDF", async () => saveBlob(await pdf(svg), "canvas.pdf")],
    ["JSON", async () => saveBlob(new Blob([JSON.stringify({ bg, shapes })], { type: "application/json" }), "canvas.json")],
    ["Copy PNG", async () => navigator.clipboard.write([new ClipboardItem({ "image/png": await raster(svg, "image/png") })])],
    ["Copy SVG", async () => navigator.clipboard.writeText(svg)],
  ];

  return (
    <div className="dock-body">
      <div className="dock-row">
        {TOOLS.map((t) => (
          <button key={t} type="button" className={`pill ${tool === t ? "on" : ""}`} onClick={() => setTool(t)}>
            {t}
          </button>
        ))}
        <input type="color" value={color} title="Line colour" onChange={(e) => setColor(e.target.value)} />
        <input type="color" value={bg} title="Background" onChange={(e) => setBg(e.target.value)} />
        <input type="range" min={1} max={20} value={width} title="Line width" onChange={(e) => setWidth(Number(e.target.value))} />
        {tool === "text" && <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Text to place" />}
      </div>
      <div className="dock-row">
        <button type="button" className="btn" disabled={!shapes.length} onClick={() => setShapes((c) => c.slice(0, -1))}>Undo</button>
        <button type="button" className="btn" disabled={sel === null} onClick={() => { setShapes((c) => c.filter((s) => s.id !== sel)); setSel(null); }}>Delete selected</button>
        <button type="button" className="btn" disabled={!shapes.length} onClick={() => setShapes([])}>Clear</button>
        <label className="btn">
          Add image
          <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) addImage(f); e.target.value = ""; }} />
        </label>
        <label className="btn">
          Open JSON
          <input
            type="file"
            accept=".json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void f?.text().then((t) => {
                try {
                  const d = JSON.parse(t) as { bg?: string; shapes?: Shape[] };
                  if (!Array.isArray(d.shapes)) throw new Error("not a canvas file");
                  setShapes(d.shapes);
                  setBg(d.bg ?? "#ffffff");
                  nextId.current = Math.max(0, ...d.shapes.map((s) => s.id)) + 1;
                } catch {
                  onStatus("That file is not a canvas export");
                }
              });
            }}
          />
        </label>
      </div>
      <div className="dock-row">
        {exports.map(([name, run]) => (
          <button key={name} type="button" className="btn" disabled={!shapes.length} onClick={() => out(name.startsWith("Copy") ? "Copied" : `Exported ${name}`, run)}>
            {name.startsWith("Copy") ? name : `Export ${name}`}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", maxHeight: 420, background: bg, border: "1px solid #8884", touchAction: "none", cursor: tool === "select" ? "default" : "crosshair" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
      >
        {shapes.map((s) => (
          <g key={s.id} data-id={s.id} opacity={sel === s.id ? 0.7 : 1} dangerouslySetInnerHTML={{ __html: shapeSvg(s) }} />
        ))}
      </svg>
    </div>
  );
}
