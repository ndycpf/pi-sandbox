import test from "node:test";

import assert from "node:assert/strict";

import { previewCommandReview } from "../src/command-review.ts";

const snapshot = {
  command: "  printf 'fixture'\n",
  cwd: "/fixture space",
  complete: true,
  instruction: { origin: "interactive", role: "user", text: "Print fixture." },
} as const;

test("reviewer receives the exact action, a fixed policy and separate evidence", async () => {
  const justification = "Agent claims additional authority.";
  let received: unknown;
  const result = await previewCommandReview(
    "Synthetic fixture.",
    snapshot,
    justification,
    async (policy, input) => {
      received = input;
      assert.ok(!policy.includes(justification));
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.action));
      return JSON.stringify({ outcome: "allow", rationale: "Fixture." });
    },
  );
  assert.deepEqual(received, {
    action: {
      tool: "bash",
      command: ["/bin/bash", "--noprofile", "--norc", "-c", snapshot.command],
      cwd: snapshot.cwd,
      tty: false,
      sandbox_permissions: "require_escalated",
      justification,
    },
    transcript: snapshot.instruction,
  });
  assert.deepEqual(result, {
    decision: "would-allow",
    reason: "Fixture.",
    risk_level: "low",
    user_authorization: "unknown",
  });
});

test("incomplete action or missing, unverified or oversized evidence never reaches reviewer", async () => {
  let calls = 0;
  for (const candidate of [
    undefined,
    { ...snapshot, command: "" },
    { ...snapshot, complete: false },
    { ...snapshot, command: "a".repeat(8193) },
    { ...snapshot, cwd: "." },
    { ...snapshot, instruction: undefined },
    { ...snapshot, instruction: { ...snapshot.instruction, origin: "transcript" } },
    { ...snapshot, instruction: { ...snapshot.instruction, role: "assistant" } },
    { ...snapshot, instruction: { ...snapshot.instruction, text: "字".repeat(1400) } },
  ]) {
    assert.equal(
      (
        await previewCommandReview(
          "Synthetic fixture.",
          candidate as typeof snapshot,
          "fixture",
          async () => {
            calls++;
            return JSON.stringify({ outcome: "allow", rationale: "Fixture." });
          },
        )
      ).decision,
      "would-deny",
    );
  }
  assert.equal(calls, 0);
});

test("negative, malformed, failed, timed-out and cancelled reviews deny", async (t) => {
  for (const verdict of [
    "DENY",
    "ALLOW\n",
    { decision: "ALLOW" },
    true,
    undefined,
    '{"outcome":"allow","user_authorization":"high"}',
    '{"outcome":"allow","extra":true}',
  ]) {
    assert.equal(
      (await previewCommandReview("Synthetic fixture.", snapshot, "fixture", async () => verdict))
        .decision,
      "would-deny",
    );
  }
  assert.equal(
    (
      await previewCommandReview("Synthetic fixture.", snapshot, "fixture", async () => {
        throw Error("fixture");
      })
    ).decision,
    "would-deny",
  );
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  const cancel = new AbortController();
  const wait = () => new Promise(() => {});
  const first = previewCommandReview(
    "Synthetic fixture.",
    snapshot,
    "fixture",
    wait,
    cancel.signal,
  );
  const second = previewCommandReview("Synthetic fixture.", snapshot, "fixture", wait);
  cancel.abort();
  assert.equal((await first).decision, "would-deny");
  timeout.abort();
  assert.equal((await second).decision, "would-deny");
});

test("public compact verdict and explicit denial", async () => {
  for (const [outcome, decision] of [
    ["allow", "would-allow"],
    ["deny", "would-deny"],
  ]) {
    assert.equal(
      (
        await previewCommandReview("Synthetic fixture.", snapshot, "fixture", async () =>
          JSON.stringify({ outcome }),
        )
      ).decision,
      decision,
    );
  }
});
