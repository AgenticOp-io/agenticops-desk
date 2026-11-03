import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { extractTarGzMember } from "./tarMember.ts";

function header(name: string, size: number) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block[156] = 48;
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function member(name: string, body: string) {
  const data = Buffer.from(body);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header(name, data.length), padded]);
}

test("extracts the named member and ignores the rest of the archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "desk-tar-"));
  try {
    const tgz = path.join(dir, "pkg.tgz");
    const archive = Buffer.concat([
      member("package/other.txt", "nope"),
      member("package/claude.exe", "binary-bytes"),
      Buffer.alloc(1024),
    ]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tgz, gzipSync(archive));
    const dest = path.join(dir, "claude.exe");
    await extractTarGzMember(tgz, dest, ["package/claude.exe", "claude.exe"]);
    assert.equal(await readFile(dest, "utf8"), "binary-bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an archive that does not contain the binary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "desk-tar-"));
  try {
    const tgz = path.join(dir, "pkg.tgz");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tgz, gzipSync(Buffer.concat([member("package/readme", "hi"), Buffer.alloc(1024)])));
    await assert.rejects(
      extractTarGzMember(tgz, path.join(dir, "out"), ["package/claude.exe"]),
      /did not contain the agent engine/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
