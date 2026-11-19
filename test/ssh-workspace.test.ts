import test from "node:test";

import assert from "node:assert/strict";

import { prepareBoundary } from "../src/review-boundary.ts";
import { sshWorkspace } from "../src/ssh-workspace.ts";

test("SSH adapter rejects invalid routing and cancellation before transport", async () => {
  const config = {
    host: "fixture.invalid",
    user: "pi_dev",
    knownHosts: "/fixture/known_hosts",
    identityFile: "/fixture/key",
    cwd: "/fixture",
    identity: "00000000-0000-0000-0000-000000000000:1:2",
  };
  for (const bad of [
    { host: "-F" },
    { port: 0 },
    { identity: "claimed" },
    { knownHosts: "relative" },
  ])
    assert.throws(() => sshWorkspace({ ...config, ...bad }));
  const workspace = sshWorkspace(config);
  const valid = prepareBoundary(workspace, config.identity, "printf fixture", config.cwd);
  await assert.rejects(workspace.execute(valid.action, AbortSignal.abort()));
  await assert.rejects(
    workspace.execute({ ...valid.action, cwd: "/different" }, new AbortController().signal),
    /changed/,
  );
});
