import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

// One yes trusts a folder for coding: edits, tests, git, and network.
// Disk format, administrator commands, and shutdown still ask, then that action is remembered.
type Entry = { trusted?: boolean; risks?: string[] };
type AllowBook = Record<string, Entry>;

const RISK_RULES: Array<{ key: string; test: RegExp }> = [
  { key: "format", test: /\bformat-volume\b|\bformat\s+[a-z]:/i },
  { key: "sudo", test: /\b(?:sudo|runas)\b/i },
  { key: "shutdown", test: /\b(?:shutdown|restart-computer|stop-computer)\b/i },
];

let book: AllowBook | null = null;

function file() {
  return path.join(app.getPath("userData"), "allows.json");
}

function asEntry(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  if ("trusted" in rec || "risks" in rec) {
    return {
      trusted: rec.trusted === true,
      risks: Array.isArray(rec.risks) ? rec.risks.filter((r): r is string => typeof r === "string") : [],
    };
  }
  // Older builds stored every allowed program. That already meant the folder was trusted.
  return { trusted: true, risks: [] };
}

function load(): AllowBook {
  if (book) return book;
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    book = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) book[key] = asEntry(value);
    }
  } catch {
    book = {};
  }
  return book;
}

function save() {
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(load(), null, 2), "utf8");
    renameSync(tmp, target);
  } catch (err) {
    console.error("ClaudeDesk could not save remembered allows", err);
  }
}

function workspaceKey(workspace: string) {
  return path.resolve(workspace).replace(/[\\/]+$/, "").toLowerCase();
}

export function riskKeys(command: string): string[] {
  const keys = new Set<string>();
  for (const part of command.split(/\s*(?:&&|\|\||[|;\n])\s*/)) {
    for (const rule of RISK_RULES) {
      if (rule.test.test(part)) keys.add(rule.key);
    }
  }
  return [...keys];
}

function commandOf(input: Record<string, unknown>) {
  const command = input.command ?? input.cmd ?? input.script;
  return typeof command === "string" ? command : "";
}

export type PermissionGate =
  | { ask: false }
  | { ask: true; kind: "question" }
  | { ask: true; kind: "trust"; summary: string; note: string }
  | { ask: true; kind: "risk"; summary: string; note: string; risks: string[] };

export function permissionGate(
  workspace: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): PermissionGate {
  // Questions and plans always need the user to read them, so trust never answers them.
  if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") return { ask: true, kind: "question" };
  const entry = workspace ? load()[workspaceKey(workspace)] : undefined;
  const trusted = entry?.trusted === true;
  const saved = new Set(entry?.risks ?? []);
  const shell = toolName === "Bash" || toolName === "PowerShell";
  const fresh = (shell ? riskKeys(commandOf(input)) : []).filter((key) => !saved.has(key));
  if (fresh.length) {
    const folder = workspace ? path.basename(workspace) : "this folder";
    return {
      ask: true,
      kind: "risk",
      summary: fresh.length === 1 ? `Run ${fresh[0]}` : `Run ${fresh.join(" and ")}`,
      note: trusted
        ? "Allow remembers this in the project. Other work keeps going."
        : `Allow remembers this, and lets Claude edit, test, use git, and reach the network in ${folder}.`,
      risks: fresh,
    };
  }
  if (trusted) return { ask: false };
  const folder = workspace ? path.basename(workspace) : "this folder";
  return {
    ask: true,
    kind: "trust",
    summary: `Let Claude work in ${folder}`,
    note: "Edits, tests, git, and network just run after this. Disk format, administrator commands, and shutdown still ask.",
  };
}

export function trustWorkspace(workspace: string | undefined) {
  if (!workspace) return;
  const all = load();
  const key = workspaceKey(workspace);
  if (all[key]?.trusted) return;
  all[key] = { ...all[key], trusted: true, risks: all[key]?.risks ?? [] };
  save();
}

export function rememberRisks(workspace: string | undefined, risks: string[]) {
  if (!workspace || !risks.length) return;
  const all = load();
  const key = workspaceKey(workspace);
  const have = new Set(all[key]?.risks ?? []);
  let changed = false;
  for (const risk of risks) {
    if (have.has(risk)) continue;
    have.add(risk);
    changed = true;
  }
  if (!changed && all[key]?.trusted) return;
  all[key] = { trusted: true, risks: [...have].sort() };
  save();
}
