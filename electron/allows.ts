import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { insideFolder, permissionGateFor, type AllowEntry } from "./gate";
import { staysInside } from "./pureFeatures";
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

// "Allow always" saves here, so it covers every folder, including each chat's new worktree.
const EVERYWHERE = "*";

function keyFor(workspace: string | undefined, everywhere?: boolean) {
  return everywhere ? EVERYWHERE : workspace ? workspaceKey(workspace) : undefined;
}

let allowAll = false;
// Set from the "Allow everything" setting. Questions and plan approvals still ask.
export function setAllowAll(on: unknown) {
  allowAll = on === true;
}

export function permissionGate(workspace: string | undefined, toolName: string, input: Record<string, unknown>) {
  if (allowAll && toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") return { ask: false } as const;
  const all = load();
  const local = workspace ? all[workspaceKey(workspace)] : undefined;
  const global = all[EVERYWHERE];
  const entry: AllowEntry = {
    trusted: Boolean(local?.trusted || global?.trusted),
    risks: [...(local?.risks ?? []), ...(global?.risks ?? [])],
  };
  // staysInside follows links, so a link inside the project that points outside it still asks.
  const inside = (folder: string, target: string) =>
    insideFolder(folder, target) && staysInside(folder, path.resolve(folder, target), false);
  return permissionGateFor(entry, workspace, toolName, input, inside);
}

export function trustWorkspace(workspace: string | undefined, everywhere?: boolean) {
  const key = keyFor(workspace, everywhere);
  if (!key) return;
  const all = load();
  if (all[key]?.trusted) return;
  all[key] = { ...all[key], trusted: true, risks: all[key]?.risks ?? [] };
  save();
}

export function rememberRisks(workspace: string | undefined, risks: string[], everywhere?: boolean) {
  const key = keyFor(workspace, everywhere);
  if (!key || !risks.length) return;
  const all = load();
  const have = new Set(all[key]?.risks ?? []);
  let changed = false;
  for (const risk of risks) {
    if (have.has(risk)) continue;
    have.add(risk);
    changed = true;
  }
  // Allowing a risk trusts this folder; "everywhere" only adds the risk to the global list.
  if (everywhere) {
    if (changed) {
      all[key] = { trusted: all[key]?.trusted === true, risks: [...have].sort() };
      save();
    }
    trustWorkspace(workspace);
    return;
  }
  if (!changed && all[key]?.trusted) return;
  all[key] = { trusted: true, risks: [...have].sort() };
  save();
}
