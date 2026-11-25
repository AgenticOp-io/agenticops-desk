import assert from "node:assert/strict";
import test from "node:test";
import { agentSession, channel, deskSession, newKeyPair } from "./wire.mjs";

const desk = newKeyPair();
const agent = newKeyPair();

function connect(deskPriv = desk.priv, agentPub = agent.pub) {
  const e = newKeyPair();
  const d = deskSession(deskPriv, agentPub, e.pub);
  const a = agentSession(agent.priv, e.priv, e.pub, desk.pub, d.eph);
  return { a: channel("sid", a.up, a.down), d: channel("sid", d.down, d.up) };
}

test("messages cross both ways, every cipher hop is used, and all hops look the same size", () => {
  const { a, d } = connect();
  const sizes = new Set();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const env = a.seal({ p: "stream", b: { i } });
    sizes.add(env.d.length);
    seen.add(env.d.slice(0, 8));
    assert.deepEqual(d.open(env), { p: "stream", b: { i } });
    assert.deepEqual(a.open(d.seal({ ok: i })), { ok: i });
  }
  assert.equal(sizes.size, 1);
  assert.equal(seen.size, 200); // nothing repeats on the wire
  assert.doesNotMatch(JSON.stringify(a.seal({ secret: "hunter2" })), /hunter2/);
});

test("tampering, replay, and the wrong session are refused", () => {
  const { a, d } = connect();
  const env = a.seal({ x: 1 });
  const bad = { ...env, d: env.d.slice(0, -2) + (env.d.endsWith("A") ? "BB" : "AA") };
  assert.throws(() => d.open(bad), /integrity/);
  d.open(env);
  assert.throws(() => d.open(env), /Replayed/);
  assert.throws(() => d.open({ ...a.seal({}), s: "other" }), /foreign/);
  const late = a.seal({ late: true });
  for (let i = 0; i < 1100; i++) d.open(a.seal({}));
  assert.throws(() => d.open(late), /Replayed/); // too far behind the window
});

test("an interceptor without the desk's or the agent's long-term key can't read the session", () => {
  const fakeDesk = newKeyPair();
  const { a, d } = connect(fakeDesk.priv); // agent expects desk.pub
  assert.throws(() => d.open(a.seal({ x: 1 })), /integrity/);
  const { a: a2, d: d2 } = connect(desk.priv, newKeyPair().pub); // desk thinks the agent has some other key
  assert.throws(() => d2.open(a2.seal({ x: 1 })), /integrity/);
});
