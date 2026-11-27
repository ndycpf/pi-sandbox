import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import childProcess, { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_HOST_BASH_CONFIG,
  mergeConfigLayers,
  resolveHostBashConfig,
} from "../src/config.ts";
import { hostPath, registerHostBash, titleRows } from "../src/host-bash.ts";

test("host_bash requires one current affirmative terminal approval", async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-approval-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const stream of [process.stdin, process.stdout]) {
    const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    t.after(() =>
      previous
        ? Object.defineProperty(stream, "isTTY", previous)
        : Reflect.deleteProperty(stream, "isTTY"),
    );
  }
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  const host = registerHostBash(
    {
      registerTool(def: typeof tool) {
        assert.equal(def.name, "host_bash");
        tool = def;
      },
    } as ExtensionAPI,
    () => true,
    () => ({ ...DEFAULT_HOST_BASH_CONFIG, enabled: true }),
  );
  const launch = t.mock.method(childProcess, "spawn", () => {
    const child = new ChildProcess();
    const report = new PassThrough();
    Object.defineProperty(child, "stdio", { value: [null, null, null, report] });
    queueMicrotask(() => {
      child.emit("spawn");
      report.end("ok");
      child.emit("exit", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    launch.mock.restore();
    syncBuiltinESMExports();
  });
  let title = "",
    prompts = 0,
    choices: string[] = [];
  let choose!: (choice?: string) => void;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: {
      select(text: string, options: string[], { signal }: { signal: AbortSignal }) {
        choices = options;
        title = text;
        prompts++;
        return new Promise<string | undefined>((done) => {
          choose = done;
          signal.addEventListener("abort", () => done(undefined), { once: true });
        });
      },
    },
  };
  const context = ctx as unknown as ExtensionContext;
  host.start(context);
  t.after(() => host.stop());
  const command = "printf x >> proof";
  const run = (signal?: AbortSignal, text = command) =>
    tool.execute("test", { command: text }, signal, undefined, context);
  for (const mode of ["rpc", "print", "json"]) {
    ctx.mode = mode;
    await assert.rejects(run(), /refused/);
  }
  ctx.mode = "tui";
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  await assert.rejects(run(), /refused/);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  assert.equal(prompts, 0);
  let pending = run();
  await assert.rejects(run(), /refused/);
  choose("Deny");
  await assert.rejects(pending, /refused/);
  pending = run();
  assert.ok(title.includes(JSON.stringify(cwd)) && title.includes(JSON.stringify(command)));
  assert.deepEqual(choices, ["Deny", "Allow once"]);
  assert.match(title, /limit 60s, agent sees last 16384 bytes of output/);
  choose("Allow once");
  assert.deepEqual((await pending).details, { exitCode: 0, approvedBy: "operator" });
  assert.equal(launch.mock.callCount(), 1);

  const abort = new AbortController();
  pending = run(abort.signal, "printf '\u001b\u202e'");
  assert.ok(title.includes("\\u001b") && title.includes("\\u202e"));
  abort.abort();
  await assert.rejects(pending, /approval cancelled/);
  pending = run();
  ctx.cwd = dirname(cwd);
  choose("Allow once");
  await assert.rejects(pending, /refused/);
  ctx.cwd = cwd;
  pending = run();
  host.stop();
  await assert.rejects(pending, /refused/);
  host.start(context);
  const expired = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => expired.signal);
  pending = run();
  expired.abort(new DOMException("Timeout", "TimeoutError"));
  await assert.rejects(pending, /approval timed out/);
  timeout.mock.restore();
  // Oversized commands go back to the agent without prompting the operator.
  // The header's height depends on the CWD length, so derive the budget from it.
  const before = prompts;
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join("\n");
  const header = title.slice(0, title.indexOf("Command: "));
  const available = 11 - titleRows(header.slice(0, -1));
  assert.ok(available >= 4);
  await assert.rejects(
    run(undefined, lines(available + 1)),
    new RegExp(
      `refused before prompting: command too long\\. The approval prompt must fit an 80x24 terminal, which leaves 11 rows .* the command gets ${available} rows of 78 columns; as shown \\(JSON-quoted\\) it has ${available + 1} lines and needs ${available + 1} rows`,
    ),
  );
  // One long line wraps at the assumed width.
  await assert.rejects(
    run(undefined, "echo " + "y".repeat(600)),
    /1 line and needs \d+ rows.*Shorten the command/,
  );
  assert.equal(prompts, before);
  // The largest command that fits is still prompted in full.
  pending = run(undefined, lines(available));
  assert.equal(prompts, before + 1);
  assert.equal(titleRows(title), 11);
  assert.ok(title.includes(JSON.stringify(`echo ${available - 1}`)));
  choose("Deny");
  await assert.rejects(pending, /refused/);
  assert.equal(launch.mock.callCount(), 1);
});

test("host_bash refuses when hostBash is disabled", async (t) => {
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  const host = registerHostBash(
    { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
    () => true,
    () => DEFAULT_HOST_BASH_CONFIG,
  );
  let prompts = 0;
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: { select: async () => (prompts++, "Allow once") },
  } as unknown as ExtensionContext;
  for (const stream of [process.stdin, process.stdout]) {
    const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    t.after(() =>
      previous
        ? Object.defineProperty(stream, "isTTY", previous)
        : Reflect.deleteProperty(stream, "isTTY"),
    );
  }
  host.start(ctx);
  t.after(() => host.stop());
  await assert.rejects(
    tool.execute("t", { command: "true" }, undefined, undefined, ctx),
    /refused/,
  );
  assert.equal(prompts, 0);
});

test("hostBash config is global-only and validated", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { hostBash: { enabled: true } },
    { hostBash: { enabled: false, timeoutSeconds: 3000 } },
  );
  assert.deepEqual(merged.hostBash, {
    enabled: true,
    timeoutSeconds: 60,
    outputBytes: 16384,
    review: { mode: "human", timeoutSeconds: 60 },
  });
  // A project file cannot turn on auto-review either.
  assert.equal(
    mergeConfigLayers(
      DEFAULT_CONFIG,
      { hostBash: { enabled: true } },
      { hostBash: { review: { mode: "auto", model: "x/y" } } },
    ).hostBash?.review?.mode,
    "human",
  );
  assert.equal(
    mergeConfigLayers(DEFAULT_CONFIG, {}, { hostBash: { enabled: true } }).hostBash?.enabled,
    false,
  );
  assert.deepEqual(
    resolveHostBashConfig({ timeoutSeconds: 0, outputBytes: 1e9 }),
    DEFAULT_HOST_BASH_CONFIG,
  );
  assert.equal(resolveHostBashConfig({ timeoutSeconds: 600, outputBytes: 0 }).outputBytes, 0);
});

test("hostPath inherits Pi's PATH", (t) => {
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
  });
  process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
  assert.equal(hostPath(), "/opt/homebrew/bin:/usr/bin:/bin");
  process.env.PATH = "";
  assert.equal(hostPath(), "/usr/bin:/bin");
});
