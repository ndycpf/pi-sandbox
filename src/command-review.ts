import { isAbsolute } from "node:path";

import type { ReviewedAction } from "./review-boundary.ts";

// Only a trusted host adapter may construct this snapshot. It must identify the
// current turn and obtain the action before any rendering, clipping or launch.
type ReviewSnapshot = {
  command: string;
  complete: boolean;
  prepared?: ReviewedAction;
  cwd: string;
  instruction: { origin: "interactive" | "rpc"; role: "user"; text: string };
};

type ReviewInput = Readonly<{
  action: Readonly<{
    tool: "bash";
    command: readonly string[];
    cwd: string;
    boundary?: ReviewedAction["boundary"];
    tty: false;
    sandbox_permissions: "require_escalated";
    justification: string;
  }>;
  transcript: Readonly<ReviewSnapshot["instruction"]>;
}>;

type Reviewer = (policy: string, input: ReviewInput, signal: AbortSignal) => Promise<unknown>;

function bounded(text: unknown, bytes: number): text is string {
  return (
    typeof text === "string" &&
    text.length <= bytes &&
    Boolean(text.trim()) &&
    !text.includes("\0") &&
    Buffer.byteLength(text) <= bytes
  );
}

export async function previewCommandReview(
  policy: string,
  snapshot: ReviewSnapshot | undefined,
  justification: string,
  reviewer: Reviewer,
  cancel?: AbortSignal,
): Promise<{
  decision: "would-allow" | "would-deny";
  reason: string;
  risk_level?: string;
  user_authorization?: "unknown";
}> {
  if (!snapshot || snapshot.complete !== true || cancel?.aborted)
    return { decision: "would-deny", reason: "Missing, invalid or cancelled review input." };
  const { command, cwd, instruction } = snapshot;
  if (
    !bounded(command, 8192) ||
    !bounded(cwd, 4096) ||
    !isAbsolute(cwd) ||
    (instruction?.origin !== "interactive" && instruction?.origin !== "rpc") ||
    instruction.role !== "user" ||
    !bounded(instruction.text, 4096) ||
    !bounded(justification, 1024)
  )
    return { decision: "would-deny", reason: "Missing, invalid or cancelled review input." };

  const input = Object.freeze({
    action: Object.freeze({
      tool: "bash" as const,
      command:
        snapshot.prepared?.command ??
        Object.freeze(["/bin/bash", "--noprofile", "--norc", "-c", command]),
      ...(snapshot.prepared && { boundary: snapshot.prepared.boundary }),
      cwd,
      tty: false as const,
      sandbox_permissions: "require_escalated" as const,
      justification,
    }),
    transcript: Object.freeze({
      role: instruction.role,
      origin: instruction.origin,
      text: instruction.text,
    }),
  });
  const deadline = performance.now() + 30_000;
  const timeout = AbortSignal.timeout(30_000);
  const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
  const aborted = Promise.withResolvers<void>();
  const onAbort = () => aborted.resolve();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const verdict = await Promise.race([aborted.promise, reviewer(policy, input, signal)]);
    if (signal.aborted || performance.now() >= deadline)
      return { decision: "would-deny", reason: "Review timed out or cancelled." };
    const result =
      typeof verdict === "string" && verdict.length <= 4096 ? JSON.parse(verdict) : null;
    if (
      result &&
      Object.keys(result).every((key) =>
        ["outcome", "risk_level", "user_authorization", "rationale"].includes(key),
      ) &&
      ["allow", "deny"].includes(result.outcome) &&
      (result.risk_level === undefined ||
        ["low", "medium", "high", "critical"].includes(result.risk_level)) &&
      (result.user_authorization === undefined || result.user_authorization === "unknown") &&
      (result.rationale === undefined || bounded(result.rationale, 1024))
    ) {
      return {
        decision: result.outcome === "allow" ? "would-allow" : "would-deny",
        risk_level: result.risk_level ?? (result.outcome === "allow" ? "low" : "high"),
        user_authorization: "unknown",
        reason:
          result.rationale ??
          (result.outcome === "allow" ? "Low-risk allow." : "Guardian denied the request."),
      };
    }
    return { decision: "would-deny", reason: "Invalid reviewer response." };
  } catch {
    return { decision: "would-deny", reason: "Provider error or invalid response." };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
