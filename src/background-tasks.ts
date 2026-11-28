import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

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
  /** Resolves when the task is over: its shell exited and, if stopped, its process group is gone. */
  exited: Promise<void>;
  /** Resolves when the task's shell has exited. */
  shellExited: Promise<void>;
  /** Ends the task once a stop has seen its process group go. */
  finalize: () => void;
  /** Set by stop() until the process group is gone or killed. */
  stopping?: Promise<void>;
  /** Called on new output and on exit, for `wait`. */
  listeners: Set<() => void>;
};

export type WaitResult = {
  info: BackgroundTaskInfo;
  reason: "exited" | "matched" | "timeout" | "aborted";
};

/** How long a task gets after SIGTERM before its process group is killed. */
export const STOP_GRACE_MS = 2000;
/** How often a stop checks whether the process group is gone. */
const GROUP_POLL_MS = 25;
/** How often a task whose shell exited checks whether the rest of its group is gone. */
const GROUP_WATCH_MS = 250;
/** How long a finished task's output gets to drain. */
const DRAIN_MS = 200;
/** Finished tasks kept for `logs` and `list`. */
const KEEP_FINISHED = 20;

export type BackgroundExit = { info: BackgroundTaskInfo; tail: string };

/**
 * Whether a process other than a zombie is in process group `pgid`, from a
 * `/proc`-style directory. Undefined when it cannot be read.
 */
export function groupHasLiveProcess(pgid: number, procDir = "/proc"): boolean | undefined {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(procDir, entry, "stat"), "utf8");
    } catch {
      continue; // Gone, or hidden from us.
    }
    // "pid (comm) state ppid pgrp ..."; comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
}

/**
 * Whether any process in the group led by `pid` still runs. On Linux, zombies
 * do not count: where PID 1 does not reap orphans, a finished worker can stay
 * a zombie in the group indefinitely.
 */
function groupAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform !== "linux") return true;
  return groupHasLiveProcess(pid) ?? true;
}

/** Resolves once a stream has closed. */
function drained(stream: Readable | null) {
  return new Promise<void>((resolve) => {
    if (!stream || stream.destroyed || stream.closed) return resolve();
    stream.once("close", () => resolve());
  });
}

/**
 * A slot held for a task that is being started (spawned or approved), so
 * concurrent starts cannot exceed the limit. Pass it to `add`, or release it
 * when the start fails.
 */
export class Reservation {
  private done = false;
  constructor(
    readonly epoch: number,
    private readonly free: () => void,
  ) {}
  /** Give the slot back. Safe to call more than once. */
  release() {
    if (this.done) return;
    this.done = true;
    this.free();
  }
}

/** A start whose sandbox state changed before it finished; its process was killed. */
export class StaleStartError extends Error {}

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
  private reserved = 0;
  private holds = 0;
  /** Bumped by `hold`, so starts begun before it cannot add a task after it. */
  private epoch = 0;

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
   * Reserve a slot for a new task, counting running tasks and other
   * reservations against `max`. Returns why not when the limit is reached or
   * starts are held (the sandbox is changing or the session is ending).
   */
  reserve(max: number): Reservation | { refused: "full" | "held" } {
    if (this.holds > 0) return { refused: "held" };
    if (this.running() + this.reserved >= max) return { refused: "full" };
    this.reserved++;
    return new Reservation(this.epoch, () => this.reserved--);
  }

  /**
   * Refuse new starts until the returned function is called. Starts already in
   * flight are killed when they try to add their task, so a stopAll during the
   * hold leaves nothing from before it running.
   */
  hold(): () => void {
    this.holds++;
    this.epoch++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
    };
  }

  /**
   * Take ownership of a spawned child. It must be spawned `detached` so its
   * process group can be signalled. `cleanup` runs once, after it exits. With a
   * reservation from before the latest `hold`, the child is killed instead and
   * StaleStartError is thrown.
   */
  add(options: {
    kind: BackgroundKind;
    command: string;
    cwd: string;
    child: ChildProcess;
    bufferBytes: number;
    visibleBytes: number;
    cleanup?: () => void;
    reservation?: Reservation;
    /** Output read before the hand-over (Node drops unread output when a child exits). */
    output?: Buffer[];
  }): BackgroundTaskInfo {
    const { child } = options;
    options.reservation?.release();
    if (options.reservation && options.reservation.epoch !== this.epoch) {
      killProcessGroup(child, "SIGKILL");
      const cleanup = options.cleanup;
      if (cleanup) {
        let once = false;
        const run = () => {
          if (once) return;
          once = true;
          cleanup();
        };
        if (child.exitCode !== null || child.signalCode !== null) run();
        else {
          child.once("exit", run);
          child.once("error", run);
        }
      }
      throw new StaleStartError(
        "Background task not started: the sandbox was turned on or off, or the session ended, while it was starting.",
      );
    }
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
    for (const chunk of options.output ?? []) tail.push(chunk);
    info.outputBytes = tail.total;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        tail.push(chunk);
        info.outputBytes = tail.total;
        for (const listener of listeners) listener();
      });
      stream?.on("error", () => {});
    }
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => (resolveExited = resolve));
    let resolveShell!: () => void;
    const shellExited = new Promise<void>((resolve) => (resolveShell = resolve));
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      // Tasks the agent or the session stopped are not reported again.
      const stopped = info.state === "stopping";
      info.state = "exited";
      info.endedAt = new Date().toISOString();
      // Detached descendants may hold the pipes open; the task is over when
      // its shell is (and, when stopped, its whole process group).
      child.stdout?.destroy();
      child.stderr?.destroy();
      options.cleanup?.();
      this.prune();
      this.updateExitHook();
      resolveExited();
      for (const listener of listeners) listener();
      if (!stopped) this.onExit?.({ info: { ...info }, tail: tail.text(task.visibleBytes) });
    };
    let shellDone = false;
    const shellExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (shellDone) return;
      shellDone = true;
      info.exitCode = code;
      info.signal = signal;
      resolveShell();
      // A stop finalizes once the rest of the process group is gone too.
      if (info.state !== "stopping") void outlive();
    };
    // A launcher that exits while its group runs on (`server &`) leaves the
    // task running until the last process in the group is gone, so the group
    // stays listed, stoppable and killed on exit.
    const outlive = async () => {
      while (info.state === "running" && groupAlive(child.pid)) {
        await new Promise((resolve) => setTimeout(resolve, GROUP_WATCH_MS));
      }
      if (info.state !== "running") return;
      // Read what the group wrote before it ended; a descendant that left the
      // group may hold the pipes open, so only for a moment.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([child.stdout, child.stderr].map(drained)),
        new Promise((resolve) => (timer = setTimeout(resolve, DRAIN_MS))),
      ]);
      clearTimeout(timer);
      if (info.state === "running") finalize();
    };
    child.once("exit", shellExit);
    child.once("error", () => shellExit(null, null));
    // A short command may have exited before it was handed over.
    if (child.exitCode !== null || child.signalCode !== null)
      queueMicrotask(() => shellExit(child.exitCode, child.signalCode));
    const task: Task = {
      info,
      child,
      tail,
      visibleBytes: Math.min(options.visibleBytes, tail.limit),
      exited,
      shellExited,
      finalize,
      listeners,
    };
    this.tasks.set(id, task);
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

  /**
   * SIGTERM the task's process group, then SIGKILL it if anything in the
   * group is left after the grace period, even when the shell itself exited
   * earlier. Resolves once the task is over.
   */
  async stop(id: string, graceMs = STOP_GRACE_MS): Promise<BackgroundTaskInfo | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.info.state === "running") {
      task.info.state = "stopping";
      this.onChange?.();
      task.stopping = this.supervise(task, graceMs);
    }
    await task.stopping;
    await task.exited;
    return { ...task.info };
  }

  private async supervise(task: Task, graceMs: number) {
    const pid = task.child.pid;
    killProcessGroup(task.child, "SIGTERM");
    const deadline = Date.now() + graceMs;
    let shellDone = false;
    void task.shellExited.then(() => (shellDone = true));
    while (Date.now() < deadline) {
      if (shellDone && !groupAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    }
    if (!shellDone || groupAlive(pid)) {
      killProcessGroup(task.child, "SIGKILL");
      await task.shellExited;
    }
    task.finalize();
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
