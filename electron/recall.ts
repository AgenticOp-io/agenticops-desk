// Recall: search every past chat on this computer (the same transcripts training reads, with its secret masking
// and leave-out list) for the exchanges that answer a question, so the agent does not grep .jsonl files.
// Keyword search always works. The GPU machine (Settings › Your own model host) embeds new exchanges with its
// Ollama nomic-embed-text, and queries are embedded through the cloud GPU tunnel (localhost:11435) or a local
// Ollama, for search by meaning. Vectors live in %APPDATA%/AgenticOps Desk/recall, never in a project.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import EMBED_PY from "../scripts/eval/recall-embed.py?raw";
import { privacyMode } from "./privacy";
import { DIM, normalize, rank, readVectors, toPiece, type Piece } from "./recallCore";
import { collectChats } from "./trainData";
import { run, sshArgs, trainState } from "./trainModel";

const REBUILD_MS = 10 * 60_000;
const EMBED_RETRY_MS = 30 * 60_000;
const dir = () => path.join(app.getPath("userData"), "recall");

let pieces: Piece[] = [];
let lower: string[] = [];
let builtAt = 0;
let building: Promise<void> | null = null;
let vectors: Map<string, Float32Array> | null = null;
let embedding = false;
let lastEmbedTry = 0;

function loadVectors() {
  if (!vectors) {
    try {
      vectors = readVectors(readFileSync(path.join(dir(), "vectors.bin")));
    } catch {
      vectors = new Map();
    }
  }
  return vectors;
}

async function build() {
  const set = await collectChats({ deskDir: app.getPath("userData"), leaveOut: trainState().leaveOut });
  const byId = new Map<string, Piece>(); // a resumed session repeats exchanges: keep the newest copy
  for (const x of set.exchanges) {
    const p = toPiece(x);
    const old = byId.get(p.id);
    if (!old || p.at > old.at) byId.set(p.id, p);
  }
  pieces = [...byId.values()];
  lower = pieces.map((p) => p.text.toLowerCase());
  builtAt = Date.now();
  void embedMissing();
}

function refresh(): Promise<void> {
  building ??= build()
    .catch((e) => console.error("AgenticOps Desk could not index chats for recall", e))
    .finally(() => (building = null));
  return building;
}

// Sends exchanges without a vector to the GPU machine and appends what comes back. Quietly waits for the next
// try when the machine is off: keyword search covers them until then.
async function embedMissing() {
  const host = trainState().host;
  if (embedding || !host || privacyMode() === "local" || Date.now() - lastEmbedTry < EMBED_RETRY_MS) return;
  const have = loadVectors();
  const missing = pieces.filter((p) => !have.has(p.id));
  if (!missing.length) return;
  embedding = true;
  lastEmbedTry = Date.now();
  const d = dir();
  try {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "recall-new.jsonl"), missing.map((p) => JSON.stringify({ id: p.id, text: p.text })).join("\n") + "\n");
    writeFileSync(path.join(d, "recall-embed.py"), EMBED_PY.replace(/\r\n/g, "\n"));
    await run("ssh", [...sshArgs, host, "mkdir -p ~/train"]);
    // Relative names with cwd: scp would read a drive letter such as C: as a host name.
    await run("scp", ["-B", "-q", ...sshArgs, "recall-new.jsonl", "recall-embed.py", `${host}:train/`], d, 15 * 60_000);
    // Inline, not a gpu-train.sh step: rewriting that script while a training run executes it would break the run.
    await run(
      "ssh",
      [...sshArgs, host, "cd ~/train && (ollama list | grep -q '^nomic-embed-text' || ollama pull nomic-embed-text >/dev/null) && python3 recall-embed.py recall-new.jsonl recall-new.bin > embed.log 2>&1 || { tail -n 5 embed.log >&2; exit 1; }"],
      undefined,
      60 * 60_000,
    );
    await run("scp", ["-B", "-q", ...sshArgs, `${host}:train/recall-new.bin`, "recall-new.bin"], d, 15 * 60_000);
    const buf = readFileSync(path.join(d, "recall-new.bin"));
    appendFileSync(path.join(d, "vectors.bin"), buf);
    for (const [id, v] of readVectors(buf)) have.set(id, v);
  } catch (e) {
    console.error("AgenticOps Desk could not embed chats for recall (the GPU machine may be off)", e);
  } finally {
    embedding = false;
    rmSync(path.join(d, "recall-new.bin"), { force: true });
    rmSync(path.join(d, "recall-new.jsonl"), { force: true });
  }
}

async function embedQuery(q: string): Promise<Float32Array | null> {
  // 11435 is the cloud GPU tunnel, which Local only mode must not use; 11434 is Ollama on this computer.
  const bases = privacyMode() === "local" ? ["http://localhost:11434"] : ["http://localhost:11435", "http://localhost:11434"];
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nomic-embed-text", input: [`search_query: ${q}`] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) continue;
      const v = ((await r.json()) as { embeddings?: number[][] }).embeddings?.[0];
      if (v?.length === DIM) return normalize(v);
    } catch {
      /* closed port or no model: try the next one */
    }
  }
  return null;
}

export async function recall(query: string, limit = 6): Promise<string> {
  if (!builtAt) await refresh();
  else if (Date.now() - builtAt > REBUILD_MS) void refresh();
  const vecs = loadVectors();
  const qvec = vecs.size ? await embedQuery(query) : null;
  const hits = rank(pieces, lower, query, { qvec, vectors: vecs, limit });
  const covered = pieces.reduce((n, p) => n + (vecs.has(p.id) ? 1 : 0), 0);
  const how = qvec
    ? `by meaning and keywords (${covered} of ${pieces.length} exchanges have vectors)`
    : `by keywords only (${covered} of ${pieces.length} exchanges have vectors; no embedding model answered on localhost:11435 or 11434)`;
  if (!hits.length) return `Searched ${pieces.length} past exchanges ${how}. Nothing matches.`;
  const day = (at: number) => (at ? new Date(at).toISOString().slice(0, 10) : "date unknown");
  return `Searched ${how}. Best matches, newest transcript date first among equals:\n\n${hits
    .map(({ p }) => `--- ${day(p.at)} · ${p.src} · ${p.file}\n${p.text.length > 1_400 ? `${p.text.slice(0, 1_400)}…` : p.text}`)
    .join("\n\n")}`;
}

// Index soon after start so the first recall is quick, and retry the GPU machine now and then.
export function startRecall() {
  setTimeout(() => void refresh(), 60_000);
  setInterval(() => void (Date.now() - builtAt > REBUILD_MS ? refresh() : embedMissing()), 60 * 60_000);
}
