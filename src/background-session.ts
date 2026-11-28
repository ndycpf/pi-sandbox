import type { ChildProcess } from "node:child_process";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type BackgroundKind,
  type BackgroundTaskInfo,
  BackgroundTasks,
  isLive,
  type Reservation,
} from "./background-tasks.ts";
import {
  describeTask,
  exitMessage,
  registerBackgroundTool,
  statusText,
  widgetLines,
} from "./background-tool.ts";
import { type BackgroundBashConfig } from "./config.ts";
import { trackSessionLiveness } from "./session-liveness.ts";

/** A spawned background command, before it is handed to the task registry. */
export type SpawnedTask = { kind: BackgroundKind; child: ChildProcess; cleanup?: () => void };

export type BackgroundSessionDeps = {
  /** The validated `backgroundBash` config for a working directory. */
  config: (cwd: string) => BackgroundBashConfig;
  /** Spawn a command in the current sandbox (or without one while it is off). */
  spawn: (command: string, ctx: ExtensionContext) => Promise<SpawnedTask>;
};

/**
 * Long-running tasks for one Pi session: the registry, its footer and widget,
 * the exit messages to the agent, the session-liveness report to RPC hosts,
 * and the `bash_background` tool and `/background` command.
 */
export function createBackgroundSession(pi: ExtensionAPI, deps: BackgroundSessionDeps) {
  // The current session's UI. Plain text in RPC, where it is sent as-is.
  let ui: { ui: ExtensionContext["ui"]; tui: boolean } | undefined;
  let releaseLiveness: (() => void) | undefined;
  let registered = false;
  // Held from session shutdown until the next session attaches.
  let ended: (() => void) | undefined;

  const showTasks = () => {
    if (!ui) return;
    try {
      const all = tasks.list();
      const status = statusText(all);
      ui.ui.setStatus("background", status && ui.tui ? ui.ui.theme.fg("accent", status) : status);
      ui.ui.setWidget("background", widgetLines(all), { placement: "belowEditor" });
    } catch {
      // The session may be gone.
    }
  };

  const tasks = new BackgroundTasks((exit) => {
    try {
      pi.sendMessage(
        { customType: "bash-background", content: exitMessage(exit), display: true },
        { deliverAs: "steer" },
      );
    } catch {
      // The session may be gone.
    }
  }, showTasks);

  async function start(
    command: string,
    ctx: ExtensionContext,
    reservation: Reservation,
  ): Promise<BackgroundTaskInfo> {
    const limits = deps.config(ctx.cwd);
    const spawned = await deps.spawn(command, ctx);
    return tasks.add({
      ...spawned,
      reservation,
      command,
      cwd: ctx.cwd,
      bufferBytes: limits.bufferBytes,
      visibleBytes: limits.outputBytes,
    });
  }

  function registerCommand() {
    pi.registerCommand("background", {
      description: "List background tasks, or stop them: /background stop [id|all]",
      handler: async (args, ctx) => {
        const [action = "list", target] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "list" && ctx.mode === "rpc" && ctx.hasUI) {
          // Some RPC clients (Orca's native chat) drop notify, setStatus and
          // setWidget and show only dialogs, so list the tasks in one.
          const all = tasks.list();
          if (!all.length) {
            await ctx.ui.select("No background tasks.", ["Close"]);
            return;
          }
          const task = await pickTask(
            ctx,
            "Background tasks (pick a running one to stop it)",
            all,
            ["Close"],
          );
          if (!task || !isLive(task)) return;
          if (await ctx.ui.confirm("Stop background task?", describeTask(task))) {
            await tasks.stop(task.id);
          }
          return;
        }
        if (action === "list") {
          const all = tasks.list();
          ctx.ui.notify(
            all.length ? all.map(describeTask).join("\n") : "No background tasks.",
            "info",
          );
          return;
        }
        if (action === "stop" && target === "all") {
          await tasks.stopAll();
          ctx.ui.notify("Stopped all background tasks.", "info");
          return;
        }
        if (action === "stop" && !target) {
          // Pi's selector in the TUI, a select dialog in RPC clients.
          const live = tasks.list().filter(isLive);
          if (!live.length) {
            ctx.ui.notify("No background tasks are running.", "info");
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify("Usage: /background stop <id|all>", "error");
            return;
          }
          const task = await pickTask(ctx, "Stop which background task?", live);
          if (!task) return;
          const stopped = await tasks.stop(task.id);
          if (stopped) ctx.ui.notify(`Stopped: ${describeTask(stopped)}`, "info");
          return;
        }
        if (action === "stop" && target) {
          const stopped = await tasks.stop(target);
          ctx.ui.notify(
            stopped ? `Stopped: ${describeTask(stopped)}` : `Unknown background task: ${target}`,
            stopped ? "info" : "error",
          );
          return;
        }
        ctx.ui.notify("Usage: /background [list] | /background stop [id|all]", "error");
      },
    });
  }

  return {
    tasks,
    /**
     * Attach to a new session. Registers the tool and command once, when
     * sandboxed or host background tasks are enabled at startup.
     */
    attach(ctx: ExtensionContext, options: { enabled: boolean; hostBackground: boolean }) {
      ended?.();
      ended = undefined;
      ui = ctx.hasUI ? { ui: ctx.ui, tui: ctx.mode === "tui" } : undefined;
      releaseLiveness?.();
      // Keeps RPC hosts (Orca, pi-web) from idle-stopping Pi while tasks run.
      releaseLiveness = trackSessionLiveness(
        ctx,
        "pi-sandbox background tasks",
        () => tasks.running() > 0,
      );
      if (registered || (!options.enabled && !options.hostBackground)) return;
      registered = true;
      registerCommand();
      registerBackgroundTool(pi, {
        tasks,
        config: deps.config,
        hostBackground: options.hostBackground,
        start,
      });
    },
    /**
     * Stop every task while no new one can start, then run `change` (turning
     * the sandbox on or off) before starts are allowed again.
     */
    async whileStopped<T>(change: () => Promise<T>): Promise<T> {
      const release = tasks.hold();
      try {
        await tasks.stopAll();
        return await change();
      } finally {
        release();
      }
    },
    /** Stop every task and let go of the session; starts stay refused until the next attach. */
    async detach() {
      ended ??= tasks.hold();
      await tasks.stopAll();
      ui = undefined;
      releaseLiveness?.();
      releaseLiveness = undefined;
    },
  };
}

async function pickTask(
  ctx: ExtensionContext,
  title: string,
  candidates: BackgroundTaskInfo[],
  extra: string[] = [],
) {
  const lines = candidates.map(describeTask);
  const choice = await ctx.ui.select(title, [...lines, ...extra]);
  return choice === undefined ? undefined : candidates[lines.indexOf(choice)];
}
