import { existsSync, opendirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { Type } from "typebox";

import { canonicalizePath, matchesPattern } from "./policy.ts";

/** One reviewer command: `shell -c command` in `cwd`, with extra paths the sandbox must deny. */
export type ReviewRequest = { command: string; cwd: string; shell: string; denyRead: string[] };

/**
 * Runs a reviewer command inside the OS sandbox, read-only and offline. The
 * sandbox decides what can be read, including `credentials.files`.
 */
export type ReviewExec = (
  request: ReviewRequest,
  signal?: AbortSignal,
) => Promise<{ stdout: Buffer; exitCode: number | null }>;

/** The programs the reviewer's tools run, by absolute path, never looked up in PATH. */
export type ReviewBinaries = { sh?: string; head?: string; ls?: string };

// Usual locations on macOS and Linux, with or without a merged /usr.
const binaryCandidates = {
  sh: ["/bin/sh", "/usr/bin/sh"],
  head: ["/usr/bin/head", "/bin/head"],
  ls: ["/bin/ls", "/usr/bin/ls"],
} as const;

/**
 * Validate `hostBash.review.binaries`. Each entry overrides the default
 * candidates and must be an absolute path; unset entries use the first
 * candidate that exists.
 */
export function resolveReviewBinaries(value: unknown): {
  binaries: ReviewBinaries;
  error?: string;
} {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const binaries: ReviewBinaries = {};
  for (const name of Object.keys(binaryCandidates) as (keyof typeof binaryCandidates)[]) {
    const given = raw[name];
    if (given === undefined) {
      binaries[name] = binaryCandidates[name].find((path) => existsSync(path));
    } else if (typeof given === "string" && isAbsolute(given)) {
      binaries[name] = given;
    } else {
      return { binaries, error: `hostBash.review.binaries.${name} must be an absolute path` };
    }
  }
  return { binaries };
}

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

// Process state is mounted by the sandbox itself and cannot be denied there; it
// is refused by path only. The sandbox sees just the reviewer's own process.
const pathOnlyDirs = new Set(["/proc", "/sys", "/dev"]);
const maxWalkEntries = 50_000;

/**
 * Secret paths for the sandbox to deny on every reviewer command, so a symlink
 * swapped after the path check still cannot reach them: the fixed secret
 * directories, and secret-named files under `cwd`. `complete` is false when
 * the walk stopped at its entry limit, and then nothing should be read.
 */
export function secretDenyPaths(cwd: string, limit = maxWalkEntries) {
  const paths = secretDirs
    .filter((dir) => !pathOnlyDirs.has(dir))
    .map((dir) => canonicalizePath(dir, cwd));
  const pending = [cwd];
  let seen = 0;
  while (pending.length && seen < limit) {
    const dir = pending.pop()!;
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      for (let entry = handle.readSync(); entry && seen < limit; entry = handle.readSync()) {
        seen++;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (secretNames.some((name) => name.test(entry.name))) {
          try {
            paths.push(realpathSync.native(path));
          } catch {
            // A dangling link reads nothing.
          }
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { paths: [...new Set(paths)], complete: !pending.length && seen < limit };
}

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
    private readonly binaries: ReviewBinaries,
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
    // Room is kept for at least a short answer and its truncation notice.
    if (this.calls > maxToolCalls || maxTotalBytes - this.bytes < 256)
      return fail("Tool budget exhausted. Give your final answer now.");
    const path = typeof args.path === "string" && args.path ? args.path : undefined;
    if (!path) return fail("Missing path.");
    if (name !== "read" && name !== "ls") return fail(`Unknown tool ${name}.`);
    if (isSecretPath(path, this.cwd)) return fail("Refused: secret file.");
    if (!this.exec) return fail("Failed: no sandbox to read with.");
    const program = name === "read" ? this.binaries.head : this.binaries.ls;
    const missing = !this.binaries.sh ? "sh" : !program ? (name === "read" ? "head" : "ls") : "";
    if (missing)
      return fail(`Failed: no ${missing} found; set hostBash.review.binaries.${missing}.`);
    // Absolute paths, so `~` and the cwd mean the same inside the sandbox.
    const target = quote(resolve(this.cwd, path.replace(/^~(?=$|\/)/, homedir())));
    const [test, kind, command] =
      name === "read"
        ? ["-f", "a regular file", `${quote(program!)} -c ${readLimit}`]
        : ["-d", "a directory", `${quote(program!)} -1Ap`];
    const script = `if [ ! -e ${target} ]; then echo 'No such file.'; exit 3; elif [ ! ${test} ${target} ]; then echo 'Not ${kind}.'; exit 3; fi; exec ${command} -- ${target}`;
    // Built for each call, so files that appeared since the last one are covered.
    const secrets = secretDenyPaths(this.cwd);
    if (!secrets.complete)
      return fail(
        `Refused: the working directory has over ${maxWalkEntries} entries, too many to protect secret files.`,
      );
    let out: Awaited<ReturnType<ReviewExec>>;
    try {
      out = await this.exec(
        { command: script, cwd: this.cwd, shell: this.binaries.sh!, denyRead: secrets.paths },
        signal,
      );
    } catch (error) {
      return fail(`Failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (out.exitCode === 3) return fail(out.stdout.toString().trim());
    if (out.exitCode !== 0) return fail("Failed: not readable in the sandbox.");
    const room = maxTotalBytes - this.bytes;
    const text =
      name === "read"
        ? page(
            out.stdout,
            Number.isInteger(args.offset) ? (args.offset as number) : 0,
            Math.min(maxReadBytes, room),
          )
        : listing(out.stdout, room);
    this.bytes += Buffer.byteLength(text);
    return { text, isError: false };
  }
}

/** `text` cut to at most `bytes` bytes of UTF-8, without a split character. */
function cut(text: string, bytes: number) {
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  return data
    .subarray(0, Math.max(0, bytes))
    .toString("utf-8")
    .replace(/\uFFFD$/, "");
}

// The sandbox read at most `readLimit` bytes; `offset` lines are skipped here,
// and the result, notices included, fits in `limit` bytes.
function page(data: Buffer, offset: number, limit: number) {
  if (data.includes(0)) return "Binary file.";
  const partial = data.length >= readLimit;
  const lines = data.toString("utf-8").split("\n");
  // A partial window ends mid-line; that line and all after it cannot be checked.
  if (partial) lines.pop();
  const beyond = "content past the first 1 MiB cannot be checked";
  if (offset >= lines.length) return partial ? `<${beyond} />` : "<end of file />";
  const body = lines.slice(offset).join("\n") + (partial ? "\n" : "");
  const end = partial ? `<truncated: ${beyond} />` : "";
  if (Buffer.byteLength(body + end) <= limit) return body + end;
  const more = "\n<truncated: use offset to read further />";
  return cut(body, limit - Buffer.byteLength(more)) + more;
}

// At most `maxEntries` names, and the result, notice included, fits in `limit` bytes.
function listing(data: Buffer, limit: number) {
  const entries = data.toString("utf-8").split("\n").filter(Boolean);
  if (!entries.length) return "(empty)";
  const all = entries.join("\n");
  if (entries.length <= maxEntries && Buffer.byteLength(all) <= limit) return all;
  const notice = `<truncated: ${entries.length} entries />`;
  const shown: string[] = [];
  let size = Buffer.byteLength(notice);
  for (const entry of entries.slice(0, maxEntries)) {
    size += Buffer.byteLength(entry) + 1;
    if (size > limit) break;
    shown.push(entry);
  }
  return [...shown, notice].join("\n");
}
