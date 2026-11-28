import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

type Fixture = {
  root: string;
  tools: Map<string, Tool>;
  commands: Map<string, Command>;
  notes: string[];
  ctx: ExtensionToolContext;
};

/** Start the extension with the sandbox off and `settings` in the global sandbox.json. */
async function startExtension(
  t: TestContext,
  settings: (root: string) => Record<string, unknown>,
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-transition-")));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR, "sandbox.json"),
    JSON.stringify({ enabled: false, ...settings(root) }),
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
  return { root, tools, commands, notes, ctx };
}

/** Turn the sandbox on and, before that finishes, run `command` with bash. */
async function bashDuringEnable(
  { tools, commands, ctx }: Fixture,
  command: string,
): Promise<{ order: string[]; output?: string; error?: string }> {
  const order: string[] = [];
  const enabling = commands
    .get("sandbox-enable")!
    .handler("", ctx)
    .then(() => order.push("enabled"));
  // Called before initialization finishes: it must not take the unsandboxed path.
  const bash = tools
    .get("bash")!
    .execute("t", { command, timeout: 10 }, undefined, undefined, ctx)
    .then(
      (result) => {
        order.push("bash");
        const [content] = result.content;
        return { output: content?.type === "text" ? content.text : "" };
      },
      (error: Error) => {
        order.push("bash");
        return { error: error.message };
      },
    );
  const [, result] = await Promise.all([enabling, bash]);
  return { order, ...result };
}

test(
  "bash called while the sandbox is being turned on waits and runs sandboxed",
  { skip: !supportsSandboxPlatform(), timeout: 20_000 },
  async (t) => {
    // allowAllUnixSockets avoids needing seccomp's nested user namespace,
    // which some CI containers lack.
    const fixture = await startExtension(t, (root) => ({
      network: { allowAllUnixSockets: true },
      filesystem: {
        denyRead: [],
        allowRead: [root],
        allowWrite: [root],
        denyWrite: [join(root, "protected")],
      },
    }));
    // A directory the host can write to, so only the sandbox can block it.
    const protectedDir = join(fixture.root, "protected");
    mkdirSync(protectedDir);
    writeFileSync(join(protectedDir, "host-check"), "");
    const target = join(protectedDir, "escape");
    const result = await bashDuringEnable(
      fixture,
      `touch ${target} 2>/dev/null && echo escaped || echo blocked`,
    );
    if (!fixture.notes.includes("Sandbox enabled")) {
      t.skip(`sandbox unavailable: ${fixture.notes.join("; ")}`);
      return;
    }
    assert.deepEqual(result.order, ["enabled", "bash"]);
    assert.match(result.output ?? "", /blocked/);
    assert.equal(existsSync(target), false);
  },
);

test(
  "bash called while the sandbox fails to turn on is refused and not run",
  { skip: !supportsSandboxPlatform(), timeout: 20_000 },
  async (t) => {
    // Mutually exclusive options make the sandbox runtime fail to initialize.
    const fixture = await startExtension(t, (root) => ({
      network: {
        allowAllUnixSockets: true,
        tlsTerminate: {},
        mitmProxy: { socketPath: join(root, "mitm.sock"), domains: ["example.com"] },
      },
      filesystem: { denyRead: [], allowRead: [root], allowWrite: [root], denyWrite: [] },
    }));
    const marker = join(fixture.root, "ran");
    const result = await bashDuringEnable(fixture, `touch ${marker}`);
    assert.ok(!fixture.notes.includes("Sandbox enabled"), fixture.notes.join("; "));
    // The refusal names the failed start, so the call waited for it.
    assert.match(
      result.error ?? "",
      /Command not run: the sandbox failed to start \(.*mutually exclusive/,
    );
    assert.equal(existsSync(marker), false);

    // Once the failed change is over, bash runs again (unsandboxed, as before).
    await fixture.tools
      .get("bash")!
      .execute("t", { command: `touch ${marker}`, timeout: 10 }, undefined, undefined, fixture.ctx);
    assert.equal(existsSync(marker), true);
  },
);
