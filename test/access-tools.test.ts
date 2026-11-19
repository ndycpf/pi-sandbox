import type { Component, TUI } from "@earendil-works/pi-tui";

import childProcess, { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

import { ExecutionHistory } from "../src/execution-history.ts";
import extension from "../src/extension.ts";
import { registerUnsandboxBash } from "../src/unsandbox-bash.ts";

async function fixture(t: TestContext, enableAccessRequestTool: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-access-")));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "sandbox.json"),
    JSON.stringify({
      enabled: false,
      enableAccessRequestTool,
      network: { allowedDomains: ["allowed.example"], deniedDomains: ["blocked.example"] },
      filesystem: {
        allowRead: [join(root, "read")],
        allowWrite: [join(root, "write")],
        denyWrite: [join(root, "write", "denied")],
      },
    }),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["../active-skills"] }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  let prompts = 0;
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widget: (Component & { dispose?(): void }) | undefined;
  const editor = Object.create(CustomEditor.prototype) as CustomEditor;
  const tui = { requestRender() {}, getFocusedComponent: () => editor } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const api = {
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) =>
      handlers.set(event, handler),
    registerFlag() {},
    registerShortcut() {},
    registerCommand() {},
    getFlag: () => false,
    events: { emit() {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "fixture-session" },
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify() {},
      onTerminalInput(handler: typeof input) {
        input = handler;
        return () => {
          input = undefined;
        };
      },
      setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => typeof widget) {
        widget?.dispose?.();
        widget = undefined;
        if (!factory) return;
        prompts++;
        widget = factory(tui, theme);
      },
    },
  } as unknown as ExtensionContext;
  extension(api);
  t.after(() => handlers.get("session_shutdown")!({}, ctx));
  await handlers.get("session_start")!({}, ctx);
  return {
    root,
    tools,
    beforeTurn: (contextPath: string) =>
      handlers.get("before_agent_start")!(
        { systemPromptOptions: { contextFiles: [{ path: contextPath, content: "" }] } },
        ctx,
      ),
    prompts: () => prompts,
    send: (data: string) => {
      assert.ok(input, "Permission widget must be listening for input");
      input(data);
    },
    execute: (name: string, params: Record<string, unknown> = {}) =>
      tools.get(name)!.execute("test", params, undefined, undefined, ctx),
  };
}

test("access tools remain opt-in", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.tools.has("sandbox_status"), false);
  assert.equal(f.tools.has("sandbox_request_access"), false);
});

test("access tools report effective grants and avoid redundant or forbidden prompts", async (t) => {
  const f = await fixture(t, true);
  const request = (kind: string, target: string) =>
    f.execute("sandbox_request_access", { kind, target, reason: "Inspect project" });
  const status = async () => {
    const result = await f.execute("sandbox_status");
    const content = result.content.find((part) => part.type === "text");
    assert.ok(content && content.type === "text");
    return JSON.parse(content.text);
  };
  const initial = await status();
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.network.allowedDomains, ["allowed.example"]);
  assert.ok(initial.filesystem.allowRead.includes(join(f.root, "write")));
  assert.deepEqual(initial.sessionGrants, { domains: [], readPaths: [], writePaths: [] });

  await request("domain", "allowed.example");
  await request("read", join(f.root, "write", "file"));
  await request("write", join(f.root, "write", "file"));
  await assert.rejects(request("write", join(f.root, "write", "denied")), /explicitly denied/);
  await assert.rejects(request("domain", "blocked.example"), /explicitly denied/);
  assert.equal(f.prompts(), 0);

  await assert.rejects(request("write", join(f.root, ".pi", "settings.json")), /Human-managed/);
  assert.equal(f.prompts(), 0);
  // A separate disk edit must not hitchhike on this human-approved session grant.
  writeFileSync(
    join(f.root, "agent", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["changed.example"] } }),
  );
  const pending = request("read", join(f.root, "new", "file"));
  await setImmediate();
  f.send("\t");
  f.send("\x15");
  f.send(join(f.root, "new"));
  f.send("\r");
  const granted = await pending;
  const message = granted.content.find((part) => part.type === "text");
  assert.ok(message && message.type === "text");
  assert.ok(message.text.includes(`Rule: ${JSON.stringify(join(f.root, "new"))}`));
  assert.match(message.text, /Scope: session/);
  const updated = await status();
  assert.deepEqual(updated.network.allowedDomains, ["allowed.example"]);
  assert.ok(updated.filesystem.allowRead.includes(join(f.root, "new")));
  assert.deepEqual(updated.sessionGrants.readPaths, [join(f.root, "new")]);
  await request("read", join(f.root, "new", "another-file"));
  assert.equal(f.prompts(), 1);
});

test("native workspace writes distinguish fixtures from active resources", async (t) => {
  const f = await fixture(t, false);
  for (const name of [
    ".pi/settings.json",
    ".agents/SKILL.md",
    ".skills/sample",
    "AGENTS.md",
    "SKILL.md",
  ]) {
    const nested = join(f.root, "examples", name);
    await f.execute("write", { path: nested, content: "fixture" });
    assert.equal(readFileSync(nested, "utf8"), "fixture");
    await assert.rejects(
      f.execute("write", { path: join(f.root, name), content: "x" }),
      /Human-managed/,
    );
  }
  const context = join(f.root, "examples", "active-context.md");
  f.beforeTurn(context);
  for (const path of [context, join(f.root, "active-skills", "new", "SKILL.md")]) {
    await assert.rejects(f.execute("write", { path, content: "x" }), /Human-managed/);
  }
  symlinkSync(join(f.root, "agent"), join(f.root, "examples", "active"));
  await assert.rejects(
    f.execute("write", { path: join(f.root, "examples", "active", "settings.json"), content: "x" }),
    /Human-managed/,
  );
});

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
  const history = new ExecutionHistory();
  t.after(() => history.clear());
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  const host = registerUnsandboxBash(
    {
      registerTool(def: typeof tool) {
        tool = def;
      },
    } as ExtensionAPI,
    () => history,
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
  assert.equal(history.snapshot().filter((r) => r.spawned).length, 2);
  assert.ok(!JSON.stringify(history.snapshot()).includes(command));
});
