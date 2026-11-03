import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureClaudeBinary } from "./claudeBinary";
import { describeMarkdown, parseCliJson } from "./pureFeatures";

// Claude Code plugins, managed through the bundled Claude Code's own `claude plugin ...` commands, so
// AgenticOps Desk and the CLI share one set of marketplaces and installed plugins (~/.claude/plugins).

export type InstalledPlugin = { id: string; version?: string; scope?: string; enabled: boolean; installPath?: string };
export type AvailablePlugin = { pluginId: string; name: string; description?: string; marketplaceName: string; installCount?: number };
export type Marketplace = { name: string; source?: string; repo?: string; url?: string; installLocation?: string };
export type PluginCommand = {
  command: string;
  plugin: string;
  pluginId: string;
  kind: "command" | "skill";
  description: string;
  enabled: boolean;
};
export type PluginResult = { ok: boolean; output: string; confirm?: { command: string; sha256: string } };

const ID = /^[\w.@:-]{1,160}$/;

async function claude(args: string[], timeout = 180_000): Promise<{ ok: boolean; out: string }> {
  const exe = await ensureClaudeBinary();
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ""}${err ? `\n${stderr ?? ""}` : ""}`.trim() });
    });
  });
}

let catalog: { at: number; installed: InstalledPlugin[]; available: AvailablePlugin[] } | null = null;
let commands: PluginCommand[] | null = null;

export async function listPlugins(refresh = false) {
  if (!refresh && catalog && Date.now() - catalog.at < 60_000) return catalog;
  const r = await claude(["plugin", "list", "--available", "--json"]);
  const data = parseCliJson<{ installed?: InstalledPlugin[]; available?: AvailablePlugin[] }>(r.out);
  if (!data) throw new Error(r.out.slice(0, 400) || "The agent engine did not list plugins.");
  catalog = { at: Date.now(), installed: data.installed ?? [], available: data.available ?? [] };
  return catalog;
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  const r = await claude(["plugin", "marketplace", "list", "--json"]);
  return parseCliJson<Marketplace[]>(r.out) ?? [];
}

const done = (r: { ok: boolean; out: string }): PluginResult => {
  catalog = null;
  commands = null;
  return { ok: r.ok, output: r.out.slice(-3000) };
};

// owner/repo, a git or https URL. Local paths are allowed too, but must exist.
export async function addMarketplace(source: string): Promise<PluginResult> {
  const s = source.trim();
  const ok = /^[\w.-]+\/[\w.-]+$/.test(s) || /^(https?:\/\/|git@)\S+$/.test(s) || (path.isAbsolute(s) && existsSync(s));
  if (!ok) return { ok: false, output: "Use owner/repo, a git or https URL, or a folder path." };
  return done(await claude(["plugin", "marketplace", "add", s]));
}

export async function removeMarketplace(name: string): Promise<PluginResult> {
  if (!ID.test(name)) return { ok: false, output: "Bad marketplace name." };
  return done(await claude(["plugin", "marketplace", "remove", name]));
}

// Pulls the latest plugin list from a marketplace (all of them when no name is given).
export async function updateMarketplace(name?: string): Promise<PluginResult> {
  if (name && !ID.test(name)) return { ok: false, output: "Bad marketplace name." };
  return done(await claude(["plugin", "marketplace", "update", ...(name ? [name] : [])], 600_000));
}

// A plugin that installs by running a command must be shown to the user first; the run reports the
// command and its sha256, and only that exact command is then accepted.
export async function installPlugin(id: string, acceptSha?: string): Promise<PluginResult> {
  if (!ID.test(id)) return { ok: false, output: "Bad plugin id." };
  const args = ["plugin", "install", id, "--json"];
  if (acceptSha && /^[a-f0-9]{64}$/i.test(acceptSha)) args.push("--accept-command", acceptSha);
  const r = await claude(args, 600_000);
  const res = parseCliJson<{ shownCommand?: { command?: string; sha256?: string } }>(r.out);
  if (!r.ok && res?.shownCommand?.sha256) {
    return { ok: false, output: r.out.slice(-2000), confirm: { command: res.shownCommand.command ?? "", sha256: res.shownCommand.sha256 } };
  }
  return done(r);
}

export async function uninstallPlugin(id: string): Promise<PluginResult> {
  if (!ID.test(id)) return { ok: false, output: "Bad plugin id." };
  return done(await claude(["plugin", "uninstall", id, "-y"]));
}

export async function setPluginEnabled(id: string, on: boolean): Promise<PluginResult> {
  if (!ID.test(id)) return { ok: false, output: "Bad plugin id." };
  return done(await claude(["plugin", on ? "enable" : "disable", id]));
}

export async function updatePlugin(id: string): Promise<PluginResult> {
  if (!ID.test(id)) return { ok: false, output: "Bad plugin id." };
  return done(await claude(["plugin", "update", id, "--json"], 600_000));
}

// What a plugin adds (commands, skills, agents, hooks, MCP servers). Claude Code describes installed
// plugins; for one that is not installed yet, read its marketplace's local copy so the user can look first.
export async function pluginDetails(id: string): Promise<string> {
  if (!ID.test(id)) return "Bad plugin id.";
  const installed = catalog?.installed.some((p) => p.id === id) ?? true;
  if (installed) {
    const r = await claude(["plugin", "details", id]);
    if (r.ok && r.out) return r.out.slice(0, 20_000);
  }
  return (await previewPlugin(id)) ?? "No details found for this plugin. Its marketplace may need an update.";
}

type MarketEntry = {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  homepage?: string;
  author?: { name?: string } | string;
  source?: string | { source?: string; repo?: string; url?: string; path?: string };
};

async function previewPlugin(id: string): Promise<string | null> {
  const [name, marketName] = id.split("@");
  if (!name || !marketName) return null;
  const market = (await listMarketplaces()).find((m) => m.name === marketName);
  if (!market?.installLocation) return null;
  let entry: MarketEntry | undefined;
  try {
    const manifest = JSON.parse(readText(path.join(market.installLocation, ".claude-plugin", "marketplace.json"))) as { plugins?: MarketEntry[] };
    entry = manifest.plugins?.find((p) => p.name === name);
  } catch {
    return null;
  }
  if (!entry) return null;
  const author = typeof entry.author === "string" ? entry.author : entry.author?.name;
  const src = entry.source;
  const where =
    typeof src === "string" ? `${market.repo ?? market.name} (${src})` : src?.repo ?? src?.url ?? (src ? JSON.stringify(src) : "");
  const lines = [
    `${entry.name}${entry.version ? ` ${entry.version}` : ""} · not installed`,
    entry.description ?? "",
    "",
    ...(author ? [`Author: ${author}`] : []),
    ...(entry.category ? [`Category: ${entry.category}`] : []),
    ...(where ? [`Source: ${where}`] : []),
    ...(entry.homepage ? [`Homepage: ${entry.homepage}`] : []),
  ];
  // A plugin kept inside the marketplace can be looked at before installing; others live in their own repo.
  const dir = typeof src === "string" ? path.resolve(market.installLocation, src) : null;
  if (dir && dir.startsWith(path.resolve(market.installLocation)) && existsSync(dir)) {
    const found = scan({ id, enabled: true, installPath: dir });
    const agents = existsSync(path.join(dir, "agents")) ? readdirSync(path.join(dir, "agents")).filter((f) => f.endsWith(".md")) : [];
    lines.push("", "Adds:");
    for (const c of found) lines.push(`  /${c.command}${c.kind === "skill" ? " (skill)" : ""} ${c.description}`);
    for (const a of agents) lines.push(`  agent ${a.slice(0, -3)}`);
    if (existsSync(path.join(dir, "hooks", "hooks.json"))) lines.push("  hooks (run automatically on Claude Code events)");
    if (existsSync(path.join(dir, ".mcp.json"))) lines.push("  MCP servers (.mcp.json)");
    if (!found.length && !agents.length) lines.push("  nothing AgenticOps Desk can list; see the source");
  } else {
    lines.push("", "The plugin's files live in its own repository, so what it adds shows after installing.");
  }
  return lines.join("\n").trim();
}

function readText(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function scan(p: InstalledPlugin): PluginCommand[] {
  if (!p.installPath || !existsSync(p.installPath)) return [];
  const plugin = p.id.split("@")[0];
  const out: PluginCommand[] = [];
  const cmdDir = path.join(p.installPath, "commands");
  if (existsSync(cmdDir)) {
    for (const f of readdirSync(cmdDir)) {
      if (!f.endsWith(".md")) continue;
      out.push({ command: `${plugin}:${f.slice(0, -3)}`, plugin, pluginId: p.id, kind: "command", enabled: p.enabled, description: describeMarkdown(readText(path.join(cmdDir, f))) });
    }
  }
  const skillDir = path.join(p.installPath, "skills");
  if (existsSync(skillDir)) {
    for (const d of readdirSync(skillDir)) {
      const file = path.join(skillDir, d, "SKILL.md");
      if (!existsSync(file)) continue;
      out.push({ command: `${plugin}:${d}`, plugin, pluginId: p.id, kind: "skill", enabled: p.enabled, description: describeMarkdown(readText(file)) });
    }
  }
  return out;
}

// Slash commands and skills of installed plugins, for the composer's "/" menu (enabled ones only)
// and the Plugins list (all of them).
export async function pluginCommands(includeDisabled = false): Promise<PluginCommand[]> {
  if (!commands) {
    try {
      commands = (await listPlugins()).installed.flatMap(scan).slice(0, 600);
    } catch {
      return [];
    }
  }
  if (includeDisabled) return commands;
  return commands.filter((c) => c.enabled);
}
