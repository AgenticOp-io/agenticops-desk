// "Train your own model": the user's chats become training examples (trainData.ts), go over SSH to a GPU machine
// the user names, and scripts/eval/gpu-train.sh there fine-tunes, merges and loads the result into its Ollama
// as "desk-coder", which the Cloud GPU provider then lists.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import GPU_TRAIN_SH from "../scripts/eval/gpu-train.sh?raw";
import TRAIN_PY from "../scripts/eval/train.py?raw";
import { writeJsonAtomicSync } from "./jsonStore";
import { privacyMode } from "./privacy";
import { collectChats } from "./trainData";

type Saved = { host: string; leaveOut: string[] };
export type TrainState = Saved & {
  busy: string; // what this computer is doing right now, "" when idle
  examples?: { rows: number; chats: number; leftOut: number; bytes: number };
  remote?: { running: boolean; stage: string; line: string };
  error?: string;
};

const deskDir = () => app.getPath("userData");
const file = () => path.join(deskDir(), "train-model.json");
let state: TrainState = { host: "", leaveOut: [], busy: "" };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Partial<Saved>;
    state.host = typeof raw.host === "string" ? raw.host : "";
    state.leaveOut = Array.isArray(raw.leaveOut) ? raw.leaveOut.map(String) : [];
  } catch {
    /* first use */
  }
}

// Goes to ssh as an argument: a host alias, host name or user@host, never something ssh reads as an option.
export const validHost = (h: string) => /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(h);

export function run(cmd: string, args: string[], cwd?: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join("\n"))) : resolve(stdout),
    ),
  );
}
export const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const ssh = (command: string, timeout?: number) => run("ssh", [...sshArgs, state.host, command], undefined, timeout);

export function trainState(): TrainState {
  load();
  return { ...state };
}

export function trainSetup(patch: { host?: string; leaveOut?: string[] }): TrainState {
  load();
  if (typeof patch.host === "string" && !state.busy) { // a running upload keeps the host it started with
    const host = patch.host.trim();
    if (host && !validHost(host)) return { ...state, error: "Use an SSH host name, alias or user@host." };
    state.host = host;
  }
  if (Array.isArray(patch.leaveOut)) state.leaveOut = patch.leaveOut.map((w) => String(w).trim()).filter(Boolean);
  state.error = undefined;
  writeJsonAtomicSync(file(), { host: state.host, leaveOut: state.leaveOut });
  return { ...state };
}

async function busy(what: string, work: () => Promise<void>): Promise<TrainState> {
  load();
  if (state.busy) return { ...state };
  state.busy = what;
  state.error = undefined;
  try {
    await work();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.busy = "";
  }
  return { ...state };
}

// Collects and writes the examples on this computer only, so the user sees the count before anything is sent.
const collect = async () => {
  const set = await collectChats({ deskDir: deskDir(), leaveOut: state.leaveOut });
  const dir = path.join(deskDir(), "train");
  mkdirSync(dir, { recursive: true });
  const body = set.rows.join("\n") + "\n";
  writeFileSync(path.join(dir, "chats.jsonl"), body);
  state.examples = { rows: set.rows.length, chats: set.chats, leftOut: set.leftOut, bytes: Buffer.byteLength(body) };
  return dir;
};

export const trainPreview = () => busy("Reading your chats", async () => void (await collect()));

export const trainStart = () =>
  busy("Reading your chats", async () => {
    if (privacyMode() === "local") throw new Error("Local only mode is on, and training sends your chats to the GPU machine.");
    if (!state.host) throw new Error("Enter the GPU machine's SSH host first.");
    state.busy = "Checking the GPU machine";
    await remote();
    if (state.remote?.running) return;
    // A run stopped partway (a spot preemption) resumes on the examples already there; new ones would restart it.
    if (state.remote?.stage && state.remote.stage !== "done") {
      await ssh("bash ~/train/gpu-train.sh all");
      return void (await remote());
    }
    state.busy = "Reading your chats";
    const dir = await collect();
    if (!state.examples?.rows) throw new Error("No chats to learn from yet.");
    // Unix line endings: a Windows checkout may hand these over with CRLF, which bash rejects.
    writeFileSync(path.join(dir, "gpu-train.sh"), GPU_TRAIN_SH.replace(/\r\n/g, "\n"));
    writeFileSync(path.join(dir, "train.py"), TRAIN_PY.replace(/\r\n/g, "\n"));
    state.busy = "Sending examples to " + state.host;
    await ssh("mkdir -p ~/train");
    // Relative names with cwd: scp would read a drive letter such as C: as a host name.
    await run("scp", ["-B", "-q", ...sshArgs, "chats.jsonl", "train.py", "gpu-train.sh", `${state.host}:train/`], dir, 15 * 60_000);
    state.busy = "Starting the training";
    await ssh("bash ~/train/gpu-train.sh all");
    await remote();
  });

async function remote() {
  if (!state.host) throw new Error("Enter the GPU machine's SSH host first.");
  const [run = "", stage = "", line = ""] = (await ssh("bash ~/train/gpu-train.sh status 2>/dev/null || echo stopped")).split("\n"); // no script yet = never started; an unreachable host still throws
  state.remote = { running: run.trim() === "running", stage: stage.replace(/^STAGE /, "").trim(), line: line.trim().slice(0, 300) };
}

export const trainCheck = () => busy("Checking the GPU machine", remote);
