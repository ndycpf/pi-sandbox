import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

test(
  "offline Pi agent calls the reviewed bash tool through the registered schema",
  { timeout: 85000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-review-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const promptFile = join(root, "review.txt");
    await writeFile(promptFile, "Synthetic fixture.", { mode: 0o600 });
    const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
    const run = async (flags: string[], extension = "../index.ts") => {
      const processResult = promisify(execFile)(
        process.execPath,
        [
          path("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
          "--offline",
          "--mode",
          "json",
          "--no-session",
          "--no-extensions",
          "-e",
          path(extension),
          "-e",
          path("fixtures/review-provider.ts"),
          "--model",
          "fixture/agent",
          ...flags,
          "Fixture only",
        ],
        {
          cwd,
          timeout: 45000,
          env: {
            PATH: process.env.PATH,
            PI_CODING_AGENT_DIR: join(cwd, "agent"),
            PI_OFFLINE: "1",
            ...(extension === "fixtures/outer-workspace.ts" &&
            flags.includes("--sandbox-review-prompt")
              ? { PI_TEST_REPLACE_PROMPT: promptFile }
              : {}),
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      processResult.child.stdin?.end();
      const { stdout } = await processResult;
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const results = events.filter((e) => e.type === "tool_execution_end");
      assert.equal(results.length, 3);
      return Object.fromEntries<{ decision: string; reason?: string; executed: boolean }>(
        results.map((e) => [e.toolCallId, JSON.parse(e.result.content[0].text)]),
      );
    };
    const disabled = await run([]);
    assert.ok(
      Object.values(disabled).every((v) => v.decision === "would-deny" && !("output" in v)),
    );
    const noPrompt = await run(
      [
        "--sandbox-review-model",
        "fixture/reviewer",
        "--sandbox-review-workspace",
        "fixture-instance",
      ],
      "fixtures/outer-workspace.ts",
    );
    assert.match(noPrompt.allow.reason ?? "", /operator prompt/);
    assert.equal(existsSync(join(cwd, "dispatch-count")), false);
    const results = await run([
      "--sandbox-review-prompt",
      promptFile,
      "--sandbox-review-model",
      "fixture/reviewer",
      "--sandbox-review-workspace",
      "claimed",
    ]);
    for (const result of Object.values(results)) {
      assert.equal(result.executed, false);
      assert.match(result.reason ?? "", /No matching provisioner-bound outer workspace/);
    }
    const dispatched = await run(
      [
        "--sandbox-review-prompt",
        promptFile,
        "--sandbox-review-model",
        "fixture/reviewer",
        "--sandbox-review-workspace",
        "fixture-instance",
      ],
      "fixtures/outer-workspace.ts",
    );
    assert.deepEqual(dispatched.allow, {
      status: "completed",
      exitCode: 0,
      output: "fixture dispatch",
    });
    assert.equal(dispatched.deny.executed, false);
    assert.equal(dispatched.timeout.executed, false);
    assert.ok(existsSync(join(cwd, "dispatch-count")));
    assert.equal(existsSync(join(cwd, "sentinel")), false);
  },
);
