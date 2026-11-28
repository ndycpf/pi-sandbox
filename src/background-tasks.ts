import type { ChildProcess } from "node:child_process";

import { OutputTail } from "./output-tail.ts";
import { killProcessGroup } from "./process-group.ts";

/** Where a background task runs: inside the OS sandbox, or on the host via host_bash. */
export type BackgroundKind = "sandbox" | "host" | "unsandboxed";

export type BackgroundTaskInfo = {
  id: string;
  kind: BackgroundKind;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: string;
  state: "running" | "exited" | "stopping";
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: string;
  outputBytes: number;
};

export const isLive = (info: BackgroundTaskInfo) => info.state !== "exited";

type Task = {
  info: BackgroundTaskInfo;
  child: ChildProcess;
  tail: OutputTail;
  /** Bytes of output the agent may see from this task (host_bash's outputBytes for host tasks). */
  visibleBytes: number;
  exited: Promise<void>;
  killTimer?: NodeJS.Timeout;
  /** Called on new output and on exit, for `wait`. */
  listeners: Set<() => void>;
};

export type WaitResult = {
  info: BackgroundTaskInfo;
  reason: "exited" | "matched" | "timeout" | "aborted";
};

/** How long a task gets after SIGTERM before its process group is killed. */
export const STOP_GRACE_MS = 2000;
/** Finished tasks kept for `logs` and `list`. */
const KEEP_FINISHED = 20;

export type BackgroundExit = { info: BackgroundTaskInfo; tail: string };

/**
 * Tracks long-running processes started for the agent. Every task belongs to
 * the current Pi session: `stopAll` runs on session shutdown and whenever the
 * sandbox is turned on or off, and a process-exit hook kills whatever is left
 * if Pi exits without that.
 */
export class BackgroundTasks {
  private tasks = new Map<string, Task>();
  private next = 1;
  private exitHook?: () => void;

  constructor(
    private readonly onExit?: (exit: BackgroundExit) => void,
    /** Called whenever a task starts, starts stopping, or exits. */
    private readonly onChange?: () => void,
  ) {}

  running(): number {
    let count = 0;
    for (const task of this.tasks.values()) if (isLive(task.info)) count++;
    return count;
  }

  /**
   * Take ownership of a spawned child. It must be spawned `detached` so its
   * process group can be signalled. `cleanup` runs once, after it exits.
   */
  add(options: {
    kind: BackgroundKind;
    command: string;
    cwd: string;
    child: ChildProcess;
    bufferBytes: number;
    visibleBytes: number;
    cleanup?: () => void;
  }): BackgroundTaskInfo {
    const { child } = options;
    const id = `bg${this.next++}`;
    const tail = new OutputTail(Math.max(1, options.bufferBytes));
    const info: BackgroundTaskInfo = {
      id,
      kind: options.kind,
      command: options.command,
      cwd: options.cwd,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      state: "running",
      outputBytes: 0,
    };
    const listeners = new Set<() => void>();
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        tail.push(chunk);
        info.outputBytes = tail.total;
        for (const listener of listeners) listener();
      });
      stream?.on("error", () => {});
    }
    let cleaned = false;
    const exited = new Promise<void>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (info.state === "exited") return;
        // Tasks the agent or the session stopped are not reported again.
        const stopped = info.state === "stopping";
        const task = this.tasks.get(id);
        if (task?.killTimer) clearTimeout(task.killTimer);
        info.state = "exited";
        info.exitCode = code;
        info.signal = signal;
        info.endedAt = new Date().toISOString();
        // Detached descendants may hold the pipes open; the task is over when
        // its shell is, and stop() already signalled the whole group.
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!cleaned) {
          cleaned = true;
          options.cleanup?.();
        }
        this.prune();
        this.updateExitHook();
        resolve();
        for (const listener of listeners) listener();
        if (!stopped)
          this.onExit?.({ info: { ...info }, tail: tail.text(task?.visibleBytes ?? 0) });
      };
      child.once("exit", finish);
      child.once("error", () => finish(null, null));
    });
    this.tasks.set(id, {
      info,
      child,
      tail,
      visibleBytes: Math.min(options.visibleBytes, tail.limit),
      exited,
      listeners,
    });
    this.updateExitHook();
    return { ...info };
  }

  list(): BackgroundTaskInfo[] {
    return [...this.tasks.values()].map((task) => ({ ...task.info }));
  }

  get(id: string): BackgroundTaskInfo | undefined {
    const task = this.tasks.get(id);
    return task && { ...task.info };
  }

  /**
   * Wait until the task exits, its new output matches `until`, the time runs
   * out or `signal` aborts. The task keeps running unless it exited. Only
   * output written after the wait starts can match. `onOutput` runs on each
   * change, for streaming progress.
   */
  async wait(
    id: string,
    options: { timeoutMs: number; until?: RegExp; signal?: AbortSignal; onOutput?: () => void },
  ): Promise<WaitResult | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.info.state === "exited") return { info: { ...task.info }, reason: "exited" };
    const from = task.tail.total;
    return new Promise<WaitResult>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (reason: WaitResult["reason"]) => {
        task.listeners.delete(check);
        options.signal?.removeEventListener("abort", aborted);
        if (timer) clearTimeout(timer);
        resolve({ info: { ...task.info }, reason });
      };
      const check = () => {
        if (task.info.state === "exited") return done("exited");
        options.onOutput?.();
        if (options.until) {
          const fresh = Math.min(task.tail.total - from, task.tail.limit);
          if (fresh > 0 && options.until.test(task.tail.text(fresh))) done("matched");
        }
      };
      const aborted = () => done("aborted");
      if (options.signal?.aborted) return aborted();
      task.listeners.add(check);
      options.signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => done("timeout"), options.timeoutMs);
    });
  }

  /** The visible tail of a task's combined output, or undefined for an unknown id. */
  logs(id: string, bytes?: number): { info: BackgroundTaskInfo; text: string } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const limit = Math.min(bytes ?? task.visibleBytes, task.visibleBytes);
    return { info: { ...task.info }, text: limit > 0 ? task.tail.text(limit) : "" };
  }

  /** SIGTERM the task's process group, then SIGKILL it after a grace period. */
  async stop(id: string, graceMs = STOP_GRACE_MS): Promise<BackgroundTaskInfo | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.info.state === "running") {
      task.info.state = "stopping";
      this.onChange?.();
      killProcessGroup(task.child, "SIGTERM");
      task.killTimer = setTimeout(() => killProcessGroup(task.child, "SIGKILL"), graceMs);
    }
    await task.exited;
    return { ...task.info };
  }

  /** Stop every task and wait for them to exit. */
  async stopAll(graceMs = STOP_GRACE_MS): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((id) => this.stop(id, graceMs)));
  }

  private prune() {
    const finished = [...this.tasks.values()].filter((task) => task.info.state === "exited");
    for (const task of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.tasks.delete(task.info.id);
    }
  }

  // If Pi exits without a session_shutdown, do not leave tasks behind.
  private updateExitHook() {
    this.onChange?.();
    const live = this.running() > 0;
    if (live && !this.exitHook) {
      this.exitHook = () => {
        for (const task of this.tasks.values())
          if (isLive(task.info)) killProcessGroup(task.child, "SIGKILL");
      };
      process.on("exit", this.exitHook);
    } else if (!live && this.exitHook) {
      process.off("exit", this.exitHook);
      this.exitHook = undefined;
    }
  }
}
