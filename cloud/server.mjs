#!/usr/bin/env node
// AgenticOps Cloud Server - standalone HTTPS server for agents, desktops, and users
// Can run on any machine; desktops connect to register and upload API keys
// Agents receive work through it; users access it for browser-based operations

import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import https from "node:https";
import { isIP } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pairCode } from "../agent/wire.mjs";

// Pure state logic (extracted from fleetCore.ts, without modifications)
// Tokens are stored only as sha256 hashes; a token is {{SECRET_N}} once, when it is handed out

const ADMIN_USER = "admin";

export type FleetAgent = {
  id: string;
  name: string;
  os: string;
  code: string;
  pub: string;
  status: "pending" | "approved" | "revoked";
  createdAt: number;
  lastSeen: number;
};

export type FleetDevice = { id: string; name: string; tokenHash: string; createdAt: number };

export type FleetUser = {
  id: string;
  name: string;
  maxAgents: number;
  agentIds: string[];
  code?: string;
  tokenHash?: string;
  devices?: FleetDevice[];
  revoked?: boolean;
  createdAt: number;
};

export type FleetJob = {
  id: string;
  userId: string;
  agentId?: string;
  wantAgent?: string;
  prompt: string;
  repo?: string;
  model: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  log: string[];
  result?: string;
  input: number;
  output: number;
  costUsd: number;
};

export type FleetState = {
  adminId: string;
  createdAt: number;
  on: boolean;
  port: number;
  maxAgents: number;
  deskPub?: string;
  deskPrivEnc?: string;
  tls?: { cert: string; keyEnc: string };
  desks: { id: string; pub: string; name: string; createdAt: number; lastSeen: number }[];
  agents: FleetAgent[];
  users: FleetUser[];
  jobs: FleetJob[];
  apiKeys?: { [deskId: string]: string }; // deskId -> encrypted key (desk handles encryption)
};

function newId() {
  return randomBytes(8).toString("hex");
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function pubkeyPin(cert) {
  return new X509Certificate(cert).fingerprint256.replace(/:/g, "");
}

function newKeyPair() {
  return generateKeyPairSync("x25519", { publicKeyEncoding: { format: "raw", type: "raw" }, privateKeyEncoding: { format: "raw", type: "raw" } });
}

export function emptyState(): FleetState {
  const id = newId();
  const keyPair = newKeyPair();
  return {
    adminId: ADMIN_USER,
    createdAt: Date.now(),
    on: true,
    port: 7377,
    maxAgents: 100,
    deskPub: keyPair.publicKey.toString("base64"),
    deskPrivEnc: "",
    desks: [],
    agents: [],
    users: [{ id: ADMIN_USER, name: "Admin", maxAgents: 100, agentIds: [], createdAt: Date.now() }],
    jobs: [],
  };
}

export function newCode(): string {
  return pairCode(randomBytes(8));
}

export function pair(s: FleetState, by: { pub: string; name: string; os: string }): { code: string; id: string } {
  const id = newId();
  const code = newCode();
  s.agents.push({
    id,
    name: by.name || "Agent",
    os: by.os,
    code,
    pub: by.pub,
    status: "pending",
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  return { code, id };
}

export function approve(s: FleetState, agentId: string, userId?: string) {
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent) return false;
  agent.status = "approved";
  if (userId) {
    const user = s.users.find((u) => u.id === userId);
    if (user && !user.agentIds.includes(agentId)) user.agentIds.push(agentId);
  }
  return true;
}

export function addUser(s: FleetState, name: string): FleetUser {
  const user: FleetUser = {
    id: newId(),
    name,
    maxAgents: 10,
    agentIds: [],
    createdAt: Date.now(),
  };
  s.users.push(user);
  return user;
}

export function redeem(s: FleetState, code: string): { token: string; userId: string } | null {
  const user = s.users.find((u) => u.code === code);
  if (!user) return null;
  const token = randomBytes(16).toString("hex");
  const tokenHash = sha256(token);
  if (!user.devices) user.devices = [];
  user.devices.push({ id: newId(), name: "Device", tokenHash, createdAt: Date.now() });
  delete user.code;
  return { token, userId: user.id };
}

export function userFor(s: FleetState, tokenHash: string): string | null {
  for (const u of s.users) {
    for (const d of u.devices || []) {
      if (d.tokenHash === tokenHash) return u.id;
    }
  }
  return null;
}

export function usableAgents(s: FleetState, userId: string): FleetAgent[] {
  const user = s.users.find((u) => u.id === userId);
  if (!user) return [];
  return s.agents.filter((a) => user.agentIds.includes(a.id) && a.status === "approved");
}

export function submit(s: FleetState, userId: string, job: Omit<FleetJob, "id" | "createdAt" | "log">) {
  const id = newId();
  const j: FleetJob = { ...job, id, createdAt: Date.now(), log: [] };
  s.jobs.push(j);
  return j;
}

export function take(s: FleetState, agentId: string): FleetJob | null {
  const job = s.jobs.find((j) => j.status === "queued" && (!j.agentId || j.agentId === agentId));
  if (job) {
    job.status = "running";
    job.startedAt = Date.now();
    job.agentId = agentId;
  }
  return job || null;
}

export function online(s: FleetState, agentId: string) {
  const a = s.agents.find((x) => x.id === agentId);
  if (a) a.lastSeen = Date.now();
}

export function addLog(job: FleetJob, msg: string) {
  job.log.push(`[${new Date().toISOString()}] ${msg}`);
}

// Server implementation
const HOME = process.env.AGENTICOPS_CLOUD_HOME || path.join(os.homedir(), ".agenticops-cloud");
const STATE_FILE = path.join(HOME, "state.json");
const PORT = parseInt(process.env.PORT || "7377");
const TLS_CERT_FILE = path.join(HOME, "tls.cert");
const TLS_KEY_FILE = path.join(HOME, "tls.key");

async function ensureDir() {
  await fs.mkdir(HOME, { recursive: true });
}

async function loadState(): Promise<FleetState> {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return emptyState();
  }
}

async function saveState(s: FleetState) {
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

async function loadOrCreateTLS() {
  if (!(await checkFileExists(TLS_CERT_FILE)) || !(await checkFileExists(TLS_KEY_FILE))) {
    console.log("Creating self-signed TLS certificate...");
    // Note: In production, use proper cert generation. For now, we stub this.
    // The real implementation is in electron/fleetCore.ts
    const cert = "STUB_CERT";
    const key = "STUB_KEY";
    await fs.writeFile(TLS_CERT_FILE, cert);
    await fs.writeFile(TLS_KEY_FILE, key);
  }
  const cert = await fs.readFile(TLS_CERT_FILE, "utf8");
  const key = await fs.readFile(TLS_KEY_FILE, "utf8");
  return { cert, key };
}

async function checkFileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function handleRequest(req: https.IncomingMessage, res: https.ServerResponse) {
  const url = new URL(req.url || "/", "https://localhost");
  const path_name = url.pathname;
  const method = req.method;

  // CORS
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" });
    res.end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  // Health check
  if (method === "GET" && path_name === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API endpoints will be added here as we develop
  // For now, stub a 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

async function main() {
  await ensureDir();
  const tls = await loadOrCreateTLS();
  const state = await loadState();

  const server = https.createServer({ cert: tls.cert, key: tls.key }, handleRequest);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 AgenticOps Cloud Server listening on https://0.0.0.0:${PORT}`);
    console.log(`   State file: ${STATE_FILE}`);
    console.log(`   TLS cert: ${TLS_CERT_FILE}`);
    console.log(`\nReady for agents, desktops, and users to connect.\n`);
  });

  server.on("error", (err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
