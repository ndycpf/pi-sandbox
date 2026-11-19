import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { previewCommandReview } from "./command-review.ts";
import { type OuterWorkspace, prepareBoundary, reviewAndRun } from "./review-boundary.ts";
import { loadReviewPrompt } from "./review-prompt.ts";

export function registerBashReview(pi: ExtensionAPI, workspace?: OuterWorkspace) {
  pi.registerFlag("sandbox-review-model", {
    type: "string",
    description: "Advisory reviewer provider/model",
  });
  pi.registerFlag("sandbox-review-workspace", {
    type: "string",
    description: "Expected identity of the pre-provisioned outer workspace",
  });
  pi.registerFlag("sandbox-review-prompt", {
    type: "string",
    description: "Absolute path to the operator-controlled local reviewer prompt",
  });
  let startupPrompt: string | null | undefined;
  type Input = {
    source: "interactive" | "rpc";
    text: string;
    session: string;
    lifetime: AbortController;
  };
  let pending: Input | undefined;
  let current: Input | undefined;
  const clear = () => {
    current?.lifetime.abort();
    pending?.lifetime.abort();
    pending = undefined;
    current = undefined;
  };
  pi.on("input", (event, ctx) => {
    clear();
    if (
      pi.getFlag("sandbox-review-model") &&
      event.source !== "extension" &&
      !event.images?.length &&
      !event.streamingBehavior &&
      Buffer.byteLength(event.text) <= 4096
    ) {
      pending = {
        lifetime: new AbortController(),
        source: event.source,
        text: event.text,
        session: ctx.sessionManager.getSessionId(),
      };
    }
  });
  pi.on("agent_start", () => {
    current?.lifetime.abort();
    current = undefined;
  });
  pi.on("message_start", ({ message }, ctx) => {
    if (message.role !== "user") return;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : content.length === 1 && content[0].type === "text"
          ? content[0].text
          : undefined;
    current?.lifetime.abort();
    current =
      pending && pending.session === ctx.sessionManager.getSessionId() && pending.text === text
        ? pending
        : undefined;
    pending = undefined;
  });
  pi.on("agent_end", clear);
  pi.on("session_start", (_event, ctx) => {
    clear();
    if (startupPrompt === undefined)
      startupPrompt = loadReviewPrompt(pi.getFlag("sandbox-review-prompt"), ctx.cwd);
  });
  pi.on("session_shutdown", clear);

  return async (
    command: string,
    reason: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    timeout?: number,
  ) => {
    const target = pi.getFlag("sandbox-review-model");
    const url = "local://guardian";
    const slash = typeof target === "string" ? target.indexOf("/") : -1;
    if (typeof target !== "string" || slash < 1)
      return {
        executed: false,
        decision: "would-deny",
        reason: "Review is off. No reviewer destination selected.",
      };
    const policy = startupPrompt;
    if (!policy)
      return {
        executed: false,
        decision: "would-deny",
        reason: "Missing or invalid operator prompt at startup.",
      };
    const model = ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1));
    if (!model || model.provider + "/" + model.id !== target || model.baseUrl !== url)
      return {
        executed: false,
        decision: "would-deny",
        reason: "Configured reviewer model or base URL unavailable.",
      };
    const input = current;
    const cwd = ctx.cwd;
    const stream = ctx.modelRegistry.getRegisteredProviderConfig(model.provider)?.streamSimple;
    if (!stream)
      return {
        executed: false,
        decision: "would-deny",
        reason: "A trusted in-process offline reviewer is required.",
      };
    if (!input || input.session !== ctx.sessionManager.getSessionId())
      return { executed: false, decision: "would-deny", reason: "Missing current user context." };
    const expected = pi.getFlag("sandbox-review-workspace");
    if (!workspace || typeof expected !== "string" || !expected || expected !== workspace.identity)
      return {
        executed: false,
        decision: "would-deny",
        reason: "No matching provisioner-bound outer workspace.",
      };
    const signals = [input.lifetime.signal];
    if (signal) signals.push(signal);
    if (ctx.signal) signals.push(ctx.signal);
    const cancel = AbortSignal.any(signals);
    const prepared = prepareBoundary(workspace, expected, command, cwd, timeout);
    const live = () =>
      current === input && ctx.cwd === cwd && input.session === ctx.sessionManager.getSessionId();
    return reviewAndRun(
      prepared,
      (action) =>
        previewCommandReview(
          policy,
          {
            command,
            cwd: action.cwd,
            complete: true,
            prepared: action,
            instruction: { role: "user", origin: input.source, text: input.text },
          },
          reason,
          async (policy, payload, abort) => {
            abort.throwIfAborted();
            if (current !== input || ctx.cwd !== cwd || model.baseUrl !== url)
              throw Error("Review scope changed");
            const response = await stream(
              model,
              {
                systemPrompt: policy,
                messages: [
                  { role: "user", content: JSON.stringify(payload), timestamp: Date.now() },
                ],
              },
              {
                signal: abort,
                maxTokens: 512,
                maxRetries: 0,
              },
            ).result();
            const visible = response.content.filter((part) => part.type !== "thinking");
            if (
              response.stopReason !== "stop" ||
              visible.length !== 1 ||
              visible[0].type !== "text"
            )
              return;
            return visible[0].text;
          },
          cancel,
        ),
      live,
      cancel,
    );
  };
}
