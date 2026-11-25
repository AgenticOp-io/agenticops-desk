// Encrypted channel between the superadmin desk and its cloud agents. Only node:crypto, because the desk
// inlines this file into the agent script it serves (see serveAgent in electron/fleetCore.ts).
//
// - Each side has a long-term X25519 key. The agent's pairing code is a hash of its key, so the code the
//   superadmin types proves which key is the agent's. The agent checks the desk's key against --key.
// - Every keepalive session starts with fresh ephemeral keys on both sides and mixes three X25519 results,
//   so only the real agent and the real desk get the session keys, and recorded traffic stays sealed even if a
//   long-term key leaks later. Session keys live only in memory.
// - Every message gets its own key, derived from the session key, its counter and a random salt, and that same
//   derivation picks which cipher seals it ("hopping"). The cipher is not on the wire, and every hop gives the
//   same length, so an observer can't tell which one was used. Counters stop replays.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b) => Buffer.from(b).toString("base64url");
const unb64 = (s) => Buffer.from(String(s ?? ""), "base64url");
const pubKey = (pub) => {
  const k = createPublicKey({ key: unb64(pub), format: "der", type: "spki" });
  if (k.asymmetricKeyType !== "x25519") throw new Error("not an x25519 key");
  return k;
};
const dh = (priv, pub) => diffieHellman({ privateKey: createPrivateKey({ key: unb64(priv), format: "der", type: "pkcs8" }), publicKey: pubKey(pub) });

export function newKeyPair() {
  const k = generateKeyPairSync("x25519");
  return { pub: b64(k.publicKey.export({ type: "spki", format: "der" })), priv: b64(k.privateKey.export({ type: "pkcs8", format: "der" })) };
}

export const fingerprint = (pub) => createHash("sha256").update(unb64(pub)).digest("hex").slice(0, 32).replace(/(.{4})(?!$)/g, "$1-");

// shortcut: 40 bits, so someone on the network path would need ~2^40 key tries during the pairing window to fake it; lengthen the code if pairing ever runs over the open internet.
export function pairCode(pub) {
  pubKey(pub);
  const h = createHash("sha256").update("agenticops pair").update(unb64(pub)).digest();
  const s = [...h.subarray(0, 8)].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function sessionKeys(ee, es, se, agentEph, deskEph) {
  const salt = createHash("sha256").update(unb64(agentEph)).update(unb64(deskEph)).digest();
  const k = Buffer.from(hkdfSync("sha256", Buffer.concat([ee, es, se]), salt, "agenticops fleet v1", 64));
  return { up: k.subarray(0, 32), down: k.subarray(32) }; // up: agent → desk, down: desk → agent
}

// Desk side of a hello. Returns the desk's ephemeral public key to send back, and the keys.
export function deskSession(deskPriv, agentPub, agentEph) {
  const e = newKeyPair();
  return { eph: e.pub, ...sessionKeys(dh(e.priv, agentEph), dh(e.priv, agentPub), dh(deskPriv, agentEph), agentEph, e.pub) };
}

export function agentSession(agentPriv, agentEphPriv, agentEph, deskPub, deskEph) {
  return sessionKeys(dh(agentEphPriv, deskEph), dh(agentPriv, deskEph), dh(agentEphPriv, deskPub), agentEph, deskEph);
}

// All 256-bit, all authenticated, all built in to both Node and Electron (Electron's BoringSSL has no ChaCha20).
const HOPS = [{ c: "aes-256-gcm" }, { c: "aes-256-ctr", h: "sha256" }, { c: "aes-256-cbc", h: "sha512" }, { c: "aes-256-cfb", h: "sha384" }];
const BLOCK = 64; // plaintext is padded to this, which also hides exact message sizes

function msgKeys(key, sid, n, salt) {
  const k = Buffer.from(hkdfSync("sha256", key, salt, `${sid}:${n}`, 65));
  return { hop: HOPS[k[64] % HOPS.length], enc: k.subarray(0, 32), mac: k.subarray(32, 64) };
}

export function channel(sid, sendKey, recvKey) {
  let next = 0;
  let max = -1;
  const seen = new Set();
  return {
    seal(obj) {
      const n = next++;
      const salt = randomBytes(16);
      const { hop, enc, mac } = msgKeys(sendKey, sid, n, salt);
      const aad = Buffer.from(`${sid}:${n}`);
      const json = JSON.stringify(obj);
      const pt = Buffer.from(json + " ".repeat(BLOCK - (Buffer.byteLength(json) % BLOCK))); // JSON.parse ignores trailing spaces
      const iv = randomBytes(16);
      const c = createCipheriv(hop.c, enc, iv);
      if (hop.h) c.setAutoPadding(false);
      else c.setAAD(aad);
      const ct = Buffer.concat([c.update(pt), c.final()]);
      const tag = hop.h ? createHmac(hop.h, mac).update(aad).update(iv).update(ct).digest().subarray(0, 16) : c.getAuthTag();
      return { s: sid, n, z: b64(salt), d: b64(Buffer.concat([iv, ct, tag])) };
    },
    open(env) {
      const n = env?.n;
      if (env?.s !== sid || !Number.isSafeInteger(n) || n < 0 || seen.has(n) || n <= max - 1024) throw new Error("Replayed or foreign message.");
      const salt = unb64(env.z);
      const d = unb64(env.d);
      if (salt.length !== 16 || d.length < 32 + BLOCK || (d.length - 32) % BLOCK) throw new Error("Malformed message.");
      const { hop, enc, mac } = msgKeys(recvKey, sid, n, salt);
      const aad = Buffer.from(`${sid}:${n}`);
      const iv = d.subarray(0, 16);
      const ct = d.subarray(16, -16);
      const tag = d.subarray(-16);
      let pt;
      try {
        if (hop.h) {
          if (!timingSafeEqual(createHmac(hop.h, mac).update(aad).update(iv).update(ct).digest().subarray(0, 16), tag)) throw 0;
          const c = createDecipheriv(hop.c, enc, iv);
          c.setAutoPadding(false);
          pt = Buffer.concat([c.update(ct), c.final()]);
        } else {
          const c = createDecipheriv(hop.c, enc, iv);
          c.setAAD(aad);
          c.setAuthTag(tag);
          pt = Buffer.concat([c.update(ct), c.final()]);
        }
      } catch {
        throw new Error("Message failed its integrity check.");
      }
      seen.add(n);
      if (n > max) max = n;
      if (seen.size > 2048) for (const x of seen) if (x <= max - 1024) seen.delete(x);
      return JSON.parse(pt.toString("utf8"));
    },
  };
}
