import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import childProcess, { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_HOST_BASH_CONFIG,
  mergeConfigLayers,
  resolveHostBashConfig,
} from "../src/config.ts";
import { hostPath, registerUnsandboxBash } from "../src/unsandbox-bash.ts";

test("bash_with_human_approval requires one current affirmative terminal approval", async (t) => {
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
  const host = registerUnsandboxBash(
    {
      registerTool(def: typeof tool) {
        assert.equal(def.name, "bash_with_human_approval");
        tool = def;
      },
    } as ExtensionAPI,
    () => true,
    () => ({ ...DEFAULT_HOST_BASH_CONFIG, enabled: true }),
  );
  const launch = t.mock.method(childProcess, "spawn", () => {
    const child = new ChildProcess();
    queueMicrotask(() => {
      child.emit("spawn");
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
  assert.match(title, /Limit: 60s; last 16384 bytes of stdout\/stderr are returned/);
  choose("Allow once");
  assert.deepEqual((await pending).details, { exitCode: 0 });
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
  const multiline = Array.from({ length: 32 }, (_, i) => `# line ${i}`).join("\n");
  pending = run(undefined, multiline);
  assert.equal(title.split("\n").length, 32);
  assert.match(title, /compacted: omitted 7 lines and/);
  assert.deepEqual(choices, ["Deny"]);
  choose("Deny");
  await assert.rejects(pending, /refused/);

  // A compacted prompt cannot be approved, even if the UI returns "Allow once".
  const long = "# " + "x".repeat(2500);
  pending = run(undefined, long);
  assert.ok(title.length <= 2200);
  assert.match(title, /compacted: omitted \d+ characters/);
  assert.match(title, /Allow once is unavailable/);
  assert.deepEqual(choices, ["Deny"]);
  choose("Allow once");
  await assert.rejects(pending, /refused/);
  assert.equal(launch.mock.callCount(), 1);
});

test("bash_with_human_approval refuses when hostBash is disabled", async (t) => {
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  const host = registerUnsandboxBash(
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
    { hostBash: { enabled: true, extraPath: ["/opt/homebrew/bin", "relative", "/a:/b"] } },
    { hostBash: { enabled: false, extraPath: ["/evil"], timeoutSeconds: 3000 } },
  );
  assert.deepEqual(merged.hostBash, {
    enabled: true,
    extraPath: ["/opt/homebrew/bin"],
    timeoutSeconds: 60,
    outputBytes: 16384,
  });
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

test("hostPath keeps system directories first and drops sandbox-writable entries", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-path-")));
  try {
    assert.equal(
      hostPath(["/opt/homebrew/bin", join(cwd, "bin"), "/tmp/bin", join(tmpdir(), "x")], cwd),
      "/usr/bin:/bin:/opt/homebrew/bin",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
