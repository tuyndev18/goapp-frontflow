import { spawn } from "node:child_process";

/**
 * Kills a process and all its descendants. On Windows uses `taskkill /T /F`;
 * elsewhere signals the process group (children are spawned detached).
 */
export function killProcessTree(pid: number, graceMs = 1500): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      tk.once("error", () => resolve());
      tk.once("exit", () => resolve());
    });
  }
  const signal = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signal("SIGTERM")) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started >= graceMs) {
        clearInterval(tick);
        signal("SIGKILL");
        resolve();
      }
    }, 50);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
