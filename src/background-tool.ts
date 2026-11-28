import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BackgroundBashConfig } from "./config.ts";

import {
  type BackgroundExit,
  type BackgroundTaskInfo,
  type BackgroundTasks,
  isLive,
  type WaitResult,
} from "./background-tasks.ts";

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
  const live = tasks.filter(isLive);
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
  const live = tasks.filter(isLive);
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

const DEFAULT_WAIT_SECONDS = 60;
/** At most one streamed progress update per interval while waiting. */
const UPDATE_INTERVAL_MS = 500;

function textResult(body: string, details: unknown) {
  return { content: [{ type: "text" as const, text: body }], details };
}

function parseUntil(pattern: string | undefined) {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern, "m");
  } catch (error) {
    throw new Error(`until is not a valid regular expression: ${error}`);
  }
}

/** The task line and its visible output tail. */
function showTask(tasks: BackgroundTasks, info: BackgroundTaskInfo) {
  const tail = tasks.logs(info.id)?.text;
  return describeTask(info) + (tail ? `\n${tail}` : "");
}

/**
 * Wait on a task, streaming its output into the tool call as progress, so
 * clients that show tool calls (the TUI, Orca's chat) show it live.
 */
async function watchTask(
  tasks: BackgroundTasks,
  id: string,
  options: {
    timeoutSeconds: number;
    until?: RegExp;
    signal?: AbortSignal;
    update?: (result: ReturnType<typeof textResult>) => void;
  },
) {
  let last = 0;
  let pending: NodeJS.Timeout | undefined;
  const push = () => {
    pending = undefined;
    last = Date.now();
    const info = tasks.get(id);
    if (info) options.update?.(textResult(showTask(tasks, info), info));
  };
  const result = await tasks.wait(id, {
    timeoutMs: options.timeoutSeconds * 1000,
    until: options.until,
    signal: options.signal,
    onOutput: () => {
      if (pending) return;
      pending = setTimeout(push, Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - last)));
    },
  });
  if (pending) clearTimeout(pending);
  return result;
}

function waitedResult(
  tasks: BackgroundTasks,
  result: WaitResult,
  until: string | undefined,
  prefix = "",
) {
  const note =
    result.reason === "exited"
      ? "The task has exited."
      : result.reason === "matched"
        ? `Its output matched ${JSON.stringify(until)}; it is still running.`
        : result.reason === "timeout"
          ? "Stopped waiting (timeoutSeconds); the task is still running."
          : "Stopped waiting (cancelled); the task is still running.";
  return textResult(`${prefix}${showTask(tasks, result.info)}\n${note}`, {
    ...result.info,
    waited: result.reason,
  });
}

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
      "`wait` watches a task, streaming its output, until it exits, its new output matches `until` (a regular expression), or `timeoutSeconds` pass; the task keeps running. " +
      "`start` takes `until` and `timeoutSeconds` too, to wait for a server's ready line before returning. " +
      "Tasks are stopped when the Pi session ends or the sandbox is turned on or off. " +
      "Filesystem permissions are fixed when a task starts; network permissions granted later apply to it. " +
      (deps.hostBackground
        ? "Tasks started with host_bash `background: true` run outside the sandbox and are listed and stopped here too. "
        : "") +
      "Do not use `&`, nohup or setsid in ordinary bash for this: such processes are killed when the command returns on Linux.",
    promptSnippet: "Start, inspect and stop long-running background commands",
    promptGuidelines: [
      "For a command that keeps running (a dev server, a watcher), use bash_background start instead of `&` in bash, then check it with bash_background logs.",
      "To wait for a server to be ready, pass `until` with a pattern from its ready line (and a `timeoutSeconds`) to bash_background start; to wait for a build or test run to finish, use bash_background wait.",
      "Stop background tasks you no longer need with bash_background stop.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("logs"),
        Type.Literal("stop"),
        Type.Literal("wait"),
      ]),
      command: Type.Optional(
        Type.String({ minLength: 1, maxLength: 16384, description: "Command for start" }),
      ),
      id: Type.Optional(Type.String({ description: "Task id for logs, stop and wait" })),
      until: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 500,
          description:
            "For start and wait: stop waiting when new output matches this regular expression",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 600,
          description:
            "For start and wait: how long to wait (default 60 for wait; start waits only if until or this is given)",
        }),
      ),
      bytes: Type.Optional(
        Type.Integer({ minimum: 1, description: "For logs: how many bytes of the tail to return" }),
      ),
    }),
    async execute(_id, params, signal, update, ctx) {
      const until = parseUntil(params.until);
      const watch = (id: string) =>
        watchTask(tasks, id, {
          timeoutSeconds: params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS,
          until,
          signal,
          update,
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
        if (until === undefined && params.timeoutSeconds === undefined) {
          return textResult(`Started ${describeTask(info)}`, info);
        }
        update?.(textResult(`Started ${describeTask(info)}`, info));
        return waitedResult(tasks, (await watch(info.id))!, params.until, "Started ");
      }
      if (params.action === "list") {
        const all = tasks.list();
        return textResult(all.length ? all.map(describeTask).join("\n") : "No background tasks.", {
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
        return textResult(`${describeTask(result.info)}\n${body}`, result.info);
      }
      if (params.action === "wait") {
        const result = await watch(params.id);
        if (!result) throw new Error(`Unknown background task: ${params.id}`);
        return waitedResult(tasks, result, params.until);
      }
      const stopped = await tasks.stop(params.id);
      if (!stopped) throw new Error(`Unknown background task: ${params.id}`);
      return textResult(`Stopped: ${describeTask(stopped)}`, stopped);
    },
  });
}
