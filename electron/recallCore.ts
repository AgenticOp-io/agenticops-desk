// Pure parts of recall (recall.ts): one searchable piece per exchange, the vector file format, and ranking.
// No Electron imports, so the tests run under plain node.
import { createHash } from "node:crypto";

export type Piece = { id: string; src: string; file: string; at: number; text: string };

export const DIM = 768; // nomic-embed-text
const ID_BYTES = 16;
export const RECORD = ID_BYTES + DIM * 4;

// The user's own words in the app's continue/compact prompts (claude.ts): the wrapped history would otherwise
// make every resumed turn look alike and crowd out real matches.
export function ownWords(user: string): string {
  const i = user.toLowerCase().lastIndexOf("reply to the user's new message:");
  const words = i >= 0 ? user.slice(i + 32).trim()
    : user.startsWith("This run was compacted") ? (user.match(/\nRequest:\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? user).trim()
    : user.trim();
  // The git-state packet (gather.ts; "Local findings" in older builds) sits before the message, ended by a blank line.
  return /^(Git state \(|Local findings \()/.test(words) && words.includes("\n\n") ? words.slice(words.indexOf("\n\n") + 2).trim() : words;
}

export function toPiece(x: { src: string; file: string; at: number; user: string; assistant: string }): Piece {
  const text = `User: ${ownWords(x.user).slice(0, 1_500)}\nAssistant: ${x.assistant.trim().slice(0, 2_500)}`;
  return { id: createHash("sha256").update(text).digest("hex").slice(0, ID_BYTES), src: x.src, file: x.file, at: x.at, text };
}

// vectors.bin: records of a 16-char id then DIM float32s, appended as the GPU machine returns them.
export function readVectors(buf: Buffer): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (let o = 0; o + RECORD <= buf.length; o += RECORD) {
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = buf.readFloatLE(o + ID_BYTES + i * 4);
    out.set(buf.toString("latin1", o, o + ID_BYTES), v);
  }
  return out;
}

export function writeVector(id: string, v: ArrayLike<number>): Buffer {
  const b = Buffer.alloc(RECORD);
  b.write(id.padEnd(ID_BYTES).slice(0, ID_BYTES), 0, "latin1");
  for (let i = 0; i < DIM; i++) b.writeFloatLE(v[i] ?? 0, ID_BYTES + i * 4);
  return b;
}

export const normalize = (v: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export const terms = (q: string) => [...new Set(q.toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) ?? [])];

// Keywords weighted by rarity, plus meaning (cosine) when the query and the piece both have a vector.
// Both pieces of one exchange repeated across resumed sessions collapse to the newest copy.
export function rank(pieces: Piece[], lower: string[], query: string, opts: { qvec?: Float32Array | null; vectors?: Map<string, Float32Array>; limit?: number }) {
  const ts = terms(query);
  const df = ts.map((t) => lower.reduce((n, s) => n + (s.includes(t) ? 1 : 0), 0));
  const idf = df.map((d) => (d ? Math.log(1 + pieces.length / d) : 0));
  const maxKw = idf.reduce((a, b) => a + b, 0) || 1;
  const scored: { p: Piece; score: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    let kw = 0;
    for (let j = 0; j < ts.length; j++) if (idf[j] && lower[i].includes(ts[j])) kw += idf[j];
    const v = opts.qvec ? opts.vectors?.get(pieces[i].id) : undefined;
    const score = v ? dot(opts.qvec!, v) + 0.35 * (kw / maxKw) : kw / maxKw;
    if (score > 0.05) scored.push({ p: pieces[i], score });
  }
  scored.sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  const seen = new Set<string>();
  const out: { p: Piece; score: number }[] = [];
  for (const s of scored) {
    if (seen.has(s.p.id)) continue;
    seen.add(s.p.id);
    out.push(s);
    if (out.length >= (opts.limit ?? 6)) break;
  }
  return out;
}
