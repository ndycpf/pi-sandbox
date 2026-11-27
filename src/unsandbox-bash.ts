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
// A compacted prompt hides part of the command, so it offers Deny only.
function compactTitle(title: string): { title: string; compacted: boolean } {
  const lines = title.split("\n");
  if (lines.length <= 32 && title.length <= 2200) return { title, compacted: false };

  const prefixLines = lines.slice(0, 31);
  const omittedLines = lines.length - prefixLines.length;
  let prefix = prefixLines.join("\n").trimEnd();
  // The size of the notice depends on how many characters it replaces.
  for (;;) {
    const omitted = title.length - prefix.length;
    const counts = [];
    if (omittedLines) counts.push(`${omittedLines} ${omittedLines === 1 ? "line" : "lines"}`);
    counts.push(`${omitted} ${omitted === 1 ? "character" : "characters"}`);
    const notice = `[Permission prompt compacted: omitted ${counts.join(" and ")} to keep the permission dialog usable. Allow once is unavailable because the command is not fully shown.]`;
    const budget = 2200 - notice.length - 1;
    if (prefix.length <= budget) return { title: prefix + "\n" + notice, compacted: true };
    prefix = prefix.slice(0, budget).trimEnd();
  }
}

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
  const { title, compacted } = compactTitle(
    [
      "Run outside the OS sandbox?",
      "Host files and network are accessible. Changes can persist.",
      `Limit: ${options.timeoutSeconds}s; ${output}.`,
      "Shell: " + shell,
      "PATH (JSON): " + quoted(path),
      "CWD (JSON): " + quoted(cwd),
      "Command (JSON-quoted lines): " + command.split("\n").map(quoted).join("\n"),
    ].join("\n"),
  );
  const choices = compacted ? ["Deny"] : ["Deny", "Allow once"];
  const choice = await ctx.ui.select(title, choices, { signal });
  if (signal.aborted || choice === undefined) {
    throw new ApprovalRefused(
      signal.reason?.name === "TimeoutError"
        ? "Host command refused: approval timed out."
        : "Host command refused: approval cancelled.",
    );
  }
  return !compacted && choice === "Allow once";
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

function format(code: number | null, tail: Tail | undefined) {
  const status = "Host Bash exit status: " + (code ?? "terminated by signal");
  if (!tail) return status;
  if (!tail.total) return status + "\nNo output.";
  const shown = Math.min(tail.total, tail.limitBytes);
  const header =
    shown < tail.total
      ? `Output (last ${shown} of ${tail.total} bytes, stdout and stderr interleaved):`
      : "Output (stdout and stderr interleaved):";
  return status + "\n" + header + "\n" + tail.text();
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
      "Use ordinary bash first; call this only when a command needs access the sandbox blocks (network hosts, paths outside the workspace, host services) " +
      "and repeating it in the sandbox cannot work. Every call prompts the operator. " +
      "Keep the command short and self-contained: if it does not fit the prompt in full (about 25 lines), it is refused. " +
      "Runs non-interactively with stdin closed, a minimal environment and a time limit. " +
      "Returns the exit status and, when enabled, the tail of combined stdout/stderr.",
    promptSnippet: "Ask the operator to run one Bash command outside the sandbox",
    promptGuidelines: [
      "Use bash_with_human_approval only after sandboxed bash fails because of sandbox restrictions, and explain in your reply why host access is needed.",
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
        // Check the actual child cwd against the open approved directory before exec.
        // Command text is one argv element, never interpolated into the launcher.
        const guard =
          '[[ . -ef /dev/fd/3 ]] || exit 125; exec 3<&-; exec /bin/bash --noprofile --norc -c "$1"';
        const tail = options.outputBytes ? new Tail(options.outputBytes) : undefined;
        const env: Record<string, string> = { PATH: path };
        if (process.env.HOME) env.HOME = process.env.HOME;
        const child = spawn(shell, ["--noprofile", "--norc", "-c", guard, "bash", command], {
          cwd,
          detached: true,
          stdio: ["ignore", tail ? "pipe" : "ignore", tail ? "pipe" : "ignore", fd],
          env,
        });
        const closed = new Promise<void>((done) => child.once("close", () => done()));
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => tail?.push(chunk));
        }
        const run = AbortSignal.any([lifetime, AbortSignal.timeout(options.timeoutSeconds * 1000)]);
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
          run.throwIfAborted();
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
            content: [{ type: "text", text: format(code, tail) }],
            details: { exitCode: code },
          };
        } finally {
          run.removeEventListener("abort", kill);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
      } catch (error) {
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
