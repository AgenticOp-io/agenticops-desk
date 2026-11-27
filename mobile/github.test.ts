import { test } from "node:test";
import assert from "node:assert/strict";
import { openPairCode, parsePairCode, sealForDesk } from "./github.ts";
import { openPhoneEnvelope, sealPairing } from "../electron/pureFeatures.ts";
import { randomBytes } from "node:crypto";

test("a message the phone seals opens on the desk, and only under its own file ID", async () => {
  const key = randomBytes(32);
  const at = Date.now();
  const sealed = JSON.parse(await sealForDesk("abc-1", { chat: "c1", text: "fix it", at }, key.toString("base64url")));
  assert.deepEqual(openPhoneEnvelope("abc-1", sealed, key, at), { status: "ok", msg: { chat: "c1", title: undefined, text: "fix it", host: undefined }, at });
  assert.equal(openPhoneEnvelope("abc-2", sealed, key, at).status, "bad");
});

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
  // The phone's setup rides along as a third line; a key-sized setup must still fit the QR pattern.
  const setup = { ai: "k".repeat(108), cloud: { url: "https://10.0.0.5:7377", token: "t".repeat(64), pin: "p".repeat(44) } };
  const withSetup = parsePairCode(sealPairing("u", "1", token, "12345678", [], setup))!;
  const [t, repos, conf] = (await openPairCode(withSetup, "12345678")).split("\n");
  assert.deepEqual([t, repos, JSON.parse(conf)], [token, "", setup]);
});
