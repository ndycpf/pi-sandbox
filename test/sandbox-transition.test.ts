import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ExtensionAPI,
  type ExtensionToolContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";
import { supportsSandboxPlatform } from "../src/sandbox-runtime.ts";
import { SettleGate } from "../src/settle-gate.ts";

test("a settle gate waits for every change in progress", async () => {
  const gate = new SettleGate();
  await gate.settled();
  const first = gate.enter();
  const second = gate.enter();
  let settled = false;
  const waiting = gate.settled().then(() => (settled = true));
  first();
  first();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  second();
  await waiting;
  assert.equal(settled, true);
});

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Command = { handler: (args: string, ctx: ExtensionToolContext) => Promise<void> };

test(
  "bash called while the sandbox is being turned on waits and runs sandboxed",
  { skip: !supportsSandboxPlatform(), timeout: 20_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-transition-")));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    // Start with the sandbox off; allowAllUnixSockets avoids needing seccomp's
    // nested user namespace, which some CI containers lack.
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
      JSON.stringify({
        enabled: false,
        network: { allowAllUnixSockets: true },
        filesystem: { denyRead: [], allowRead: [root], allowWrite: [root], denyWrite: [] },
      }),
    );
    const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => unknown>();
    const tools = new Map<string, Tool>();
    const commands = new Map<string, Command>();
    const notes: string[] = [];
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
      mode: "tui",
      hasUI: true,
      sessionManager: SessionManager.inMemory(root),
      isProjectTrusted: () => true,
      ui: {
        notify: (message: string) => notes.push(message),
        setStatus: () => {},
        setWidget: () => {},
        theme: { fg: (_color: string, text: string) => text },
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

    const order: string[] = [];
    const enabling = commands
      .get("sandbox-enable")!
      .handler("", ctx)
      .then(() => order.push("enabled"));
    // Called before initialization finishes: it must not take the unsandboxed path.
    const bash = tools
      .get("bash")!
      .execute(
        "t",
        {
          command: "touch /usr/pi-transition-escape 2>/dev/null && echo escaped || echo blocked",
          timeout: 10,
        },
        undefined,
        undefined,
        ctx,
      )
      .then((result) => {
        order.push("bash");
        const [content] = result.content;
        return content?.type === "text" ? content.text : "";
      });
    const [, output] = await Promise.all([enabling, bash]);
    if (!notes.includes("Sandbox enabled")) {
      t.skip(`sandbox unavailable: ${notes.join("; ")}`);
      return;
    }
    assert.deepEqual(order, ["enabled", "bash"]);
    assert.match(output, /blocked/);
  },
);
