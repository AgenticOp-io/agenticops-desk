import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { app } from "electron";
import { readJson, writeJsonAtomic } from "./jsonStore";
import { expandMcpEnv, mcpServersIn, mcpToolName, type McpServerConfig } from "./pureFeatures";

// MCP servers for the Direct engine. Claude Code starts its own; this reads the same config: the project's .mcp.json
// and the user's ~/.claude.json (top level and this project's entry). A server from .mcp.json came with the
// repository, so it starts only after the user allows it once for this folder and this exact config.

export type McpTool = {
  name: string;
  description: string;
  schema: { properties: Record<string, unknown>; required: string[] };
  readOnly: boolean;
  server: string;
  tool: string;
  owner: Live;
};

type Found = { name: string; config: McpServerConfig; fromProject: boolean };
type Live = { client: Client; tools: McpTool[]; usedAt: number };

const IDLE_MS = 15 * 60_000;
const live = new Map<string, Promise<Live | null>>();
const approvalsFile = () => path.join(app.getPath("userData"), "mcp-approvals.json");
const folderKey = (dir: string) => (process.platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir));
const configKey = (cwd: string, s: Found) => createHash("sha256").update(JSON.stringify([folderKey(cwd), s.name, s.config])).digest("hex");

async function claudeJson(): Promise<unknown> {
  return readJson(path.join(os.homedir(), ".claude.json")).catch(() => null);
}

export async function mcpServersFor(cwd: string): Promise<Found[]> {
  const user = (await claudeJson()) as { mcpServers?: unknown; projects?: Record<string, unknown> } | null;
  const local = Object.entries(user?.projects ?? {}).find(([dir]) => folderKey(dir) === folderKey(cwd))?.[1];
  const project = await readJson(path.join(cwd, ".mcp.json")).catch(() => null);
  const byName = new Map<string, Found>();
  // Same order as Claude Code: user, then project, then this project's local entry wins.
  for (const [name, config] of Object.entries(mcpServersIn(user))) byName.set(name, { name, config, fromProject: false });
  for (const [name, config] of Object.entries(mcpServersIn(project))) byName.set(name, { name, config, fromProject: true });
  for (const [name, config] of Object.entries(mcpServersIn(local))) byName.set(name, { name, config, fromProject: false });
  return [...byName.values()];
}

async function approvedKeys(): Promise<Set<string>> {
  const data = await readJson(approvalsFile()).catch(() => null);
  return new Set(Array.isArray(data) ? data.filter((k): k is string => typeof k === "string") : []);
}

async function rememberApproval(key: string) {
  const keys = await approvedKeys();
  keys.add(key);
  await writeJsonAtomic(approvalsFile(), [...keys]);
}

export function describeServer(s: Found): string {
  return s.config.command ? [s.config.command, ...(s.config.args ?? [])].join(" ") : String(s.config.url);
}

function transportFor(cwd: string, config: McpServerConfig): Transport {
  const env = { ...process.env } as Record<string, string | undefined>;
  const expand = (v: string) => expandMcpEnv(v, env);
  const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, expand(v)]));
  if (config.url && config.type === "sse") return new SSEClientTransport(new URL(expand(config.url)), { requestInit: { headers } });
  if (config.url) return new StreamableHTTPClientTransport(new URL(expand(config.url)), { requestInit: { headers } });
  return new StdioClientTransport({
    command: expand(config.command ?? ""),
    args: (config.args ?? []).map(expand),
    env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, expand(v)])) },
    cwd,
    stderr: "ignore",
  });
}

async function connect(cwd: string, s: Found): Promise<Live | null> {
  const client = new Client({ name: "agenticops-desk", version: app.getVersion() });
  try {
    await client.connect(transportFor(cwd, s.config), { timeout: 30_000 });
    const entry: Live = { client, tools: [], usedAt: Date.now() };
    const tools = entry.tools;
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
      for (const t of page.tools) {
        const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
        tools.push({
          name: mcpToolName(s.name, t.name),
          description: `${t.description ?? t.name} (MCP server ${s.name})`.slice(0, 1000),
          schema: { properties: schema.properties ?? {}, required: Array.isArray(schema.required) ? schema.required : [] },
          readOnly: t.annotations?.readOnlyHint === true,
          server: s.name,
          tool: t.name,
          owner: entry,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return entry;
  } catch (err) {
    console.error(`AgenticOps Desk could not start MCP server ${s.name}`, err);
    await client.close().catch(() => {});
    return null;
  }
}

// The tools of every server this folder can use. ask is called for a project server not yet allowed here;
// it returns true to start it. Servers that fail are reported in notes and left out.
export async function mcpToolsFor(cwd: string, ask: (s: Found, command: string) => Promise<boolean>): Promise<{ tools: McpTool[]; notes: string[] }> {
  const servers = await mcpServersFor(cwd).catch(() => []);
  if (!servers.length) return { tools: [], notes: [] };
  const approved = await approvedKeys();
  const tools: McpTool[] = [];
  const notes: string[] = [];
  for (const s of servers) {
    const key = configKey(cwd, s);
    if (s.fromProject && !approved.has(key)) {
      if (!(await ask(s, describeServer(s)))) continue;
      await rememberApproval(key);
    }
    let started = live.get(key);
    if (!started) {
      started = connect(cwd, s);
      live.set(key, started);
    }
    const got = await started;
    if (!got) {
      live.delete(key);
      notes.push(`MCP server ${s.name} did not start.`);
      continue;
    }
    got.usedAt = Date.now();
    tools.push(...got.tools);
  }
  return { tools, notes };
}

export async function callMcpTool(tool: McpTool, input: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; error?: boolean }> {
  tool.owner.usedAt = Date.now();
  const result = await tool.owner.client
    .callTool({ name: tool.tool, arguments: input }, undefined, { signal, timeout: 600_000 })
    .finally(() => (tool.owner.usedAt = Date.now()));
  const parts = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const text = parts
    .map((p) => {
      if (p.type === "text") return String(p.text ?? "");
      if (p.type === "resource") return String((p.resource as { text?: string } | undefined)?.text ?? "[resource]");
      return `[${String(p.type)} omitted]`;
    })
    .join("\n");
  const body = text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "(no output)");
  return { text: body, ...(result.isError ? { error: true } : {}) };
}

export async function closeMcp(idleOnly = false) {
  const now = Date.now();
  for (const [key, started] of live) {
    const got = await started;
    if (idleOnly && got && now - got.usedAt < IDLE_MS) continue;
    live.delete(key);
    await got?.client.close().catch(() => {});
  }
}

setInterval(() => void closeMcp(true), 5 * 60_000).unref();
