import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";

import { Type } from "typebox";

import { DEFAULT_HOST_BASH_CONFIG, type HostBashConfig } from "./config.ts";

const shell = "/bin/bash";
const refusal = "Host command refused.";
const deadline = 60_000; // Approval limit.
const systemPath = "/usr/bin:/bin";
const outputGraceMs = 200;
// Prints "device:inode" of a path; device numbers match Node's fstat().dev.
const statCommand = process.platform === "darwin" ? "stat -f %d:%i" : "stat -c %d:%i";
let busy = false; // One prompt or process across registrations sharing this module.

// Reversible ASCII display, including newlines, bidi controls and invisible characters.
function quoted(value: string) {
  return JSON.stringify(value).replace(
    /[^ -~]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

class ApprovalRefused extends Error {}
class HostCommandStopped extends Error {}

const maxPromptLines = 32;
const maxPromptChars = 2200;

async function approve(
  ctx: ExtensionContext,
  command: string,
  cwd: string,
  path: string,
  options: HostBashConfig,
  signal: AbortSignal,
) {
  const output = options.outputBytes
    ? `last ${options.outputBytes} bytes of stdout/stderr are returned to the agent`
    : "only the exit status is returned to the agent";
  const header = [
    "Run outside the OS sandbox?",
    "Host files and network are accessible. Changes can persist.",
    `Limit: ${options.timeoutSeconds}s; ${output}.`,
    "Shell: " + shell,
    "PATH (JSON): " + quoted(path),
    "CWD (JSON): " + quoted(cwd),
  ];
  const shown = command.split("\n").map(quoted);
  const title = [...header, "Command (JSON-quoted lines): " + shown.join("\n")].join("\n");
  const lines = title.split("\n").length;
  // The operator must be able to read the whole command, so an oversized one
  // goes back to the agent instead of reaching the operator.
  if (lines > maxPromptLines || title.length > maxPromptChars) {
    const commandLines = maxPromptLines - header.length;
    const commandChars = maxPromptChars - (title.length - shown.join("\n").length);
    throw new ApprovalRefused(
      `Host command refused before prompting: command too long. ` +
        `As shown to the operator it is ${shown.length} lines and ${shown.join("\n").length} characters (JSON-quoted); ` +
        `the limit for this call is ${commandLines} lines and ${commandChars} characters, so the operator could not read all of it. ` +
        "Shorten the command and call again: split it into several bash_with_human_approval calls, " +
        "remove comments and blank lines, or run the parts that do not need the host in ordinary sandboxed bash. " +
        "Do not move the logic into a script file to shorten it; the operator cannot review a file's contents in the prompt.",
    );
  }
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

function within(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function resolved(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

// System directories first so configured entries cannot shadow them. Entries in
// the workspace or temp directories are dropped: sandboxed Bash can write there.
export function hostPath(extraPath: readonly string[], cwd: string) {
  const writable = [cwd, "/tmp", tmpdir()].map(resolved);
  const extra = extraPath.filter((entry) => {
    const real = resolved(entry);
    return !writable.some((dir) => within(dir, entry) || within(dir, real));
  });
  return [systemPath, ...extra].join(":");
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
  if (code === 127) {
    status +=
      `\nExit status 127 usually means a program was not found on the host PATH (${path}). ` +
      "Report this to the operator: if the program is installed elsewhere, they can add its directory to hostBash.extraPath in the global sandbox.json. " +
      "Do not retry the same command.";
  }
  return status + outputText(tail);
}

export function registerUnsandboxBash(
  pi: ExtensionAPI,
  ready: () => boolean,
  config: (cwd: string) => HostBashConfig = () => DEFAULT_HOST_BASH_CONFIG,
) {
  let session:
    | { manager: ExtensionContext["sessionManager"]; id: string; lifetime: AbortController }
    | undefined;

  pi.registerTool({
    name: "bash_with_human_approval",
    label: "Bash with human approval",
    description:
      "Run one Bash command on the host, outside the OS sandbox, after the human operator approves it in the interactive CLI. " +
      "Ordinary bash runs inside the sandbox, which blocks paths outside the workspace, most network hosts, local services and credential stores. " +
      "Use this tool when a sandboxed command fails or gives misleading results because of that, or when the task needs something only the host has. " +
      "Typical signs: 'Operation not permitted', 'Permission denied' outside the workspace, blocked network, 'command not found' for a tool installed on the host (docker, brew, gcloud), " +
      "an unreachable daemon or socket, or missing or invalid credentials (gh, git, cloud CLIs, keychain). " +
      "Every call prompts the operator, so do not use it for work the sandbox can do. " +
      "Keep the command short and self-contained: a command over about 25 lines or 2,000 characters is refused without prompting and must be shortened or split. " +
      "Runs non-interactively with stdin closed, a minimal PATH and environment, and a time limit. " +
      "Returns the exit status and, when enabled, the tail of combined stdout/stderr.",
    promptSnippet: "Ask the operator to run one Bash command outside the sandbox",
    promptGuidelines: [
      "When sandboxed bash is blocked or misleading because of the sandbox (permission errors, blocked network, a host tool not found, an unreachable daemon, invalid credentials), do not give up or report the sandboxed result as the host state: call bash_with_human_approval with the same command and say in one sentence why host access is needed.",
      "Do not use bash_with_human_approval for work that succeeds in the sandbox.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4096 }) }),
    async execute(_id, { command }, abort, _update, ctx) {
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
        const expires = performance.now() + deadline;
        const approval = AbortSignal.any([lifetime, AbortSignal.timeout(deadline)]);
        const original = ctx.cwd;
        const cwd = realpathSync.native(original);
        fd = openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
        const dir = fstatSync(fd, { bigint: true });
        const path = hostPath(options.extraPath, cwd);
        approval.throwIfAborted();
        if (
          (await approve(ctx, command, cwd, path, options, approval)) !== true ||
          !current() ||
          approval.aborted ||
          performance.now() >= expires ||
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
            details: { exitCode: code },
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
        ? { manager: ctx.sessionManager, id, lifetime: new AbortController() }
        : undefined;
    },
    stop() {
      session?.lifetime.abort();
      session = undefined;
    },
  };
}
