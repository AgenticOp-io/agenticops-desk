import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import { affinityMask, modelBudget, parseProcessTable, pythonPidsInTree, shouldStopForMemory, type ModelBudget, type ResourceSample } from "./pureFeatures";

export function sampleResources(): ResourceSample {
  return { freeBytes: os.freemem(), logicalCpus: os.availableParallelism?.() ?? os.cpus().length };
}

export function budgetFor(modelBytes: number): ModelBudget {
  return modelBudget(sampleResources(), modelBytes);
}

export function memoryIsLow(): boolean {
  return shouldStopForMemory(os.freemem());
}

// While the model is running, stop it if free RAM falls through the floor. Cheap enough to poll.
export function watchMemory(onLow: () => void): () => void {
  const timer = setInterval(() => {
    if (shouldStopForMemory(os.freemem())) onLow();
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

export function preferApp() {
  try {
    os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {
    // Some platforms reject the class. The model is still capped on its own.
  }
}

export function releaseApp() {
  try {
    os.setPriority(os.constants.priority.PRIORITY_NORMAL);
  } catch {
    // Ignore. Quitting must not fail because the priority could not be restored.
  }
}

// Libraries Python imports (NumPy and the rest) read these. Two threads, even if the machine has more.
export function quietThreads(): Record<string, string> {
  const n = "2";
  return {
    OMP_NUM_THREADS: n,
    OPENBLAS_NUM_THREADS: n,
    MKL_NUM_THREADS: n,
    NUMEXPR_NUM_THREADS: n,
    VECLIB_MAXIMUM_THREADS: n,
  };
}

const PROCESS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }";

function winShell() {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function readProcessTable(): Promise<string> {
  if (process.platform !== "win32") return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(
      winShell(),
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_LIST],
      { windowsHide: true, timeout: 8_000, maxBuffer: 4_000_000 },
      (err, stdout) => resolve(err ? "" : String(stdout ?? "")),
    );
  });
}

let scanning = false;

// Python is not started by this app. It is a child of the agent, the terminal, or a check. Keep it off the app's cores, and end it when free memory is gone.
export function releasePythons() {
  if (process.platform !== "win32" || scanning) return;
  scanning = true;
  void readProcessTable().then((text) => {
    scanning = false;
    const pids = pythonPidsInTree(parseProcessTable(text), process.pid);
    if (!pids.length) return;
    if (memoryIsLow()) {
      for (const pid of pids) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      return;
    }
    const mask = affinityMask(sampleResources().logicalCpus);
    const affinity = mask == null ? "" : `; try { (Get-Process -Id $p).ProcessorAffinity = [IntPtr]${mask} } catch {}`;
    const command = `foreach ($p in ${pids.join(",")}) { try { (Get-Process -Id $p).PriorityClass = 'Idle' } catch {}${affinity} }`;
    execFile(winShell(), ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, () => {});
  });
}

// End Python this app opened, so a frozen window or a quit is not left waiting on it.
export function stopPythons() {
  if (process.platform !== "win32") return;
  try {
    const text = execFileSync(winShell(), ["-NoProfile", "-NonInteractive", "-Command", PROCESS_LIST], {
      windowsHide: true,
      timeout: 8_000,
      encoding: "utf8",
      maxBuffer: 4_000_000,
    });
    for (const pid of pythonPidsInTree(parseProcessTable(text), process.pid)) {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Quitting must not fail because the process list could not be read.
  }
}

export function watchPythons() {
  if (process.platform !== "win32") return;
  const timer = setInterval(() => releasePythons(), 2000);
  timer.unref();
}

// Idle, and off the first two CPUs, so the window keeps a core even while the model loads.
export function relaxProcess(pid: number, logicalCpus: number) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const mask = affinityMask(logicalCpus);
    const affinity = mask == null ? "" : `; try { (Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr]${mask} } catch {}`;
    execFile(winShell(), ["-NoProfile", "-NonInteractive", "-Command", `try { (Get-Process -Id ${pid}).PriorityClass = 'Idle' } catch {}${affinity}`], { windowsHide: true }, () => {});
    return;
  }
  execFile("renice", ["-n", "19", "-p", String(pid)], { windowsHide: true }, () => {});
}
