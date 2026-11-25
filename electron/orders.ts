import { spawn } from "node:child_process";
import { quietThreads } from "./resourceGuard";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { cliPromptEnv, globToRegExp } from "./pureFeatures";
import { writeJsonAtomicSync } from "./jsonStore";

// Standing orders: per-project rules that AgenticOps Desk enforces instead of hoping the model follows them.
// - rules: plain sentences added to the system prompt
// - protect: paths Claude may not edit (globs relative to the project, e.g. "migrations/**" or "*.lock")
// - checks: commands that must pass before a run that changed files counts as finished; a failure goes
//   back to Claude with the output, up to maxFixes times
export type Orders = { rules: string[]; protect: string[]; checks: string[]; maxFixes: number };

const EMPTY: Orders = { rules: [], protect: [], checks: [], maxFixes: 3 };

function file(workspace: string) {
  const key = path.resolve(workspace).toLowerCase();
  const id = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return path.join(app.getPath("userData"), "orders", `${id}.json`);
}

const list = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 50) : [];

export function loadOrders(workspace: string): Orders {
  try {
    const raw = JSON.parse(readFileSync(file(workspace), "utf8")) as Partial<Orders>;
    return {
      rules: list(raw.rules),
      protect: list(raw.protect),
      checks: list(raw.checks),
      maxFixes: Math.min(10, Math.max(0, Number(raw.maxFixes) || EMPTY.maxFixes)),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveOrders(workspace: string, next: Partial<Orders>): Orders {
  const merged: Orders = {
    rules: list(next.rules),
    protect: list(next.protect),
    checks: list(next.checks),
    maxFixes: Math.min(10, Math.max(0, Number(next.maxFixes) || EMPTY.maxFixes)),
  };
  writeJsonAtomicSync(file(workspace), merged);
  return merged;
}

// A team can commit .agenticops/orders.json so everyone gets the same rules and protected paths. Read only.
// Its checks are ignored: a cloned repo must not be able to run commands on this computer by itself.
export function teamOrders(workspace: string): Pick<Orders, "rules" | "protect"> {
  try {
    const raw = JSON.parse(readFileSync(path.join(workspace, ".agenticops", "orders.json"), "utf8")) as Partial<Orders>;
    return { rules: list(raw.rules), protect: list(raw.protect) };
  } catch {
    return { rules: [], protect: [] };
  }
}

// What a run obeys: this computer's orders plus the repo's team orders.
export function runOrders(workspace: string): Orders {
  const own = loadOrders(workspace);
  const team = teamOrders(workspace);
  return {
    ...own,
    rules: [...new Set([...own.rules, ...team.rules])],
    protect: [...new Set([...own.protect, ...team.protect])],
  };
}

// The pattern that protects this file, or null when Claude may edit it.
export function protectedBy(workspace: string, target: string, orders = runOrders(workspace)): string | null {
  if (!orders.protect.length || !target) return null;
  const rel = path.relative(workspace, path.resolve(workspace, target)).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  // Windows paths ignore case, so "Migrations/x" must hit a "migrations/**" rule.
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  return orders.protect.find((p) => globToRegExp(fold(p)).test(fold(rel))) ?? null;
}

export function ordersPrompt(orders: Orders): string {
  if (!orders.rules.length && !orders.protect.length && !orders.checks.length) return "";
  const parts = ["# Standing orders for this project (enforced by AgenticOps Desk)"];
  if (orders.rules.length) parts.push(...orders.rules.map((r) => `- ${r}`));
  if (orders.protect.length) parts.push(`- Do not edit these paths; AgenticOps Desk refuses the edit: ${orders.protect.join(", ")}`);
  if (orders.checks.length) {
    parts.push(`- When you finish a change, AgenticOps Desk runs these and sends failures back to you: ${orders.checks.join(" ; ")}`);
  }
  return parts.join("\n");
}

function shell(command: string) {
  if (process.platform !== "win32") return { exe: process.env.SHELL || "/bin/bash", args: ["-lc", command] };
  const seven = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  return { exe: existsSync(seven) ? seven : "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
}

export function runCheck(workspace: string, command: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const { exe, args } = shell(command);
    const child = spawn(exe, args, {
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1", ...cliPromptEnv(), ...quietThreads() },
    });
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = () => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      out += "\n(stopped after 10 minutes)";
      kill();
    }, 600_000);
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start the check: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().slice(-4000) });
    });
  });
}

// Runs every check in order and stops at the first failure.
export async function runChecks(workspace: string, checks: string[], signal?: AbortSignal, onStart?: (cmd: string) => void) {
  for (const cmd of checks) {
    onStart?.(cmd);
    const r = await runCheck(workspace, cmd, signal);
    if (!r.ok) return { ok: false as const, command: cmd, output: r.output };
  }
  return { ok: true as const };
}
