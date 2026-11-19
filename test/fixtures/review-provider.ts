import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { writeFileSync } from "node:fs";

// In-process provider for the offline Pi CLI integration test.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fixture", {
    api: "fixture",
    apiKey: "unused-fixture",
    baseUrl: "local://guardian",
    models: ["agent", "reviewer"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const msg = {
        role: "assistant" as const,
        model: model.id,
        api: model.api,
        provider: model.provider,
        timestamp: Date.now(),
        stopReason: "stop" as const,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (model.id === "agent" && !context.messages.some((m) => m.role === "toolResult")) {
        if (process.env.PI_TEST_REPLACE_PROMPT)
          writeFileSync(process.env.PI_TEST_REPLACE_PROMPT, "Changed synthetic fixture.");
        const content = ["allow", "deny", "timeout"].map((id) => ({
          type: "toolCall" as const,
          id,
          name: "bash",
          arguments: {
            command: "printf fixture > sentinel",
            sandbox_permissions: "require_escalated",
            justification: id,
          },
        }));
        stream.push({
          type: "done",
          reason: "toolUse",
          message: { ...msg, stopReason: "toolUse", content },
        });
      } else {
        let text = "done";
        if (model.id === "reviewer") {
          const m = context.messages[0];
          if (
            context.tools?.length ||
            context.messages.length !== 1 ||
            m.role !== "user" ||
            typeof m.content !== "string"
          )
            throw Error("Unexpected review envelope");
          const input = JSON.parse(m.content);
          if (
            JSON.stringify(input.transcript) !==
              JSON.stringify({ role: "user", origin: "interactive", text: "Fixture only" }) ||
            JSON.stringify(input.action.command) !==
              JSON.stringify([
                "/bin/bash",
                "--noprofile",
                "--norc",
                "-c",
                "printf fixture > sentinel",
              ]) ||
            context.systemPrompt !== "Synthetic fixture." ||
            input.action.cwd !== process.cwd()
          )
            throw Error("Unexpected review fields");
          if (input.action.justification === "timeout") {
            const timer = setTimeout(() => stream.end(), 40_000);
            options?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                stream.end();
              },
              { once: true },
            );
            return stream;
          }
          text = JSON.stringify({
            outcome: input.action.justification === "deny" ? "deny" : "allow",
            rationale: "Fixture verdict",
          });
        }
        stream.push({
          type: "done",
          reason: "stop",
          message: { ...msg, content: [{ type: "text", text }] },
        });
      }
      stream.end();
      return stream;
    },
  });
}
