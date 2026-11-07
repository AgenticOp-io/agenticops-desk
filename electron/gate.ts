// Folder trust, without Electron. A trusted folder lets ordinary coding run.
// Disk format, administrator commands, and shutdown still ask, then that action is remembered.
// Questions and plan approvals always ask, even in a trusted folder.

export type AllowEntry = { trusted?: boolean; risks?: string[] };

const RISK_RULES: Array<{ key: string; test: RegExp }> = [
  { key: "format", test: /\bformat-volume\b|\bformat\s+[a-z]:/i },
  { key: "sudo", test: /\b(?:sudo|runas)\b/i },
  { key: "shutdown", test: /\b(?:shutdown|restart-computer|stop-computer)\b/i },
];

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

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function editTarget(input: Record<string, unknown>) {
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return typeof p === "string" ? p : "";
}

// Plain string check so this file stays free of Node and Electron. Rejects "..", other drives and siblings
// that only share a prefix (C:\proj2 is not inside C:\proj).
export function insideFolder(folder: string, target: string): boolean {
  if (!target || /(^|[\\/])\.\.([\\/]|$)/.test(target)) return false;
  const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const root = norm(folder);
  const file = /^[a-z]:|^\\\\|^\//i.test(target) ? norm(target) : `${root}\\${norm(target)}`;
  return file.startsWith(`${root}\\`);
}

export type PermissionGate =
  | { ask: false }
  | { ask: true; kind: "question" }
  | { ask: true; kind: "trust"; summary: string; note: string }
  | { ask: true; kind: "risk"; summary: string; note: string; risks: string[] }
  | { ask: true; kind: "login"; summary: string; note: string };

export function permissionGateFor(
  entry: AllowEntry | undefined,
  workspace: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): PermissionGate {
  if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode") return { ask: true, kind: "question" };
  const trusted = entry?.trusted === true;
  const saved = new Set(entry?.risks ?? []);
  const shell = toolName === "Bash" || toolName === "PowerShell";
  const fresh = (shell ? riskKeys(commandOf(input)) : []).filter((key) => !saved.has(key));
  if (fresh.length) {
    const folder = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : "this folder";
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
  // File edits inside the open folder never wait on the user: each file is snapshotted first, and the
  // change bar lets the user review or undo it afterwards. Commands and edits elsewhere still ask once.
  if (EDIT_TOOLS.has(toolName) && workspace && insideFolder(workspace, editTarget(input))) return { ask: false };
  const folder = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : "this folder";
  return {
    ask: true,
    kind: "trust",
    summary: `Let the agent work in ${folder}`,
    note: "Edits, tests, git, and network just run after this. Disk format, administrator commands, and shutdown still ask.",
  };
}
