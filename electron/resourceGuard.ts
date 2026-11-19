import { execFile } from "node:child_process";
import os from "node:os";
import { affinityMask, modelBudget, shouldStopForMemory, type ModelBudget, type ResourceSample } from "./pureFeatures";

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

// Idle, and off the first two CPUs, so the window keeps a core even while the model loads.
export function relaxProcess(pid: number, logicalCpus: number) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const mask = affinityMask(logicalCpus);
    const affinity = mask == null ? "" : `; try { (Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr]${mask} } catch {}`;
    const shell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    execFile(shell, ["-NoProfile", "-NonInteractive", "-Command", `try { (Get-Process -Id ${pid}).PriorityClass = 'Idle' } catch {}${affinity}`], { windowsHide: true }, () => {});
    return;
  }
  execFile("renice", ["-n", "19", "-p", String(pid)], { windowsHide: true }, () => {});
}
