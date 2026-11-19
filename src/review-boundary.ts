import { isAbsolute } from "node:path";

// Supplied in memory by the deployment's trusted provisioner. The capability
// must run Bash in the same isolated environment as this Pi process, bound
// to one workspace incarnation and its independently enforced local policy.
export interface OuterWorkspace {
  readonly identity: string;
  execute(
    action: ReviewedAction,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; output: string }>;
}
export type ReviewedAction = Readonly<{
  command: readonly string[];
  cwd: string;
  boundary: Readonly<{ kind: "outer-workspace"; identity: string; timeoutSeconds: number }>;
}>;

export function prepareBoundary(
  workspace: OuterWorkspace,
  expected: string,
  command: string,
  cwd: string,
  timeout = 60,
) {
  if (
    !expected ||
    workspace.identity !== expected ||
    !isAbsolute(cwd) ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 60
  )
    throw Error("Invalid outer workspace, working directory or execution timeout.");
  const execute = workspace.execute.bind(workspace);
  const action: ReviewedAction = Object.freeze({
    command: Object.freeze(["/bin/bash", "--noprofile", "--norc", "-c", command]),
    cwd,
    boundary: Object.freeze({
      kind: "outer-workspace",
      identity: expected,
      timeoutSeconds: timeout,
    }),
  });
  let consumed = false;
  return {
    action,
    run: async (cancel: AbortSignal) => {
      if (consumed) throw Error("Invocation already consumed.");
      consumed = true;
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(timeout * 1000)]);
      signal.throwIfAborted();
      if (workspace.identity !== expected) throw Error("Outer workspace changed.");
      const result = await execute(action, signal);
      signal.throwIfAborted();
      return result;
    },
  };
}

export async function reviewAndRun(
  prepared: {
    action: ReviewedAction;
    run: (signal: AbortSignal) => Promise<{ exitCode: number; output: string }>;
  },
  review: (action: ReviewedAction) => Promise<{ decision: string; reason: string }>,
  current: () => boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!current()) throw Error("Review scope changed.");
  const verdict = await review(prepared.action);
  signal.throwIfAborted();
  if (!current()) throw Error("Review scope changed.");
  if (verdict.decision !== "would-allow") return { executed: false, ...verdict };
  const result = await prepared.run(signal);
  signal.throwIfAborted();
  return { status: result.exitCode === 0 ? "completed" : "launcher-or-command-failed", ...result };
}
