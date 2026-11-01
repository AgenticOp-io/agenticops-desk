import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return (end === -1 ? buf : buf.subarray(0, end)).toString("utf8");
}

// Pull one file out of a .tgz without loading the archive into memory.
// npm packs the Claude Code binary as package/claude or package/claude.exe.
export function extractTarGzMember(tgzPath: string, dest: string, names: string[]): Promise<void> {
  const wanted = new Set(names);
  const raw = createReadStream(tgzPath);
  const input = raw.pipe(createGunzip());
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let phase: "header" | "body" = "header";
  let fileLeft = 0;
  let skipLeft = 0;
  let out: WriteStream | null = null;
  let found = false;
  let settled = false;

  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      raw.destroy();
      input.destroy();
      out?.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const processBuf = () => {
      for (;;) {
        if (phase === "header") {
          if (buf.length < 512) return;
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (header.every((b) => b === 0)) continue;
          const name = cString(header.subarray(0, 100));
          const prefix = cString(header.subarray(345, 500));
          const full = prefix ? `${prefix}/${name}` : name;
          const size = parseInt(cString(header.subarray(124, 136)).trim() || "0", 8) || 0;
          const type = header[156];
          const blocks = Math.ceil(size / 512) * 512;
          const isFile = type === 0 || type === 48;
          if (isFile && wanted.has(full) && !found) {
            found = true;
            out = createWriteStream(dest);
            // A full disk or a locked file must reject the install, not crash the app.
            out.on("error", fail);
            out.on("drain", () => input.resume());
            fileLeft = size;
            skipLeft = blocks - size;
          } else {
            fileLeft = 0;
            skipLeft = blocks;
          }
          phase = blocks > 0 ? "body" : "header";
          continue;
        }
        if (!buf.length) return;
        if (fileLeft > 0) {
          const n = Math.min(buf.length, fileLeft);
          const piece = buf.subarray(0, n);
          buf = buf.subarray(n);
          fileLeft -= n;
          // Respect backpressure so a slow disk never buffers the whole binary in memory.
          if (out && !out.write(piece)) input.pause();
          continue;
        }
        if (skipLeft > 0) {
          const n = Math.min(buf.length, skipLeft);
          buf = buf.subarray(n);
          skipLeft -= n;
          continue;
        }
        phase = "header";
      }
    };

    input.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        processBuf();
      } catch (err) {
        fail(err);
      }
    });
    input.on("error", fail);
    raw.on("error", fail);
    input.on("end", () => {
      if (settled) return;
      try {
        processBuf();
      } catch (err) {
        fail(err);
        return;
      }
      if (!found || !out) {
        fail(new Error("The download did not contain the Claude Code binary."));
        return;
      }
      const stream = out;
      stream.end();
      void finished(stream).then(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, fail);
    });
  });
}
