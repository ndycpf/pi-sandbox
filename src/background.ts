import type { ChildProcess } from "node:child_process";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BackgroundBashConfig } from "./config.ts";

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

/** Keeps the last `limit` bytes written to it. */
export class OutputTail {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  constructor(readonly limit: number) {}
  push(chunk: Buffer) {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.kept += chunk.length;
    while (this.chunks.length > 1 && this.kept - this.chunks[0]!.length >= this.limit) {
      this.kept -= this.chunks.shift()!.length;
    }
  }
  /** The last `bytes` bytes (at most `limit`), decoded as UTF-8. */
  text(bytes = this.limit) {
    const all = Buffer.concat(this.chunks);
    const shown = Math.min(bytes, this.limit, all.length);
    return new TextDecoder("utf-8").decode(all.subarray(all.length - shown));
  }
}

type Task = {
  info: BackgroundTaskInfo;
  child: ChildProcess;
  tail: OutputTail;
  /** Bytes of output the agent may see from this task (host_bash's outputBytes for host tasks). */
  visibleBytes: number;
  exited: Promise<void>;
  killTimer?: NodeJS.Timeout;
};

/** How long a task gets after SIGTERM before its process group is killed. */
export const STOP_GRACE_MS = 2000;
/** Finished tasks kept for `logs` and `list`. */
const KEEP_FINISHED = 20;

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
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
    for (const task of this.tasks.values()) if (task.info.state !== "exited") count++;
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
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        tail.push(chunk);
        info.outputBytes = tail.total;
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
      killGroup(task.child, "SIGTERM");
      task.killTimer = setTimeout(() => killGroup(task.child, "SIGKILL"), graceMs);
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
          if (task.info.state !== "exited") killGroup(task.child, "SIGKILL");
      };
      process.on("exit", this.exitHook);
    } else if (!live && this.exitHook) {
      process.off("exit", this.exitHook);
      this.exitHook = undefined;
    }
  }
}

export function describeTask(info: BackgroundTaskInfo) {
  const where =
    info.kind === "sandbox"
      ? "in the sandbox"
      : info.kind === "host"
        ? "on the host (outside the sandbox)"
        : "without a sandbox (sandbox is off)";
  const status =
    info.state === "exited"
      ? `exited ${info.signal ? `by signal ${info.signal}` : `with status ${info.exitCode}`}`
      : info.state;
  return `${info.id} [${status}] ${where}, pid ${info.pid ?? "?"}, ${info.outputBytes} bytes of output: ${JSON.stringify(info.command)}`;
}

/** Footer text for the running tasks, or undefined when none are running. */
export function statusText(tasks: BackgroundTaskInfo[]): string | undefined {
  const live = tasks.filter((task) => task.state !== "exited");
  if (!live.length) return undefined;
  const host = live.filter((task) => task.kind === "host").length;
  const unsandboxed = live.filter((task) => task.kind === "unsandboxed").length;
  const extra = [host && `${host} host`, unsandboxed && `${unsandboxed} unsandboxed`].filter(
    Boolean,
  );
  return `bg: ${live.length} running` + (extra.length ? ` (${extra.join(", ")})` : "");
}

const WIDGET_MAX_TASKS = 5;
const WIDGET_COMMAND_CHARS = 60;

function oneLine(command: string) {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > WIDGET_COMMAND_CHARS ? flat.slice(0, WIDGET_COMMAND_CHARS - 1) + "…" : flat;
}

/**
 * Widget lines for the running tasks, or undefined when none run. Plain
 * strings, so RPC clients get them too (Pi drops component widgets there).
 */
export function widgetLines(tasks: BackgroundTaskInfo[]): string[] | undefined {
  const live = tasks.filter((task) => task.state !== "exited");
  if (!live.length) return undefined;
  const lines = live.slice(0, WIDGET_MAX_TASKS).map((task) => {
    const where =
      task.kind === "sandbox" ? "sandbox" : task.kind === "host" ? "HOST" : "no sandbox";
    const state = task.state === "stopping" ? " (stopping)" : "";
    return `${task.id} [${where}]${state} ${oneLine(task.command)}`;
  });
  if (live.length > WIDGET_MAX_TASKS)
    lines.push(`+${live.length - WIDGET_MAX_TASKS} more (/background)`);
  return lines;
}

export function exitMessage({ info, tail }: BackgroundExit) {
  return (
    `Background task ${describeTask(info)}` +
    (tail ? `\nLast output (stdout and stderr interleaved):\n${tail}` : "")
  );
}

export type BackgroundToolDeps = {
  tasks: BackgroundTasks;
  config: (cwd: string) => BackgroundBashConfig;
  /** Whether host_bash may start background tasks; shown in the tool guidance only. */
  hostBackground: boolean;
  /** Spawn a sandboxed (or, with the sandbox off, plain) background command. */
  start: (command: string, ctx: ExtensionContext) => Promise<BackgroundTaskInfo>;
};

export const BACKGROUND_TOOL = "bash_background";

export function registerBackgroundTool(pi: ExtensionAPI, deps: BackgroundToolDeps) {
  const { tasks } = deps;
  pi.registerTool({
    name: BACKGROUND_TOOL,
    label: "Background bash",
    description:
      "Manage long-running Bash commands (dev servers, watchers, long builds) that run in the background. " +
      "`start` runs `command` in the same OS sandbox as ordinary bash and returns a task id at once; " +
      "`list` shows tasks, `logs` returns the tail of a task's combined stdout/stderr, `stop` terminates a task and its process group. " +
      "Tasks are stopped when the Pi session ends or the sandbox is turned on or off. " +
      "Filesystem permissions are fixed when a task starts; network permissions granted later apply to it. " +
      (deps.hostBackground
        ? "Tasks started with host_bash `background: true` run outside the sandbox and are listed and stopped here too. "
        : "") +
      "Do not use `&`, nohup or setsid in ordinary bash for this: such processes are killed when the command returns on Linux.",
    promptSnippet: "Start, inspect and stop long-running background commands",
    promptGuidelines: [
      "For a command that keeps running (a dev server, a watcher), use bash_background start instead of `&` in bash, then check it with bash_background logs.",
      "Stop background tasks you no longer need with bash_background stop.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("logs"),
        Type.Literal("stop"),
      ]),
      command: Type.Optional(
        Type.String({ minLength: 1, maxLength: 16384, description: "Command for start" }),
      ),
      id: Type.Optional(Type.String({ description: "Task id for logs and stop" })),
      bytes: Type.Optional(
        Type.Integer({ minimum: 1, description: "For logs: how many bytes of the tail to return" }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const text = (body: string, details: unknown) => ({
        content: [{ type: "text" as const, text: body }],
        details,
      });
      const options = deps.config(ctx.cwd);
      if (params.action === "start") {
        if (!options.enabled) {
          throw new Error(
            "Sandboxed background tasks are disabled (backgroundBash.enabled in sandbox.json)." +
              (deps.hostBackground
                ? " host_bash with background: true may still be available."
                : ""),
          );
        }
        const command = params.command?.trim();
        if (!command) throw new Error("start needs a command.");
        if (tasks.running() >= options.maxTasks) {
          throw new Error(
            `Too many background tasks are running (limit ${options.maxTasks}, backgroundBash.maxTasks). Stop one first.`,
          );
        }
        const info = await deps.start(params.command!, ctx);
        return text(`Started ${describeTask(info)}`, info);
      }
      if (params.action === "list") {
        const all = tasks.list();
        return text(all.length ? all.map(describeTask).join("\n") : "No background tasks.", {
          tasks: all,
        });
      }
      if (!params.id) throw new Error(`${params.action} needs an id.`);
      if (params.action === "logs") {
        const result = tasks.logs(params.id, params.bytes);
        if (!result) throw new Error(`Unknown background task: ${params.id}`);
        const body =
          result.text ||
          (result.info.outputBytes ? "(output hidden for this task)" : "(no output yet)");
        return text(`${describeTask(result.info)}\n${body}`, result.info);
      }
      const stopped = await tasks.stop(params.id);
      if (!stopped) throw new Error(`Unknown background task: ${params.id}`);
      return text(`Stopped: ${describeTask(stopped)}`, stopped);
    },
  });
}
