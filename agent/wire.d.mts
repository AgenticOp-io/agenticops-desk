export type Envelope = { s: string; n: number; z: string; d: string };
export type Channel = { seal(obj: unknown): Envelope; open(env: unknown): any };
export function newKeyPair(): { pub: string; priv: string };
export function fingerprint(pub: string): string;
export function pairCode(pub: string): string;
export function deskSession(deskPriv: string, agentPub: string, agentEph: string): { eph: string; up: Buffer; down: Buffer };
export function agentSession(agentPriv: string, agentEphPriv: string, agentEph: string, deskPub: string, deskEph: string): { up: Buffer; down: Buffer };
export function channel(sid: string, sendKey: Buffer, recvKey: Buffer): Channel;
