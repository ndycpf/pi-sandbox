import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { Type } from "typebox";

import { canonicalizePath, matchesPattern } from "./policy.ts";

/**
 * Runs a shell command for the reviewer inside the OS sandbox, read-only and
 * offline. The sandbox decides what can be read, including `credentials.files`.
 */
export type ReviewExec = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ stdout: Buffer; exitCode: number | null }>;

export const maxToolCalls = 8;
const maxReadBytes = 16 * 1024;
const maxTotalBytes = 64 * 1024;
const maxEntries = 200;
const readLimit = 1024 * 1024;

// Secret files the reviewer never reads, even where the sandbox could: what it
// reads is sent to the model provider. A path check only; the sandbox is the
// boundary.
const secretDirs = [
  // Process state, including Pi's environment and API keys.
  "/proc",
  "/sys",
  "/dev",
  "~/.pi/agent/auth.json",
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.azure",
  "~/.kube",
  "~/.docker",
  "~/.config/gh",
  "~/.config/gcloud",
  "~/.password-store",
  "~/Library/Keychains",
];
const secretNames = [
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_[a-z0-9]+$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^credentials(\.json)?$/i,
  /^\.git-credentials$/,
];

/** Whether `path`, after resolving symlinks, is a secret file the reviewer must not read. */
export function isSecretPath(path: string, cwd: string) {
  const real = canonicalizePath(path, cwd);
  return (
    matchesPattern(real, secretDirs, cwd) || secretNames.some((name) => name.test(basename(real)))
  );
}

export const reviewTools = [
  {
    name: "read",
    description:
      "Read a text file. Returns at most 16 KiB, starting at `offset` lines (default 0). Paths are relative to the planned action's cwd.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  },
  {
    name: "ls",
    description:
      "List a directory's entries (dirs end with /). Paths are relative to the planned action's cwd.",
    parameters: Type.Object({ path: Type.String() }),
  },
];

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Runs the reviewer's tool calls for one review, within call and byte budgets. */
export class ReviewToolRunner {
  calls = 0;
  /** What was checked, for the review log. */
  readonly history: { tool: string; path: string; ok: boolean }[] = [];
  private bytes = 0;
  constructor(
    private readonly cwd: string,
    private readonly exec: ReviewExec | undefined,
  ) {}

  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const result = await this.attempt(name, args, signal);
    this.history.push({
      tool: name,
      path: typeof args.path === "string" ? args.path.slice(0, 300) : "",
      ok: !result.isError,
    });
    return result;
  }

  private async attempt(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const fail = (text: string) => ({ text, isError: true });
    this.calls++;
    if (this.calls > maxToolCalls || this.bytes >= maxTotalBytes)
      return fail("Tool budget exhausted. Give your final answer now.");
    const path = typeof args.path === "string" && args.path ? args.path : undefined;
    if (!path) return fail("Missing path.");
    if (name !== "read" && name !== "ls") return fail(`Unknown tool ${name}.`);
    if (isSecretPath(path, this.cwd)) return fail("Refused: secret file.");
    if (!this.exec) return fail("Failed: no sandbox to read with.");
    // Absolute paths, so `~` and the cwd mean the same inside the sandbox.
    const target = quote(resolve(this.cwd, path.replace(/^~(?=$|\/)/, homedir())));
    const [test, kind, command] =
      name === "read"
        ? ["-f", "a regular file", `head -c ${readLimit}`]
        : ["-d", "a directory", "ls -1Ap"];
    const script = `if [ ! -e ${target} ]; then echo 'No such file.'; exit 3; elif [ ! ${test} ${target} ]; then echo 'Not ${kind}.'; exit 3; fi; exec ${command} -- ${target}`;
    let out: Awaited<ReturnType<ReviewExec>>;
    try {
      out = await this.exec(script, this.cwd, signal);
    } catch (error) {
      return fail(`Failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (out.exitCode === 3) return fail(out.stdout.toString().trim());
    if (out.exitCode !== 0) return fail("Failed: not readable in the sandbox.");
    const text =
      name === "read"
        ? this.page(out.stdout, Number.isInteger(args.offset) ? (args.offset as number) : 0)
        : this.listing(out.stdout);
    this.bytes += Buffer.byteLength(text);
    return { text, isError: false };
  }

  // The sandbox read at most `readLimit` bytes; `offset` lines are skipped here.
  private page(data: Buffer, offset: number) {
    if (data.includes(0)) return "Binary file.";
    const budget = Math.min(maxReadBytes, maxTotalBytes - this.bytes);
    const lines = data.toString("utf-8").split("\n");
    const body = Buffer.from(lines.slice(offset).join("\n"));
    const shown = body
      .subarray(0, budget)
      .toString("utf-8")
      .replace(/\uFFFD$/, "");
    return body.length > budget || data.length >= readLimit
      ? `${shown}\n<truncated: ${data.length >= readLimit ? "over " : ""}${lines.length} lines; use offset to read further />`
      : shown;
  }

  private listing(data: Buffer) {
    const entries = data.toString("utf-8").split("\n").filter(Boolean);
    const shown = entries.slice(0, maxEntries);
    if (entries.length > maxEntries) shown.push(`<truncated: ${entries.length} entries />`);
    return shown.join("\n") || "(empty)";
  }
}
