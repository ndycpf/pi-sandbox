import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Type } from "typebox";

import { canonicalizePath, matchesPattern } from "./policy.ts";

/**
 * Which paths the reviewer may read: the sandbox's own read rules, and the
 * sandbox's `credentials.files` paths, which the reviewer never reads whether
 * they are denied or masked.
 */
export type ReadPolicy = { denyRead: string[]; allowRead: string[]; credentialFiles?: string[] };

export const maxToolCalls = 8;
const maxReadBytes = 16 * 1024;
const maxTotalBytes = 64 * 1024;
const maxEntries = 200;

// Secret files the reviewer never reads, even where the sandbox could: what it
// reads is sent to the model provider.
const secretDirs = [
  // Pi's own process state, including its environment and API keys.
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

/** Why `path` must not be read, or undefined. Paths are checked after resolving symlinks. */
export function readRefusal(path: string, cwd: string, policy: ReadPolicy) {
  const real = canonicalizePath(path, cwd);
  if (policy.credentialFiles?.length && matchesPattern(real, policy.credentialFiles, cwd))
    return "credential file in the sandbox's credentials config";
  if (
    matchesPattern(real, secretDirs, cwd) ||
    secretNames.some((name) => name.test(basename(real)))
  )
    return "secret file";
  // Same rule as the sandbox: a denied subtree is readable only where allowRead re-allows it.
  if (matchesPattern(real, policy.denyRead, cwd) && !matchesPattern(real, policy.allowRead, cwd))
    return "outside what the sandbox can read";
  return undefined;
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
      "List a directory's entries (dirs end with /, symlinks show their target). Paths are relative to the planned action's cwd.",
    parameters: Type.Object({ path: Type.String() }),
  },
];

/** Runs the reviewer's tool calls for one review, within call and byte budgets. */
export class ReviewToolRunner {
  calls = 0;
  /** What was checked, for the review log. */
  readonly history: { tool: string; path: string; ok: boolean }[] = [];
  private bytes = 0;
  constructor(
    private readonly cwd: string,
    private readonly policy: ReadPolicy,
  ) {}

  run(name: string, args: Record<string, unknown>): { text: string; isError: boolean } {
    const result = this.attempt(name, args);
    this.history.push({
      tool: name,
      path: typeof args.path === "string" ? args.path.slice(0, 300) : "",
      ok: !result.isError,
    });
    return result;
  }

  private attempt(name: string, args: Record<string, unknown>): { text: string; isError: boolean } {
    this.calls++;
    if (this.calls > maxToolCalls || this.bytes >= maxTotalBytes)
      return { text: "Tool budget exhausted. Give your final answer now.", isError: true };
    const path = typeof args.path === "string" && args.path ? args.path : undefined;
    if (!path) return { text: "Missing path.", isError: true };
    if (name !== "read" && name !== "ls") return { text: `Unknown tool ${name}.`, isError: true };
    // Open first, then check policy on the path the opened object resolves to,
    // and confirm that path still names the same object. A symlink swapped
    // during the check then fails instead of reading something else.
    let fd: number | undefined;
    try {
      const target = resolve(this.cwd, path.replace(/^~(?=$|\/)/, homedir()));
      fd = openSync(
        target,
        constants.O_RDONLY | constants.O_NONBLOCK | (name === "ls" ? constants.O_DIRECTORY : 0),
      );
      const opened = fstatSync(fd);
      const real = realpathSync.native(target);
      const refusal = readRefusal(real, this.cwd, this.policy);
      if (refusal) return { text: `Refused: ${refusal}.`, isError: true };
      if (!sameObject(opened, statSync(real)))
        return { text: "Refused: the path changed while it was checked.", isError: true };
      const text =
        name === "read"
          ? this.read(fd, opened, Number.isInteger(args.offset) ? (args.offset as number) : 0)
          : this.ls(real, opened);
      this.bytes += Buffer.byteLength(text);
      return { text, isError: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") return { text: "Not a directory.", isError: true };
      if (code === "ECHANGED")
        return { text: "Refused: the path changed while it was checked.", isError: true };
      return { text: `Failed: ${code ?? "error"}.`, isError: true };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // Reads from the already checked descriptor. O_NONBLOCK on open keeps a FIFO
  // from stalling the review; only regular files are read.
  private read(fd: number, info: Stats, offset: number) {
    if (!info.isFile()) return "Not a regular file.";
    const budget = Math.min(maxReadBytes, maxTotalBytes - this.bytes);
    // Read enough to skip `offset` lines plus the budget, capped.
    const limit = Math.min(info.size, 1024 * 1024);
    const data = Buffer.alloc(limit);
    let size = 0;
    while (size < limit) {
      const n = readSync(fd, data, size, limit - size, null);
      if (!n) break;
      size += n;
    }
    const raw = data.subarray(0, size);
    if (raw.includes(0)) return `Binary file, ${info.size} bytes.`;
    const lines = new TextDecoder("utf-8").decode(raw).split("\n");
    const body = lines.slice(offset).join("\n");
    const bytes = Buffer.from(body);
    const shown = new TextDecoder("utf-8").decode(bytes.subarray(0, budget)).replace(/�$/, "");
    const more =
      bytes.length > budget || info.size > limit
        ? `\n<truncated: file has ${info.size} bytes and ${info.size > limit ? "over " : ""}${lines.length} lines; use offset to read further />`
        : "";
    return shown + more;
  }

  // Node cannot list an open directory descriptor, so the listing is taken by
  // the checked real path and the object is compared again afterwards.
  private ls(path: string, opened: Stats) {
    if (!opened.isDirectory()) return "Not a directory.";
    const entries = readdirSync(path, { withFileTypes: true });
    if (realpathSync.native(path) !== path || !sameObject(opened, statSync(path)))
      throw Object.assign(new Error("changed"), { code: "ECHANGED" });
    const shown = entries.slice(0, maxEntries).map((entry) => {
      if (entry.isDirectory()) return entry.name + "/";
      if (entry.isSymbolicLink()) {
        try {
          return `${entry.name} -> ${readlinkSync(join(path, entry.name))}`;
        } catch {
          return `${entry.name} -> ?`;
        }
      }
      return entry.name;
    });
    if (entries.length > maxEntries) shown.push(`<truncated: ${entries.length} entries />`);
    return shown.join("\n") || "(empty)";
  }
}

function sameObject(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}
