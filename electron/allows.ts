import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { permissionGateFor, type AllowEntry } from "./gate";
import { writeJsonAtomicSync } from "./jsonStore";

export { riskKeys } from "./gate";
export type { PermissionGate } from "./gate";

// One yes trusts a folder for coding: edits, tests, git, and network.
// Disk format, administrator commands, and shutdown still ask, then that action is remembered.
type AllowBook = Record<string, AllowEntry>;

let book: AllowBook | null = null;

function file() {
  return path.join(app.getPath("userData"), "allows.json");
}

function asEntry(value: unknown): AllowEntry {
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
  try {
    writeJsonAtomicSync(file(), load());
  } catch (err) {
    console.error("AgenticOps Desk could not save remembered allows", err);
  }
}

function workspaceKey(workspace: string) {
  return path.resolve(workspace).replace(/[\\/]+$/, "").toLowerCase();
}

export function permissionGate(workspace: string | undefined, toolName: string, input: Record<string, unknown>) {
  const entry = workspace ? load()[workspaceKey(workspace)] : undefined;
  return permissionGateFor(entry, workspace, toolName, input);
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
