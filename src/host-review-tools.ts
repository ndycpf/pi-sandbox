import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import { Type } from "typebox";

import { canonicalizePath, matchesPattern } from "./policy.ts";

/** Which paths the reviewer may read: the sandbox's own read rules. */
export type ReadPolicy = { denyRead: string[]; allowRead: string[] };

export const maxToolCalls = 8;
const maxReadBytes = 16 * 1024;
const maxTotalBytes = 64 * 1024;
const maxEntries = 200;

// Secret files the reviewer never reads, even where the sandbox could: what it
// reads is sent to the model provider.
const secretDirs = [
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
    const refusal = readRefusal(path, this.cwd, this.policy);
    if (refusal) return { text: `Refused: ${refusal}.`, isError: true };
    const real = canonicalizePath(path, this.cwd);
    try {
      const text =
        name === "read"
          ? this.read(real, Number.isInteger(args.offset) ? (args.offset as number) : 0)
          : name === "ls"
            ? this.ls(real)
            : undefined;
      if (text === undefined) return { text: `Unknown tool ${name}.`, isError: true };
      this.bytes += Buffer.byteLength(text);
      return { text, isError: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { text: `Failed: ${code ?? "error"}.`, isError: true };
    }
  }

  private read(path: string, offset: number) {
    if (!statSync(path).isFile()) return "Not a regular file.";
    // Non-blocking, so a FIFO swapped in after the check cannot stall the review.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
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
    } finally {
      closeSync(fd);
    }
  }

  private ls(path: string) {
    if (!statSync(path).isDirectory()) return "Not a directory.";
    const entries = readdirSync(path, { withFileTypes: true });
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
