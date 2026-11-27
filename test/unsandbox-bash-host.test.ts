import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_HOST_BASH_CONFIG, type HostBashConfig } from "../src/config.ts";
import { registerUnsandboxBash } from "../src/unsandbox-bash.ts";

const supported = ["linux", "darwin"].includes(process.platform);

function fixture(t: TestContext, options: Partial<HostBashConfig> = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-real-")));
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
    { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
    () => true,
    () => ({ ...DEFAULT_HOST_BASH_CONFIG, enabled: true, ...options }),
  );
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: { select: async () => "Allow once" },
  } as unknown as ExtensionContext;
  host.start(ctx);
  t.after(() => host.stop());
  const run = async (command: string) => {
    const result = await tool.execute("t", { command }, undefined, undefined, ctx);
    const [content] = result.content;
    return { text: content?.type === "text" ? content.text : "", details: result.details };
  };
  return { cwd, run };
}

test(
  "approved host command runs in the approved directory with a minimal environment",
  {
    skip: !supported,
  },
  async (t) => {
    const { cwd, run } = fixture(t, { extraPath: ["/opt/example/bin", join(tmpdir(), "bin")] });
    const result = await run(
      'printf "%s|%s" "$PWD" "$PATH" > out; echo hello; echo oops >&2; exit 3',
    );
    assert.deepEqual(result.details, { exitCode: 3 });
    assert.equal(readFileSync(join(cwd, "out"), "utf8"), cwd + "|/usr/bin:/bin:/opt/example/bin");
    assert.match(
      result.text,
      /^Host Bash exit status: 3\nOutput \(stdout and stderr interleaved\):\n/,
    );
    assert.match(result.text, /hello\n/);
    assert.match(result.text, /oops\n/);
  },
);

test("host command output is limited to its tail", { skip: !supported }, async (t) => {
  const { run } = fixture(t, { outputBytes: 100 });
  const result = await run("for i in $(seq 1 1000); do echo line$i; done");
  assert.match(result.text, /Output \(last 100 of \d+ bytes/);
  assert.match(result.text, /line1000\n$/);
  assert.doesNotMatch(result.text, /line1\n/);
});

test("outputBytes 0 returns the exit status only", { skip: !supported }, async (t) => {
  const { run } = fixture(t, { outputBytes: 0 });
  const result = await run("echo hidden");
  assert.equal(result.text, "Host Bash exit status: 0");
});

test("host command is killed at its time limit", { skip: !supported }, async (t) => {
  const { cwd, run } = fixture(t, { timeoutSeconds: 1 });
  const started = Date.now();
  await assert.rejects(run("sleep 30; touch late"), /interrupted/);
  assert.ok(Date.now() - started < 10_000);
  assert.throws(() => readFileSync(join(cwd, "late")));
});

test("background descendants do not hold the result open", { skip: !supported }, async (t) => {
  const { run } = fixture(t);
  const started = Date.now();
  const result = await run("echo before; (sleep 5 &) ; exit 0");
  assert.ok(Date.now() - started < 3_000);
  assert.match(result.text, /before/);
});

test(
  "launcher refuses when its cwd is not the approved directory",
  { skip: !supported },
  async (t) => {
    const { cwd, run } = fixture(t);
    // Swap the approved directory for another one at the same path between the
    // parent's last check and the launcher's own check.
    const real = await import("node:child_process");
    const original = real.spawn;
    const { renameSync, mkdirSync } = await import("node:fs");
    const mock = t.mock.method(real.default, "spawn", (...args: Parameters<typeof original>) => {
      renameSync(cwd, cwd + "-moved");
      mkdirSync(cwd);
      t.after(() => rmSync(cwd + "-moved", { recursive: true, force: true }));
      return original(...args);
    });
    const { syncBuiltinESMExports } = await import("node:module");
    syncBuiltinESMExports();
    t.after(() => {
      mock.mock.restore();
      syncBuiltinESMExports();
    });
    await assert.rejects(run("touch ran"), /working directory changed/);
    assert.throws(() => readFileSync(join(cwd, "ran")));
  },
);
