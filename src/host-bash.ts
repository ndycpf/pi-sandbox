import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { ReadPolicy } from "./host-review-tools.ts";

import { DEFAULT_CONFIG, DEFAULT_HOST_BASH_CONFIG, type HostBashConfig } from "./config.ts";
import { REJECTION_INSTRUCTIONS } from "./host-review-prompt.ts";
import {
  appendReviewLog,
  type PlannedAction,
  modelReviewer,
  type Reviewer,
  reviewCommand,
  transcriptRecords,
} from "./host-review.ts";

const shell = "/bin/bash";
const refusal = "Host command refused.";
const deadline = 60_000; // Approval limit.
const fallbackPath = "/usr/bin:/bin";
const outputGraceMs = 200;
// Prints "device:inode" of a path; device numbers match Node's fstat().dev.
// Absolute, so a program planted on the inherited PATH cannot fake the check.
const statCommand =
  process.platform === "darwin" ? "/usr/bin/stat -f %d:%i" : "/usr/bin/stat -c %d:%i";
let busy = false; // One prompt or process across registrations sharing this module.
// After this many reviewer denials in a row, the session falls back to human review.
const maxDenials = 3;

// Reversible ASCII display, including newlines, bidi controls and invisible characters.
function quoted(value: string) {
  return JSON.stringify(value).replace(
    /[^ -~]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

class ApprovalRefused extends Error {}
class HostCommandStopped extends Error {}

// The prompt is sized for a classic 80x24 terminal rather than measured, so
// the check is deterministic. Pi's selector adds 9 rows around the title
// (borders, spacers, two choices, key hint); 4 rows are kept for its footer.
const assumedColumns = 80;
const assumedRows = 24;
const selectorRows = 9;
const footerRows = 4;
const maxTitleRows = assumedRows - selectorRows - footerRows;

// Rows the selector title takes at the assumed width, wrapped as Pi renders it.
export function titleRows(title: string) {
  return new Text(title, 1, 0).render(assumedColumns).length;
}

function outputPolicy(options: HostBashConfig) {
  return options.outputBytes
    ? `agent sees last ${options.outputBytes} bytes of output`
    : "agent sees exit status only";
}

// The approval prompt's text. Throws if the operator could not read all of it.
function promptTitle(command: string, cwd: string, options: HostBashConfig) {
  const output = outputPolicy(options);
  const header = [
    "Run outside the OS sandbox? Host files and network are reachable.",
    `${shell}, limit ${options.timeoutSeconds}s, ${output}.`,
    "CWD: " + quoted(cwd),
  ];
  const shown = command.split("\n").map(quoted);
  const title = [...header, "Command: " + shown.join("\n")].join("\n");
  const rows = titleRows(title);
  // The operator must be able to read the whole command, so an oversized one
  // goes back to the agent instead of reaching the operator.
  if (rows > maxTitleRows) {
    const available = Math.max(0, maxTitleRows - titleRows(header.join("\n")));
    throw new ApprovalRefused(
      "Host command refused before prompting: command too long. " +
        `The approval prompt must fit an ${assumedColumns}x${assumedRows} terminal, which leaves ${maxTitleRows} rows for its text. ` +
        `With this call's CWD, the command gets ${available} rows of ${assumedColumns - 2} columns; ` +
        `as shown (JSON-quoted) it has ${shown.length} ${shown.length === 1 ? "line" : "lines"} and needs ${rows - (maxTitleRows - available)} rows. ` +
        "The operator could not read all of it. " +
        "Shorten the command (fewer and shorter lines) and call again: split it into several host_bash calls, " +
        "remove comments and blank lines, or run the parts that do not need the host in ordinary sandboxed bash. " +
        "Do not move the logic into a script file to shorten it; the operator cannot review a file's contents in the prompt.",
    );
  }
  return title;
}

async function approve(ctx: ExtensionContext, title: string, signal: AbortSignal) {
  const choice = await ctx.ui.select(title, ["Deny", "Allow once"], { signal });
  if (signal.aborted || choice === undefined) {
    throw new ApprovalRefused(
      signal.reason?.name === "TimeoutError"
        ? "Host command refused: approval timed out."
        : "Host command refused: approval cancelled.",
    );
  }
  return choice === "Allow once";
}

// Host commands use Pi's own PATH, like a terminal the operator opened.
export function hostPath() {
  return process.env.PATH || fallbackPath;
}

// Keeps the last `limit` bytes written to it.
class Tail {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  constructor(private readonly limit: number) {}
  get limitBytes() {
    return this.limit;
  }
  push(chunk: Buffer) {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.kept += chunk.length;
    while (this.chunks.length > 1 && this.kept - this.chunks[0]!.length >= this.limit) {
      this.kept -= this.chunks.shift()!.length;
    }
  }
  text() {
    const all = Buffer.concat(this.chunks);
    return new TextDecoder("utf-8").decode(all.subarray(Math.max(0, all.length - this.limit)));
  }
}

function outputText(tail: Tail | undefined) {
  if (!tail) return "";
  if (!tail.total) return "\nNo output.";
  const shown = Math.min(tail.total, tail.limitBytes);
  const header =
    shown < tail.total
      ? `Output (last ${shown} of ${tail.total} bytes, stdout and stderr interleaved):`
      : "Output (stdout and stderr interleaved):";
  return "\n" + header + "\n" + tail.text();
}

function format(code: number | null, tail: Tail | undefined, path: string) {
  let status = "Host Bash exit status: " + (code ?? "terminated by signal");
  // With outputBytes 0 the agent sees the exit status only, so no host details.
  if (code === 127 && tail) {
    status +=
      `\nExit status 127 usually means a program was not found on the host PATH (${path}). ` +
      "Report this to the operator: if the program is installed elsewhere, they can add its directory to PATH in the shell that starts Pi and restart Pi. " +
      "Do not retry the same command.";
  }
  return status + outputText(tail);
}

export type HostBashDeps = {
  /** Builds the reviewer for the configured model. */
  reviewer?: (ctx: ExtensionContext, model: string) => Reviewer;
  /** Bounded JSONL log of auto-review decisions. */
  logFile?: string;
  /** The sandbox's read rules, which also bound the reviewer's read and ls. */
  readPolicy?: (cwd: string) => ReadPolicy;
};

const defaultReadPolicy = (): ReadPolicy => ({
  denyRead: DEFAULT_CONFIG.filesystem?.denyRead ?? [],
  allowRead: DEFAULT_CONFIG.filesystem?.allowRead ?? [],
});

export function registerHostBash(
  pi: ExtensionAPI,
  ready: () => boolean,
  config: (cwd: string) => HostBashConfig = () => DEFAULT_HOST_BASH_CONFIG,
  deps: HostBashDeps = {},
) {
  const makeReviewer = deps.reviewer ?? modelReviewer;
  const logFile = () => deps.logFile ?? join(getAgentDir(), "host-bash-review.log");
  let session:
    | {
        manager: ExtensionContext["sessionManager"];
        id: string;
        lifetime: AbortController;
        denials: number;
        /** Auto-review is off for the rest of this session after repeated denials. */
        paused?: boolean;
      }
    | undefined;
  const showStatus = (ctx: ExtensionContext) => {
    const review = config(ctx.cwd).review;
    if (review.mode !== "auto") return ctx.ui?.setStatus?.("host-bash", undefined);
    ctx.ui?.setStatus?.(
      "host-bash",
      session?.paused
        ? "host_bash: human (auto-review paused)"
        : `host_bash: auto-review (${review.model})`,
    );
  };

  pi.registerTool({
    name: "host_bash",
    label: "Host Bash",
    description:
      "Run one Bash command on the host, outside the OS sandbox, after the human operator approves it in the interactive CLI. " +
      "Ordinary bash runs inside the sandbox, which blocks paths outside the workspace, most network hosts, local services and credential stores. " +
      "Use this tool when a sandboxed command fails or gives misleading results because of that, or when the task needs something only the host has. " +
      "Typical signs: 'Operation not permitted', 'Permission denied' outside the workspace, blocked network, 'command not found' for a tool installed on the host (docker, brew, gcloud), " +
      "an unreachable daemon or socket, or missing or invalid credentials (gh, git, cloud CLIs, keychain). " +
      "Every call needs approval, by the operator or, when the operator enabled it, an automatic reviewer, so do not use it for work the sandbox can do. " +
      "Pass `reason`: one sentence on why this needs the host; the reviewer reads it. " +
      "Keep the command short and self-contained: the approval prompt must fit an 80x24 terminal, so a command over about 8 short lines is refused without prompting and must be shortened or split. " +
      "Runs non-interactively with stdin closed, Pi's PATH and HOME (no other environment variables), and a time limit. " +
      "Returns the exit status and, when enabled, the tail of combined stdout/stderr.",
    promptSnippet: "Ask the operator to run one Bash command outside the sandbox",
    promptGuidelines: [
      "When sandboxed bash is blocked or misleading because of the sandbox (permission errors, blocked network, a host tool not found, an unreachable daemon, invalid credentials), do not give up or report the sandboxed result as the host state: call host_bash with the same command and say in one sentence why host access is needed.",
      "Do not use host_bash for work that succeeds in the sandbox.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4096 }),
      reason: Type.Optional(
        Type.String({
          maxLength: 500,
          description: "One sentence on why this command needs the host instead of the sandbox.",
        }),
      ),
    }),
    async execute(_id, { command, reason }, abort, _update, ctx) {
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
        throw new Error(refusal);
      }
      const options = config(ctx.cwd);
      if (!options.enabled) throw new Error(refusal);
      busy = true;
      let fd: number | undefined;
      let started = false;
      try {
        const signals = [active.lifetime.signal];
        if (abort) signals.push(abort);
        if (ctx.signal) signals.push(ctx.signal);
        const lifetime = AbortSignal.any(signals);
        const original = ctx.cwd;
        const cwd = realpathSync.native(original);
        fd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
        const dir = fstatSync(fd, { bigint: true });
        const path = hostPath();
        // Checked before any review, so a call the operator could not read is
        // never auto-approved either.
        const title = promptTitle(command, cwd, options);
        lifetime.throwIfAborted();
        const review = options.review;
        let approvedBy: "operator" | "reviewer" = "operator";
        if (review.mode === "auto" && review.model && !active.paused) {
          const action: PlannedAction = {
            tool: "host_bash",
            command: [shell, "--noprofile", "--norc", "-c", command],
            cwd,
            sandbox_permissions: "require_escalated",
            ...(reason && { justification: reason }),
            tty: false,
            env: { PATH: path, ...(process.env.HOME && { HOME: process.env.HOME }) },
            timeout_seconds: options.timeoutSeconds,
            output_to_agent: outputPolicy(options),
          };
          const verdict = await reviewCommand(
            makeReviewer(ctx, review.model),
            review,
            action,
            transcriptRecords(ctx.sessionManager.getBranch?.() ?? []),
            (deps.readPolicy ?? defaultReadPolicy)(cwd),
            lifetime,
          );
          if (!current()) throw new Error(refusal);
          appendReviewLog(logFile(), {
            session: active.id,
            model: review.model,
            cwd,
            command,
            ...(reason && { reason }),
            ...verdict,
          });
          if (verdict.decision === "allow") {
            approvedBy = "reviewer";
            active.denials = 0;
            ctx.ui.notify(
              `host_bash auto-approved (${review.model}): ${quoted(command).slice(0, 200)}\n${verdict.reason}`,
              "info",
            );
          } else if (verdict.decision === "deny") {
            active.denials++;
            const paused = active.denials >= maxDenials;
            if (paused) active.paused = true;
            ctx.ui.notify(
              `host_bash denied by auto-review: ${verdict.reason}` +
                (paused
                  ? `\nAuto-review paused for this session after ${maxDenials} denials in a row; you will be asked instead.`
                  : ""),
              "warning",
            );
            showStatus(ctx);
            throw new ApprovalRefused(
              `Host command denied by the automatic reviewer: ${verdict.reason} ` +
                REJECTION_INSTRUCTIONS,
            );
          } else {
            ctx.ui.notify(`host_bash auto-review asks you to decide: ${verdict.reason}`, "info");
          }
        }
        if (approvedBy === "operator") {
          const expires = performance.now() + deadline;
          const approval = AbortSignal.any([lifetime, AbortSignal.timeout(deadline)]);
          approval.throwIfAborted();
          if (
            (await approve(ctx, title, approval)) !== true ||
            approval.aborted ||
            performance.now() >= expires
          )
            throw new Error(refusal);
          active.denials = 0;
        }
        if (
          !current() ||
          lifetime.aborted ||
          ctx.cwd !== original ||
          realpathSync.native(original) !== cwd
        )
          throw new Error(refusal);
        const now = statSync(cwd, { bigint: true });
        if (dir.dev !== now.dev || dir.ino !== now.ino) throw new Error(refusal);
        // The launcher compares its actual cwd with the approved directory's device
        // and inode, then reports success on fd 3 before exec. (`-ef /dev/fd/N`
        // does not work for directory descriptors on macOS.) Command text is one
        // argv element, never interpolated into the launcher.
        const identity = `${dir.dev}:${dir.ino}`;
        const guard = `[[ "$(${statCommand} .)" == "$2" ]] || exit 125; printf ok >&3; exec 3>&-; exec /bin/bash --noprofile --norc -c "$1"`;
        const tail = options.outputBytes ? new Tail(options.outputBytes) : undefined;
        const env: Record<string, string> = { PATH: path };
        if (process.env.HOME) env.HOME = process.env.HOME;
        const child = spawn(
          shell,
          ["--noprofile", "--norc", "-c", guard, "bash", command, identity],
          {
            cwd,
            detached: true,
            stdio: ["ignore", tail ? "pipe" : "ignore", tail ? "pipe" : "ignore", "pipe"],
            env,
          },
        );
        const report = child.stdio[3];
        const verified = new Promise<boolean>((done) => {
          if (!report) return done(false);
          let text = "";
          report.on("data", (chunk: Buffer) => (text += chunk.toString()));
          report.once("close", () => done(text === "ok"));
          report.once("error", () => done(false));
        });
        const closed = new Promise<void>((done) => child.once("close", () => done()));
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => tail?.push(chunk));
        }
        const limit = AbortSignal.timeout(options.timeoutSeconds * 1000);
        const run = AbortSignal.any([lifetime, limit]);
        const kill = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        run.addEventListener("abort", kill, { once: true });
        if (run.aborted) kill();
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("spawn", () => {
              started = true;
            });
            child.once("error", reject);
            child.once("exit", resolve);
          });
          if (run.aborted) {
            throw new HostCommandStopped(
              (limit.aborted
                ? `Host command timed out after ${options.timeoutSeconds}s and was killed (limit: hostBash.timeoutSeconds in the global sandbox.json). ` +
                  "Do not retry it unchanged; run a shorter step or ask the operator to raise the limit."
                : "Host command interrupted: the call was cancelled or the session ended, and the command was killed.") +
                outputText(tail),
            );
          }
          if (!(await verified)) {
            throw new ApprovalRefused(
              "Host command refused: the working directory changed before execution.",
            );
          }
          // Let buffered output drain; detached descendants may hold the pipes open.
          if (tail) {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
              closed,
              new Promise<void>((done) => (timer = setTimeout(done, outputGraceMs))),
            ]);
            clearTimeout(timer);
          }
          return {
            content: [{ type: "text", text: format(code, tail, path) }],
            details: { exitCode: code, approvedBy },
          };
        } finally {
          run.removeEventListener("abort", kill);
          child.stdout?.destroy();
          child.stderr?.destroy();
          report?.destroy();
        }
      } catch (error) {
        if (error instanceof ApprovalRefused || error instanceof HostCommandStopped) throw error;
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
        ? { manager: ctx.sessionManager, id, lifetime: new AbortController(), denials: 0 }
        : undefined;
      showStatus(ctx);
    },
    stop() {
      session?.lifetime.abort();
      session = undefined;
    },
  };
}
