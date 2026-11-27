# On the GPU VM: python3 recall-embed.py new.jsonl new.bin
# Each input line is {"id": 16 chars, "text": ...}; each output record is the id then 768 float32 (little-endian,
# unit length) from the VM's own Ollama nomic-embed-text, the format recallCore.ts readVectors() reads. Stdlib only.
import json, math, struct, sys, urllib.request

src, dst = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
BATCH = 32
with open(dst, "wb") as out:
    for i in range(0, len(rows), BATCH):
        part = rows[i : i + BATCH]
        body = json.dumps({"model": "nomic-embed-text", "input": ["search_document: " + r["text"] for r in part], "truncate": True}).encode()
        req = urllib.request.Request("http://127.0.0.1:11434/api/embed", body, {"Content-Type": "application/json"})
        vecs = json.load(urllib.request.urlopen(req, timeout=300))["embeddings"]
        for r, v in zip(part, vecs):
            assert len(v) == 768, len(v)
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.write(r["id"].ljust(16)[:16].encode("latin-1") + struct.pack("<768f", *(x / n for x in v)))
        print(f"embedded {min(i + BATCH, len(rows))}/{len(rows)}", flush=True)
print("EMBED_DONE")
