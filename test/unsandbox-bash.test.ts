import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import childProcess, { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { registerUnsandboxBash } from "../src/unsandbox-bash.ts";

test("host Bash requires one current affirmative terminal approval", async (t) => {
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
        tool = def;
      },
    } as ExtensionAPI,
    () => true,
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
    prompts = 0;
  let choose!: (choice?: string) => void;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: {
      select(text: string, options: string[], { signal }: { signal: AbortSignal }) {
        assert.deepEqual(options, ["Deny", "Allow once"]);
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
  assert.match(title, /compacted: omitted 5 lines and/);
  choose("Deny");
  await assert.rejects(pending, /refused/);

  const long = "# " + "x".repeat(2500);
  pending = run(undefined, long);
  assert.ok(title.length <= 2200);
  assert.match(title, /compacted: omitted \d+ characters/);
  choose("Allow once");
  await pending;
  assert.equal(launch.mock.calls.at(-1)?.arguments[1]?.at(-1), long);
  assert.equal(launch.mock.callCount(), 2);
});
