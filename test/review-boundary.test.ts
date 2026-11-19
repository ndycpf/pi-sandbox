import test from "node:test";

import assert from "node:assert/strict";

import { prepareBoundary, reviewAndRun, type ReviewedAction } from "../src/review-boundary.ts";

const action: ReviewedAction = Object.freeze({
  command: Object.freeze(["/bin/bash", "--noprofile", "--norc", "-c", "printf ok"]),
  cwd: "/work",
  boundary: Object.freeze({
    kind: "outer-workspace",
    identity: "example-1",
    timeoutSeconds: 5,
  }),
});
test("same call commits a single launch only after allow", async () => {
  for (const scenario of ["allow", "deny", "error", "cancel", "changed"]) {
    const cancel = new AbortController();
    let launches = 0;
    let current = true;
    const result = reviewAndRun(
      {
        action,
        run: async () => {
          launches++;
          return { exitCode: 0, output: "ok" };
        },
      },
      async (seen) => {
        assert.equal(seen, action);
        if (scenario === "error") throw Error("fixture");
        if (scenario === "cancel") cancel.abort();
        if (scenario === "changed") current = false;
        return { decision: scenario === "deny" ? "would-deny" : "would-allow", reason: "fixture" };
      },
      () => current,
      cancel.signal,
    );
    if (scenario === "allow")
      assert.deepEqual(await result, { status: "completed", exitCode: 0, output: "ok" });
    else if (scenario === "deny")
      assert.deepEqual(await result, {
        executed: false,
        decision: "would-deny",
        reason: "fixture",
      });
    else await assert.rejects(result);
    assert.equal(launches, scenario === "allow" ? 1 : 0);
  }
});
test("dispatch binds the exact reviewed argv and rejects replacement of the workspace", async () => {
  let calls = 0;
  const workspace = {
    identity: "example-1",
    execute: async (seen: ReviewedAction) => {
      calls++;
      assert.equal(seen, prepared.action);
      return { exitCode: 0, output: "fixture" };
    },
  };
  const prepared = prepareBoundary(workspace, "example-1", "printf ok", "/work", 5);
  assert.deepEqual(prepared.action, action);
  const signal = new AbortController().signal;
  await reviewAndRun(
    prepared,
    async () => ({ decision: "would-allow", reason: "fixture" }),
    () => true,
    signal,
  );
  await assert.rejects(prepared.run(signal), /already consumed/);
  const second = prepareBoundary(workspace, "example-1", "printf ok", "/work", 5);
  workspace.identity = "replaced";
  await assert.rejects(
    reviewAndRun(
      second,
      async () => ({ decision: "would-allow", reason: "fixture" }),
      () => true,
      signal,
    ),
  );
  assert.equal(calls, 1);
});
