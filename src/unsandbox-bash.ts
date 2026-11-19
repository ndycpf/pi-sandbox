import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";

import { Type } from "typebox";

import type { ExecutionHistory } from "./execution-history.ts";

import { killProcessGroup } from "./sandbox-runtime.ts";

const shell = "/bin/bash";
const refusal = "Host command refused.";
const deadline = 60_000;
let busy = false; // One prompt or process across registrations sharing this module.

// Reversible ASCII display, including newlines, bidi controls and invisible characters.
function quoted(value: string) {
  return JSON.stringify(value).replace(
    /[^ -~]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

class ApprovalRefused extends Error {}

// Title compaction adapted from MasuRii/pi-permission-system, src/permission-dialog.ts (MIT).
function compactTitle(title: string) {
  const lines = title.split("\n");
  if (lines.length <= 32 && title.length <= 2200) return title;

  const prefixLines = lines.slice(0, 31);
  const omittedLines = lines.length - prefixLines.length;
  let prefix = prefixLines.join("\n").trimEnd();
  // The size of the notice depends on how many characters it replaces.
  for (;;) {
    const omitted = title.length - prefix.length;
    const counts = [];
    if (omittedLines) counts.push(`${omittedLines} ${omittedLines === 1 ? "line" : "lines"}`);
    counts.push(`${omitted} ${omitted === 1 ? "character" : "characters"}`);
    const notice = `[Permission prompt compacted: omitted ${counts.join(" and ")} to keep the permission dialog usable.]`;
    const budget = 2200 - notice.length - 1;
    if (prefix.length <= budget) return prefix + "\n" + notice;
    prefix = prefix.slice(0, budget).trimEnd();
  }
}

async function approve(ctx: ExtensionContext, command: string, cwd: string, signal: AbortSignal) {
  const title = [
    "Run outside the OS sandbox?",
    "Host files and network are accessible. Changes can persist.",
    "Shell: " + shell,
    "CWD (JSON): " + quoted(cwd),
    "Command (JSON-quoted lines): " + command.split("\n").map(quoted).join("\n"),
  ].join("\n");
  const choice = await ctx.ui.select(compactTitle(title), ["Deny", "Allow once"], { signal });
  if (signal.aborted || choice === undefined) {
    throw new ApprovalRefused(
      signal.reason?.name === "TimeoutError"
        ? "Host command refused: approval timed out."
        : "Host command refused: approval cancelled.",
    );
  }
  return choice === "Allow once";
}

export function registerUnsandboxBash(
  pi: ExtensionAPI,
  history: () => ExecutionHistory,
  ready: () => boolean,
) {
  let session:
    | { manager: ExtensionContext["sessionManager"]; id: string; lifetime: AbortController }
    | undefined;

  pi.registerTool({
    name: "unsandbox_bash",
    label: "Request host Bash",
    description:
      "Explicitly request one host Bash command. Requires operator approval in the interactive CLI. Returns exit status only.",
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4096 }) }),
    async execute(_id, { command }, abort, _update, ctx) {
      const trace = history().begin("unsandbox_bash", [command, ctx.cwd, shell]);
      const active = session;
      const current = () =>
        active &&
        active === session &&
        ready() &&
        ctx.mode === "tui" &&
        ctx.hasUI &&
        process.stdin.isTTY &&
        process.stdout.isTTY &&
        ctx.sessionManager === active.manager &&
        active.id === ctx.sessionManager.getSessionId();
      if (
        !current() ||
        !active ||
        busy ||
        !["linux", "darwin"].includes(process.platform) ||
        !command.trim() ||
        command.length > 4096 ||
        command.includes("\0") ||
        Buffer.from(command).toString() !== command
      ) {
        trace.finish("refused");
        throw new Error(refusal);
      }
      busy = true;
      let fd: number | undefined;
      let started = false;
      try {
        const signals = [active.lifetime.signal];
        if (abort) signals.push(abort);
        if (ctx.signal) signals.push(ctx.signal);
        const lifetime = AbortSignal.any(signals);
        const expires = performance.now() + deadline;
        const approval = AbortSignal.any([lifetime, AbortSignal.timeout(deadline)]);
        const original = ctx.cwd;
        const cwd = realpathSync.native(original);
        fd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
        const dir = fstatSync(fd, { bigint: true });
        approval.throwIfAborted();
        if (
          (await approve(ctx, command, cwd, approval)) !== true ||
          !current() ||
          approval.aborted ||
          performance.now() >= expires ||
          ctx.cwd !== original ||
          realpathSync.native(original) !== cwd
        )
          throw new Error(refusal);
        const now = statSync(cwd, { bigint: true });
        if (dir.dev !== now.dev || dir.ino !== now.ino) throw new Error(refusal);
        // Check the actual child cwd against the open approved directory before exec.
        // Command text is one argv element, never interpolated into the launcher.
        const guard =
          '[[ . -ef /dev/fd/3 ]] || exit 125; exec 3<&-; exec /bin/bash --noprofile --norc -c "$1"';
        const child = spawn(shell, ["--noprofile", "--norc", "-c", guard, "bash", command], {
          cwd,
          detached: true,
          stdio: ["ignore", "ignore", "ignore", fd],
          env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
        });
        const run = AbortSignal.any([lifetime, AbortSignal.timeout(deadline)]);
        const kill = () => killProcessGroup(child);
        run.addEventListener("abort", kill, { once: true });
        if (run.aborted) kill();
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("spawn", () => {
              started = true;
              trace.spawned();
            });
            child.once("error", reject);
            child.once("exit", resolve);
          });
          run.throwIfAborted();
          trace.finish("exited", code);
          return {
            content: [
              { type: "text", text: "Host Bash exit status: " + (code ?? "terminated by signal") },
            ],
            details: { exitCode: code },
          };
        } finally {
          run.removeEventListener("abort", kill);
        }
      } catch (error) {
        trace.finish(started ? "failed" : "refused");
        if (error instanceof ApprovalRefused) throw error;
        throw new Error(started ? "Host command interrupted." : refusal);
      } finally {
        busy = false;
        if (fd !== undefined) closeSync(fd);
      }
    },
  });
  return {
    start(ctx: ExtensionContext) {
      session?.lifetime.abort();
      const id = ctx.sessionManager?.getSessionId();
      session = id
        ? { manager: ctx.sessionManager, id, lifetime: new AbortController() }
        : undefined;
    },
    stop() {
      session?.lifetime.abort();
      session = undefined;
    },
  };
}
