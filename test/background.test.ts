import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createSandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import {
  type BackgroundExit,
  BackgroundTasks,
  groupHasLiveProcess,
  Reservation,
  StaleStartError,
} from "../src/background-tasks.ts";
import { registerBackgroundTool, statusText } from "../src/background-tool.ts";
import {
  DEFAULT_BACKGROUND_BASH_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_HOST_BASH_CONFIG,
  mergeConfigLayers,
  resolveBackgroundBashConfig,
} from "../src/config.ts";
import {
  launchedInApprovedDirectory,
  promptTitle,
  registerHostBash,
  titleRows,
} from "../src/host-bash.ts";
import { OutputTail } from "../src/output-tail.ts";
import { initializeSandbox, spawnSandboxed } from "../src/sandbox-runtime.ts";

const unix = ["linux", "darwin"].includes(process.platform);

function sh(command: string, cwd = tmpdir()) {
  return spawn("/bin/sh", ["-c", command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("output tail keeps the last bytes", () => {
  const tail = new OutputTail(8);
  tail.push(Buffer.from("hello "));
  tail.push(Buffer.from("world!"));
  assert.equal(tail.total, 12);
  assert.equal(tail.text(), "o world!");
  assert.equal(tail.text(3), "ld!");
});

test("backgroundBash config is validated and merged across layers", () => {
  assert.deepEqual(resolveBackgroundBashConfig(undefined), DEFAULT_BACKGROUND_BASH_CONFIG);
  assert.deepEqual(
    resolveBackgroundBashConfig({ enabled: "yes", maxTasks: 0, bufferBytes: 1, outputBytes: 0 }),
    { ...DEFAULT_BACKGROUND_BASH_CONFIG, outputBytes: 0 },
  );
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { backgroundBash: { maxTasks: 2 } },
    { backgroundBash: { enabled: true } },
  );
  assert.deepEqual(merged.backgroundBash, {
    ...DEFAULT_BACKGROUND_BASH_CONFIG,
    enabled: true,
    maxTasks: 2,
  });
});

test("hostBash.allowBackground is global-only", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { hostBash: { enabled: true } },
    { hostBash: { allowBackground: true } },
  );
  assert.equal(merged.hostBash?.allowBackground, false);
  const global = mergeConfigLayers(
    DEFAULT_CONFIG,
    { hostBash: { enabled: true, allowBackground: true } },
    {},
  );
  assert.equal(global.hostBash?.allowBackground, true);
});

test(
  "tasks keep output, report their own exit, and run cleanup once",
  { skip: !unix },
  async () => {
    const exits: BackgroundExit[] = [];
    const tasks = new BackgroundTasks((exit) => exits.push(exit));
    let cleaned = 0;
    const info = tasks.add({
      kind: "sandbox",
      command: "echo one; echo two >&2; exit 3",
      cwd: tmpdir(),
      child: sh("echo one; echo two >&2; exit 3"),
      bufferBytes: 1024,
      visibleBytes: 1024,
      cleanup: () => cleaned++,
    });
    assert.equal(info.state, "running");
    await until(() => tasks.get(info.id)?.state === "exited");
    const logs = tasks.logs(info.id)!;
    assert.match(logs.text, /one/);
    assert.match(logs.text, /two/);
    assert.equal(logs.info.exitCode, 3);
    assert.equal(cleaned, 1);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.info.id, info.id);
    assert.equal(tasks.running(), 0);
  },
);

test(
  "stop kills the whole process group and is not reported as an exit",
  { skip: !unix },
  async () => {
    const exits: BackgroundExit[] = [];
    const tasks = new BackgroundTasks((exit) => exits.push(exit));
    // The shell ignores SIGTERM, so stopping needs the SIGKILL fallback; its
    // background child must die with the group.
    const info = tasks.add({
      kind: "host",
      command: "",
      cwd: tmpdir(),
      child: sh("trap '' TERM; sleep 30 & echo child=$!; wait"),
      bufferBytes: 1024,
      visibleBytes: 1024,
    });
    await until(() => /child=\d+/.test(tasks.logs(info.id)!.text));
    const childPid = Number(/child=(\d+)/.exec(tasks.logs(info.id)!.text)![1]);
    assert.ok(alive(childPid));
    const stopped = await tasks.stop(info.id, 200);
    assert.equal(stopped?.state, "exited");
    await until(() => !alive(childPid));
    assert.equal(exits.length, 0);
  },
);

test(
  "a task whose launcher exits keeps running while its process group does",
  { skip: !unix },
  async () => {
    const exits: BackgroundExit[] = [];
    const tasks = new BackgroundTasks((exit) => exits.push(exit));
    // The launcher exits at once with status 0; its worker stays in the group.
    const info = tasks.add({
      kind: "host",
      command: "",
      cwd: tmpdir(),
      child: sh("sleep 30 & echo worker=$!"),
      bufferBytes: 1024,
      visibleBytes: 1024,
    });
    await until(() => /worker=\d+/.test(tasks.logs(info.id)!.text));
    const workerPid = Number(/worker=(\d+)/.exec(tasks.logs(info.id)!.text)![1]);
    await until(() => tasks.get(info.id)?.exitCode === 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(tasks.get(info.id)?.state, "running");
    assert.equal(tasks.running(), 1);
    assert.ok(alive(workerPid));
    const stopped = await tasks.stop(info.id, 200);
    assert.equal(stopped?.state, "exited");
    await until(() => !alive(workerPid));
    assert.equal(exits.length, 0);

    // Once the rest of the group exits by itself, the task exits and is reported.
    const short = tasks.add({
      kind: "host",
      command: "",
      cwd: tmpdir(),
      child: sh("sleep 0.5 >/dev/null 2>&1 & echo launched"),
      bufferBytes: 1024,
      visibleBytes: 1024,
    });
    await until(() => tasks.get(short.id)?.exitCode === 0);
    assert.equal(tasks.get(short.id)?.state, "running");
    await until(() => tasks.get(short.id)?.state === "exited");
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.info.id, short.id);
  },
);

test("stopAll stops every running task", { skip: !unix }, async () => {
  const tasks = new BackgroundTasks();
  const ids = [1, 2].map(
    () =>
      tasks.add({
        kind: "sandbox",
        command: "sleep 30",
        cwd: tmpdir(),
        child: sh("sleep 30"),
        bufferBytes: 1024,
        visibleBytes: 0,
      }).id,
  );
  assert.equal(tasks.running(), 2);
  await tasks.stopAll(200);
  assert.equal(tasks.running(), 0);
  for (const id of ids) assert.equal(tasks.get(id)?.state, "exited");
});

function backgroundTool(
  tasks: BackgroundTasks,
  config = { ...DEFAULT_BACKGROUND_BASH_CONFIG, enabled: true },
) {
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  registerBackgroundTool(
    { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
    {
      tasks,
      config: () => config,
      hostBackground: false,
      start: async (command, ctx) =>
        tasks.add({
          kind: "sandbox",
          command,
          cwd: ctx.cwd,
          child: sh(command, ctx.cwd),
          bufferBytes: config.bufferBytes,
          visibleBytes: config.outputBytes,
        }),
    },
  );
  const ctx = { cwd: tmpdir() } as unknown as ExtensionToolContext;
  const call = async (params: Record<string, unknown>) => {
    const result = await tool.execute("t", params, undefined, undefined, ctx);
    const [content] = result.content;
    return content?.type === "text" ? content.text : "";
  };
  return call;
}

test("bash_background starts, lists, shows logs and stops tasks", { skip: !unix }, async () => {
  const tasks = new BackgroundTasks();
  const call = backgroundTool(tasks);
  const started = await call({ action: "start", command: "echo ready; exec sleep 30" });
  assert.match(started, /^Started bg1 \[running\] in the sandbox/);
  await until(() => tasks.logs("bg1")!.text.includes("ready"));
  assert.match(await call({ action: "list" }), /bg1 \[running\]/);
  assert.match(await call({ action: "logs", id: "bg1" }), /ready/);
  assert.match(await call({ action: "stop", id: "bg1" }), /Stopped: bg1 \[exited/);
  await assert.rejects(call({ action: "logs", id: "bg9" }), /Unknown background task/);
  await assert.rejects(call({ action: "stop" }), /needs an id/);
});

test(
  "bash_background refuses start when disabled or at the task limit",
  { skip: !unix },
  async () => {
    const tasks = new BackgroundTasks();
    const disabled = backgroundTool(tasks, DEFAULT_BACKGROUND_BASH_CONFIG);
    await assert.rejects(disabled({ action: "start", command: "true" }), /disabled/);
    const limited = backgroundTool(tasks, {
      ...DEFAULT_BACKGROUND_BASH_CONFIG,
      enabled: true,
      maxTasks: 1,
    });
    await limited({ action: "start", command: "sleep 30" });
    await assert.rejects(limited({ action: "start", command: "sleep 30" }), /Too many/);
    await tasks.stopAll(200);
  },
);

test(
  "a sandboxed background task outlives its start call and stays sandboxed",
  { skip: !unix, timeout: 20_000 },
  async (t: TestContext) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-bg-sandbox-")));
    const manager = createSandboxManager();
    t.after(async () => {
      await manager.reset();
      rmSync(cwd, { recursive: true, force: true });
    });
    const config = {
      ...DEFAULT_CONFIG,
      network: { ...DEFAULT_CONFIG.network!, allowAllUnixSockets: true },
      filesystem: { denyRead: [], allowRead: [cwd], allowWrite: [cwd], denyWrite: [] },
    };
    try {
      await initializeSandbox(manager, config, undefined, cwd);
    } catch (error) {
      t.skip(`sandbox unavailable: ${String(error)}`);
      return;
    }
    const tasks = new BackgroundTasks();
    let cleaned = 0;
    const probe =
      "(: > outside-probe) 2>/dev/null; touch /usr/pi-bg-escape 2>/dev/null && echo escaped || echo blocked; echo ready; exec sleep 30";
    const info = tasks.add({
      kind: "sandbox",
      command: probe,
      cwd,
      child: await spawnSandboxed(manager, probe, cwd, { env: process.env }),
      bufferBytes: 4096,
      visibleBytes: 4096,
      cleanup: () => {
        cleaned++;
        manager.cleanupAfterCommand();
      },
    });
    try {
      await until(
        () => /ready/.test(tasks.logs(info.id)!.text) || tasks.get(info.id)?.state === "exited",
      );
    } catch {
      // Fall through to the skip below.
    }
    if (!/ready/.test(tasks.logs(info.id)!.text)) {
      await tasks.stopAll(200);
      t.skip(`sandbox cannot run here: ${tasks.logs(info.id)!.text}`);
      return;
    }
    assert.match(tasks.logs(info.id)!.text, /blocked/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(tasks.get(info.id)?.state, "running");
    assert.equal(cleaned, 0);
    await tasks.stop(info.id, 500);
    assert.equal(cleaned, 1);
  },
);

function hostFixture(
  t: TestContext,
  options: {
    allowBackground: boolean;
    select?: (title: string) => string;
    mode?: "tui" | "rpc";
    /** Holds each approval prompt until it resolves. */
    gate?: Promise<void>;
  },
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-bg-")));
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
  const tasks = new BackgroundTasks();
  t.after(() => tasks.stopAll(200));
  // Read on every call, like the global config.
  const settings = { allowBackground: options.allowBackground };
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  const host = registerHostBash(
    { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
    () => true,
    () => ({
      ...DEFAULT_HOST_BASH_CONFIG,
      enabled: true,
      timeoutSeconds: 1,
      allowBackground: settings.allowBackground,
    }),
    {
      background: {
        tasks,
        limits: () => ({ ...DEFAULT_BACKGROUND_BASH_CONFIG, maxTasks: 1 }),
      },
    },
  );
  const titles: string[] = [];
  const ctx = {
    cwd,
    mode: options.mode ?? "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: {
      select: async (title: string) => {
        titles.push(title);
        await options.gate;
        return options.select ? options.select(title) : "Allow once";
      },
      notify: () => {},
    },
  } as unknown as ExtensionToolContext;
  host.start(ctx);
  t.after(() => host.stop());
  const run = async (params: Record<string, unknown>) => {
    const result = await tool.execute("t", params, undefined, undefined, ctx);
    const [content] = result.content;
    return { text: content?.type === "text" ? content.text : "", details: result.details };
  };
  return { tool: () => tool, tasks, titles, run, settings };
}

test(
  "host_bash background runs an approved command past the time limit",
  { skip: !unix, timeout: 15_000 },
  async (t) => {
    const { tool, tasks, titles, run } = hostFixture(t, { allowBackground: true });
    assert.ok("background" in (tool().parameters as { properties: object }).properties);
    const result = await run({ command: "echo up; exec sleep 30", background: true });
    assert.match(result.text, /Started host background task bg1/);
    assert.deepEqual(result.details, { taskId: "bg1", approvedBy: "operator" });
    assert.match(titles[0]!, /in BACKGROUND/);
    assert.match(titles[0]!, /until stopped or Pi exits/);
    // Longer than hostBash.timeoutSeconds (1s): background runs are not limited.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(tasks.get("bg1")?.kind, "host");
    assert.equal(tasks.get("bg1")?.state, "running");
    assert.match(tasks.logs("bg1")!.text, /up/);
    await assert.rejects(
      run({ command: "sleep 30", background: true }),
      /background tasks are already running/,
    );
    await tasks.stop("bg1", 200);
  },
);

test("a background launcher that exits before its report is still started", async () => {
  // Exit arrives first, then the report: the start counts and nothing is killed.
  const child = Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess;
  let report!: (ok: boolean) => void;
  const verified = new Promise<boolean>((done) => (report = done));
  const launched = launchedInApprovedDirectory(child, verified, new AbortController().signal);
  child.emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  report(true);
  await launched;

  // A failed report after an exit still refuses.
  const failed = Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess;
  const refused = launchedInApprovedDirectory(
    failed,
    Promise.resolve(false),
    new AbortController().signal,
  );
  failed.emit("exit", 125, null);
  await assert.rejects(refused, /refused/);
});

test(
  "short host_bash background commands start and report their exit",
  { skip: !unix, timeout: 30_000 },
  async (t) => {
    const { tasks, run } = hostFixture(t, { allowBackground: true });
    for (let i = 0; i < 20; i++) {
      const result = await run({ command: `echo done${i}`, background: true });
      assert.match(result.text, /Started host background task/, `run ${i}`);
      const id = (result.details as { taskId: string }).taskId;
      await until(() => tasks.get(id)?.state === "exited");
      assert.equal(tasks.get(id)?.exitCode, 0);
      assert.match(tasks.logs(id)!.text, new RegExp(`done${i}`));
    }
  },
);

test("tasks.add takes a child that already exited", { skip: !unix }, async () => {
  const exits: BackgroundExit[] = [];
  const tasks = new BackgroundTasks((exit) => exits.push(exit));
  const child = sh("echo early; exit 3");
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  await new Promise((resolve) => child.once("close", resolve));
  const info = tasks.add({
    kind: "host",
    command: "",
    cwd: tmpdir(),
    child,
    output,
    bufferBytes: 1024,
    visibleBytes: 1024,
  });
  await until(() => tasks.get(info.id)?.state === "exited");
  assert.equal(tasks.get(info.id)?.exitCode, 3);
  assert.equal(exits.length, 1);
  assert.match(exits[0]!.tail, /early/);
});

test("a process group holding only zombies counts as gone", () => {
  const proc = mkdtempSync(join(tmpdir(), "pi-proc-"));
  try {
    const stat = (pid: number, comm: string, state: string, pgrp: number) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1\n`,
      );
    };
    stat(100, "worker", "Z", 100);
    stat(101, "odd ) name", "Z", 100);
    stat(200, "other", "S", 200);
    mkdirSync(join(proc, "self"));
    assert.equal(groupHasLiveProcess(100, proc), false);
    assert.equal(groupHasLiveProcess(200, proc), true);
    stat(102, "x) S 1 100 (y", "R", 100);
    assert.equal(groupHasLiveProcess(100, proc), true);
    assert.equal(groupHasLiveProcess(100, join(proc, "missing")), undefined);
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});

test(
  "a task ends when only unreaped zombies are left in its group",
  { skip: process.platform !== "linux" || spawnSync("python3", ["-V"]).status !== 0 },
  async (t) => {
    const exits: BackgroundExit[] = [];
    const tasks = new BackgroundTasks((exit) => exits.push(exit));
    t.after(() => tasks.stopAll(200));
    // A parent that never reaps moves itself to another group, leaving its
    // exited child behind as a zombie in the task's group, as an orphan does
    // under a PID 1 that does not reap.
    const script = [
      "import os, sys, time",
      "pid = os.fork()",
      "if pid == 0: os._exit(0)",
      "os.setpgid(0, 0)",
      "print(f'parent={os.getpid()} zombie={pid}', flush=True)",
      "sys.stdout.close(); sys.stderr.close()",
      "time.sleep(30)",
    ].join("\n");
    const info = tasks.add({
      kind: "host",
      command: "",
      cwd: tmpdir(),
      child: sh(`python3 -c "${script}" & wait`),
      bufferBytes: 1024,
      visibleBytes: 1024,
    });
    await until(() => /parent=\d+/.test(tasks.logs(info.id)!.text));
    const parent = Number(/parent=(\d+)/.exec(tasks.logs(info.id)!.text)![1]);
    t.after(() => {
      try {
        process.kill(parent, "SIGKILL");
      } catch {}
    });
    const zombie = Number(/zombie=(\d+)/.exec(tasks.logs(info.id)!.text)![1]);
    // The shell waits only for python3's original pid, which is the parent.
    // Kill the shell so only the zombie stays in the group.
    process.kill(info.pid!, "SIGKILL");
    await until(() => tasks.get(info.id)?.state === "exited", 5000);
    assert.ok(alive(zombie), "the zombie is still there");
    assert.equal(exits.length, 1);
  },
);

test("host_bash background needs approval and the global opt-in", { skip: !unix }, async (t) => {
  const denied = hostFixture(t, { allowBackground: true, select: () => "Deny" });
  await assert.rejects(denied.run({ command: "sleep 30", background: true }), /refused/);
  assert.equal(denied.tasks.running(), 0);

  const off = hostFixture(t, { allowBackground: false });
  assert.ok(!("background" in (off.tool().parameters as { properties: object }).properties));
  // Without the opt-in the flag is ignored and the command runs in the foreground.
  const result = await off.run({ command: "echo fg", background: true });
  assert.match(result.text, /exit status: 0/);
  assert.equal(off.tasks.running(), 0);
});

test("host_bash background is approved through an RPC client", { skip: !unix }, async (t) => {
  // RPC approval needs no TTY; hide it to be sure the RPC path is used.
  const { tasks, titles, run } = hostFixture(t, { allowBackground: true, mode: "rpc" });
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, "isTTY", { configurable: true, value: false });
  const result = await run({ command: "exec sleep 30", background: true });
  assert.match(result.text, /Started host background task bg1/);
  assert.match(titles[0]!, /in BACKGROUND/);
  assert.equal(tasks.get("bg1")?.state, "running");
  await tasks.stop("bg1", 200);
});

test("the background prompt leaves the command as many rows as a foreground one", () => {
  for (const outputBytes of [0, 65536]) {
    const options = { ...DEFAULT_HOST_BASH_CONFIG, timeoutSeconds: 3600, outputBytes };
    const cwd = "/" + "d".repeat(40);
    assert.equal(
      titleRows(promptTitle("x", cwd, options, true)),
      titleRows(promptTitle("x", cwd, options, false)),
    );
  }
});

test("the footer shows how many tasks run, and where", { skip: !unix }, async () => {
  const shown: (string | undefined)[] = [];
  const tasks: BackgroundTasks = new BackgroundTasks(undefined, () =>
    shown.push(statusText(tasks.list())),
  );
  assert.equal(statusText([]), undefined);
  const add = (kind: "sandbox" | "host") =>
    tasks.add({
      kind,
      command: "sleep 30",
      cwd: tmpdir(),
      child: sh("sleep 30"),
      bufferBytes: 1024,
      visibleBytes: 0,
    });
  add("sandbox");
  add("host");
  assert.equal(shown.at(-1), "bg: 2 running (1 host)");
  await tasks.stopAll(200);
  assert.equal(shown.at(-1), undefined);
});

test("wait returns on a match, an exit, a timeout or an abort", { skip: !unix }, async () => {
  const tasks = new BackgroundTasks();
  const server = tasks.add({
    kind: "sandbox",
    command: "",
    cwd: tmpdir(),
    child: sh("sleep 0.2; echo booting; sleep 0.2; echo listening on 3000; exec sleep 30"),
    bufferBytes: 4096,
    visibleBytes: 4096,
  });
  const matched = await tasks.wait(server.id, { timeoutMs: 5000, until: /listening on \d+/ });
  assert.equal(matched?.reason, "matched");
  assert.equal(matched?.info.state, "running");
  const timedOut = await tasks.wait(server.id, { timeoutMs: 100 });
  assert.equal(timedOut?.reason, "timeout");
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  assert.equal(
    (await tasks.wait(server.id, { timeoutMs: 5000, signal: abort.signal }))?.reason,
    "aborted",
  );
  assert.equal(tasks.get(server.id)?.state, "running");
  const build = tasks.add({
    kind: "sandbox",
    command: "",
    cwd: tmpdir(),
    child: sh("sleep 0.2; exit 2"),
    bufferBytes: 4096,
    visibleBytes: 4096,
  });
  const exited = await tasks.wait(build.id, { timeoutMs: 5000 });
  assert.equal(exited?.reason, "exited");
  assert.equal(exited?.info.exitCode, 2);
  assert.equal(await tasks.wait("bg99", { timeoutMs: 10 }), undefined);
  await tasks.stopAll(200);
});

test(
  "start with until streams output into the tool call until the task is ready",
  { skip: !unix },
  async () => {
    const tasks = new BackgroundTasks();
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    registerBackgroundTool(
      { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
      {
        tasks,
        config: () => ({ ...DEFAULT_BACKGROUND_BASH_CONFIG, enabled: true }),
        hostBackground: false,
        start: async (command, ctx) =>
          tasks.add({
            kind: "sandbox",
            command,
            cwd: ctx.cwd,
            child: sh(command, ctx.cwd),
            bufferBytes: 4096,
            visibleBytes: 4096,
          }),
      },
    );
    const updates: string[] = [];
    const ctx = { cwd: tmpdir() } as unknown as ExtensionToolContext;
    const result = await tool.execute(
      "t",
      {
        action: "start",
        command: "echo compiling; sleep 0.7; echo ready in 1s; exec sleep 30",
        until: "ready in",
        timeoutSeconds: 10,
      },
      undefined,
      (partial: { content: { type: string; text?: string }[] }) =>
        updates.push(partial.content[0]?.text ?? ""),
      ctx,
    );
    const [content] = result.content;
    const body = content?.type === "text" ? content.text : "";
    assert.match(body, /ready in 1s/);
    assert.match(body, /still running/);
    assert.ok(updates.some((line) => line.includes("compiling")));
    await assert.rejects(
      tool.execute("t", { action: "wait", id: "bg1", until: "(" }, undefined, undefined, ctx),
      /not a valid regular expression/,
    );
    await tasks.stopAll(200);
  },
);

test(
  "stop waits for the whole process group, even after the shell exits",
  { skip: !unix },
  async () => {
    const tasks = new BackgroundTasks();
    // The shell exits on SIGTERM; its worker ignores SIGTERM and keeps running.
    const info = tasks.add({
      kind: "host",
      command: "",
      cwd: tmpdir(),
      child: sh("(trap '' TERM; exec sleep 30) & echo worker=$!; wait"),
      bufferBytes: 1024,
      visibleBytes: 1024,
    });
    await until(() => /worker=\d+/.test(tasks.logs(info.id)!.text));
    const worker = Number(/worker=(\d+)/.exec(tasks.logs(info.id)!.text)![1]);
    const stopping = tasks.stop(info.id, 300);
    // Still stopping while the worker lives, and counted against the limit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tasks.get(info.id)?.state, "stopping");
    assert.equal(tasks.running(), 1);
    const stopped = await stopping;
    assert.equal(stopped?.state, "exited");
    await until(() => !alive(worker));
  },
);

test(
  "a stop that the group obeys returns without waiting for the grace period",
  { skip: !unix },
  async () => {
    const tasks = new BackgroundTasks();
    const info = tasks.add({
      kind: "sandbox",
      command: "",
      cwd: tmpdir(),
      child: sh("sleep 30 & wait"),
      bufferBytes: 1024,
      visibleBytes: 0,
    });
    const begun = Date.now();
    await tasks.stop(info.id, 5000);
    assert.ok(Date.now() - begun < 2000);
  },
);

test(
  "reservations count against the limit and holds refuse and expire them",
  { skip: !unix },
  async () => {
    const tasks = new BackgroundTasks();
    const first = tasks.reserve(1);
    assert.ok(first instanceof Reservation);
    assert.deepEqual(tasks.reserve(1), { refused: "full" });
    first.release();
    first.release();
    const second = tasks.reserve(1);
    assert.ok(second instanceof Reservation);
    const added = tasks.add({
      kind: "sandbox",
      command: "sleep 30",
      cwd: tmpdir(),
      child: sh("sleep 30"),
      bufferBytes: 1024,
      visibleBytes: 0,
      reservation: second,
    });
    // The task now holds the slot; the reservation does not count twice.
    assert.deepEqual(tasks.reserve(2) instanceof Reservation, true);
    await tasks.stop(added.id, 200);

    const early = tasks.reserve(4) as Reservation;
    const release = tasks.hold();
    assert.deepEqual(tasks.reserve(4), { refused: "held" });
    let cleaned = 0;
    const child = sh("echo started; exec sleep 30");
    assert.throws(
      () =>
        tasks.add({
          kind: "sandbox",
          command: "sleep 30",
          cwd: tmpdir(),
          child,
          bufferBytes: 1024,
          visibleBytes: 0,
          cleanup: () => cleaned++,
          reservation: early,
        }),
      StaleStartError,
    );
    await until(() => child.exitCode !== null || child.signalCode !== null);
    await until(() => cleaned === 1);
    assert.equal(tasks.running(), 0);
    release();
    assert.ok(tasks.reserve(4) instanceof Reservation);
  },
);

test("concurrent starts cannot pass maxTasks", { skip: !unix }, async () => {
  const tasks = new BackgroundTasks();
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  registerBackgroundTool(
    { registerTool: (def: typeof tool) => (tool = def) } as unknown as ExtensionAPI,
    {
      tasks,
      config: () => ({ ...DEFAULT_BACKGROUND_BASH_CONFIG, enabled: true, maxTasks: 1 }),
      hostBackground: false,
      start: async (command, ctx, reservation) => {
        // Spawning takes a while, as wrapping for the sandbox does.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return tasks.add({
          kind: "sandbox",
          command,
          cwd: ctx.cwd,
          child: sh(command, ctx.cwd),
          bufferBytes: 1024,
          visibleBytes: 0,
          reservation,
        });
      },
    },
  );
  const ctx = { cwd: tmpdir() } as unknown as ExtensionToolContext;
  const start = () =>
    tool.execute("t", { action: "start", command: "exec sleep 30" }, undefined, undefined, ctx);
  const results = await Promise.allSettled([start(), start()]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected"],
  );
  assert.match(String((results[1] as PromiseRejectedResult).reason), /Too many background tasks/);
  assert.equal(tasks.running(), 1);

  // A failed spawn gives its slot back.
  await tasks.stopAll(200);
  const release = tasks.hold();
  await assert.rejects(start(), /cannot start right now/);
  release();
  assert.ok(tasks.reserve(1) instanceof Reservation);
});

test(
  "turning hostBash.allowBackground off applies to the registered tool",
  { skip: !unix },
  async (t) => {
    const { run, settings, tasks, titles } = hostFixture(t, { allowBackground: true });
    settings.allowBackground = false;
    await assert.rejects(
      run({ command: "exec sleep 30", background: true }),
      /background runs are turned off/,
    );
    assert.equal(titles.length, 0);
    assert.equal(tasks.running(), 0);
  },
);

test("a host_bash background call awaiting approval holds its slot", { skip: !unix }, async (t) => {
  let approve!: () => void;
  const gate = new Promise<void>((resolve) => (approve = resolve));
  const { run, tasks } = hostFixture(t, {
    allowBackground: true,
    select: () => "Allow once",
    gate,
  });
  // The fixture's limit is one task; the host call holds it while the operator decides.
  const pending = run({ command: "exec sleep 30", background: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(tasks.reserve(1), { refused: "full" });
  approve();
  await pending;
  assert.equal(tasks.running(), 1);
  assert.deepEqual(tasks.reserve(1), { refused: "full" });
});
