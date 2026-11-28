import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type ExtensionAPI,
  type ExtensionToolContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";

const unix = ["linux", "darwin"].includes(process.platform);

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = { handler: (args: string, ctx: ExtensionToolContext) => Promise<void> };

async function harness(t: TestContext, mode: "tui" | "rpc") {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-ui-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  // The sandbox is off so this runs anywhere; the UI does not depend on it.
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
    JSON.stringify({ enabled: false, backgroundBash: { enabled: true } }),
  );
  const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const status = new Map<string, string | undefined>();
  const widgets = new Map<string, unknown>();
  const notes: string[] = [];
  let pick: (options: string[]) => string | undefined = () => undefined;
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) =>
      handlers.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerFlag: () => {},
    registerShortcut: () => {},
    getFlag: () => false,
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode,
    hasUI: true,
    sessionManager: SessionManager.inMemory(root),
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string) => notes.push(message),
      setStatus: (key: string, text: string | undefined) => status.set(key, text),
      setWidget: (key: string, lines: unknown) => widgets.set(key, lines),
      select: async (_title: string, options: string[]) => pick(options),
      theme: { fg: (color: string, text: string) => `<${color}>${text}` },
    },
  } as unknown as ExtensionToolContext;
  extension(api);
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  t.after(async () => {
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  const tool = tools.get("bash_background")!;
  return {
    status,
    widgets,
    notes,
    setPick: (fn: typeof pick) => (pick = fn),
    start: (command: string) =>
      tool.execute("t", { action: "start", command }, undefined, undefined, ctx),
    command: (args: string) => commands.get("background")!.handler(args, ctx),
  };
}

for (const mode of ["tui", "rpc"] as const) {
  test(`running tasks show in the footer and a widget (${mode})`, { skip: !unix }, async (t) => {
    const ui = await harness(t, mode);
    await ui.start("exec sleep 30");
    await ui.start("exec sleep 31");
    // RPC clients get plain text; the TUI gets the themed status.
    assert.equal(
      ui.status.get("background"),
      mode === "tui" ? "<accent>bg: 2 running (2 unsandboxed)" : "bg: 2 running (2 unsandboxed)",
    );
    assert.deepEqual(ui.widgets.get("background"), [
      "bg1 [no sandbox] exec sleep 30",
      "bg2 [no sandbox] exec sleep 31",
    ]);

    await ui.command("");
    assert.match(ui.notes.at(-1)!, /bg1 \[running\][\s\S]*bg2 \[running\]/);

    // Without an id, stop asks which task: Pi's selector, or the RPC select dialog.
    ui.setPick((options) => options.find((line) => line.startsWith("bg1 ")));
    await ui.command("stop");
    assert.match(ui.notes.at(-1)!, /^Stopped: bg1/);
    assert.deepEqual(ui.widgets.get("background"), ["bg2 [no sandbox] exec sleep 31"]);

    await ui.command("stop all");
    assert.equal(ui.status.get("background"), undefined);
    assert.equal(ui.widgets.get("background"), undefined);
  });
}
