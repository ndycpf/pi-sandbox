import type { ChildProcess } from "node:child_process";

/**
 * Signal a child spawned with `detached: true` and its whole process group,
 * falling back to the child alone when the group is gone or was never made.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
