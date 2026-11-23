import { test } from "node:test";
import assert from "node:assert/strict";
import { openPairCode, parsePairCode } from "./github.ts";
import { sealPairing } from "../electron/pureFeatures.ts";

test("desk-sealed pairing QR opens only with the right code", async () => {
  const token = "x".repeat(4) + "a".repeat(36);
  const qr = sealPairing("some-user", "12345", token, "12345678");
  const p = parsePairCode(qr + "\n");
  assert.ok(p);
  assert.equal(p.login, "some-user");
  assert.equal(await openPairCode(p, "12345678"), token);
  await assert.rejects(openPairCode(p, "00000000"), /Wrong code/);
  assert.equal(parsePairCode(`ADPAIR1 some-user 12345 ${token}`), null);
  assert.equal(parsePairCode("https://example.com"), null);
  const withRepos = parsePairCode(sealPairing("u", "1", token, "12345678", ["a/b", "c/d"]))!;
  assert.equal(await openPairCode(withRepos, "12345678"), `${token}\na/b c/d`);
});
