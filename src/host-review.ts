import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";

import { completeSimple } from "@earendil-works/pi-ai/compat";

import { reviewInstructions, reviewRequest } from "./host-review-prompt.ts";
import {
  maxToolCalls,
  type ReviewExec,
  ReviewToolRunner,
  reviewTools,
} from "./host-review-tools.ts";

export type HostReviewConfig = {
  /** "human" prompts for every call; "auto" asks an LLM reviewer first. */
  mode: "human" | "auto";
  /** Reviewer model as "provider/model-id", resolved through Pi's model registry. */
  model?: string;
  /** Absolute path to extra operator policy text for the reviewer. */
  policyFile?: string;
  /** Limit for one review; on expiry the operator is prompted. */
  timeoutSeconds: number;
  /** The review log: JSON lines, rotated by size, with a fixed number of files kept. */
  log: ReviewLogConfig;
  /** Why an "auto" config was rejected; review then stays "human". */
  error?: string;
};

export type ReviewLogConfig = {
  enabled: boolean;
  /** Rotate the current file once it exceeds this size. */
  maxBytes: number;
  /** Files kept, counting the current one: log, log.1, ... log.(files-1). */
  files: number;
};

export const DEFAULT_REVIEW_LOG_CONFIG: ReviewLogConfig = {
  enabled: true,
  maxBytes: 1024 * 1024,
  files: 3,
};

export const DEFAULT_HOST_REVIEW_CONFIG: HostReviewConfig = {
  mode: "human",
  timeoutSeconds: 60,
  log: DEFAULT_REVIEW_LOG_CONFIG,
};

function inRange(value: unknown, min: number, max: number, fallback: number) {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fallback;
}

/** Validate `hostBash.review.log`; invalid values fall back to the defaults. */
export function resolveReviewLogConfig(value: unknown): ReviewLogConfig {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const defaults = DEFAULT_REVIEW_LOG_CONFIG;
  return {
    enabled: raw.enabled !== false,
    maxBytes: inRange(raw.maxBytes, 64 * 1024, 64 * 1024 * 1024, defaults.maxBytes),
    files: inRange(raw.files, 1, 20, defaults.files),
  };
}

/** Validate a global `hostBash.review` entry. Anything invalid means human review. */
export function resolveHostReviewConfig(value: unknown): HostReviewConfig {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const model =
    typeof raw.model === "string" && /^[^/\s]+\/\S+$/.test(raw.model) ? raw.model : undefined;
  const policyFile =
    typeof raw.policyFile === "string" ? raw.policyFile.replace(/^~(?=\/)/, homedir()) : undefined;
  const timeoutSeconds =
    Number.isInteger(raw.timeoutSeconds) &&
    (raw.timeoutSeconds as number) >= 5 &&
    (raw.timeoutSeconds as number) <= 180
      ? (raw.timeoutSeconds as number)
      : DEFAULT_HOST_REVIEW_CONFIG.timeoutSeconds;
  const log = resolveReviewLogConfig(raw.log);
  if (raw.mode !== "auto") return { mode: "human", timeoutSeconds, log };
  // An "auto" config the operator got wrong must not run with less than they
  // configured: it falls back to human review and says why.
  const error = !model
    ? 'hostBash.review.model must be "provider/model-id"'
    : raw.policyFile !== undefined && !(policyFile && isAbsolute(policyFile))
      ? "hostBash.review.policyFile must be an absolute path or start with ~/"
      : undefined;
  if (error) return { mode: "human", timeoutSeconds, log, error };
  return { mode: "auto", model, ...(policyFile && { policyFile }), timeoutSeconds, log };
}

/** The planned action JSON, in the shape Codex gives its reviewer for a command. */
export type PlannedAction = {
  tool: "host_bash";
  command: string[];
  cwd: string;
  sandbox_permissions: "require_escalated";
  /** Written by the agent; untrusted. */
  justification?: string;
  tty: false;
  env: { PATH: string; HOME?: string };
  timeout_seconds: number;
  output_to_agent: string;
};

export type Assessment = {
  outcome: "allow" | "deny";
  risk_level: "low" | "medium" | "high" | "critical";
  user_authorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
};

export type Verdict = {
  decision: "allow" | "deny" | "ask";
  risk?: Assessment["risk_level"];
  authorization?: Assessment["user_authorization"];
  reason: string;
  /** The reviewer's read and ls calls. */
  checks?: ReviewToolRunner["history"];
};

/**
 * Calls the reviewer model with a system prompt and one user message, letting
 * it use `tools` (read and ls) until it answers; returns its final text.
 */
export type Reviewer = (
  system: string,
  user: string,
  signal: AbortSignal,
  tools: ReviewToolRunner,
) => Promise<string>;

// Commands that always go to the operator, whatever the reviewer says. These
// patterns are a coarse speed bump, not a boundary: a determined agent can
// spell the same action another way. The reviewer is the main check.
const alwaysAsk: [RegExp, string][] = [
  [/(^|[^\w-])(sudo|doas|su|pkexec)(\s|$)/m, "privilege escalation"],
  [/(^|[^\w-])rm\s+(-\S*\s+)*-\S*[rRf]/m, "recursive or forced delete"],
  [/(^|[^\w-])(mkfs\S*|dd|diskutil|shred|wipefs)\s/m, "disk-level write"],
  [/\|\s*(ba|z|da|k)?sh\b/m, "piping into a shell"],
  [
    /\.ssh|\.gnupg|\.aws|\.netrc|\.kube|\.docker\/config|keychain|id_(rsa|ed25519|ecdsa)|security\s+find-|gh\s+auth\s+token/i,
    "credentials",
  ],
  [/(^|\s)(eval|exec)\s|base64\s+(-d|--decode)|\bxxd\s+-r/m, "obfuscated or indirect execution"],
];

/** A reason the command must be shown to the operator, or undefined. */
export function alwaysAskReason(command: string) {
  return alwaysAsk.find(([pattern]) => pattern.test(command))?.[1];
}

// Codex's synchronous transcript profile, with tokens approximated as 4 bytes.
const bytesPerToken = 4;
const messageEntryBytes = 5_000 * bytesPerToken;
const toolEntryBytes = 1_000 * bytesPerToken;
const messageBudgetBytes = 20_000 * bytesPerToken;
const toolBudgetBytes = 10_000 * bytesPerToken;
const maxRecentNonUserEntries = 40;
const omissionNotice = "Some conversation entries were omitted.";

/** Keep the head and tail of `text`, marking the omitted middle as Codex does. */
export function truncateText(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const omitted = Math.ceil((bytes.length - maxBytes) / bytesPerToken);
  const marker = `<truncated omitted_approx_tokens="${omitted}" />`;
  const available = Math.max(0, maxBytes - marker.length);
  const head = Math.floor(available / 2);
  const decoder = new TextDecoder("utf-8");
  // Dropping partial characters at the cut points is fine for evidence text.
  return (
    decoder.decode(bytes.subarray(0, head)).replace(/\uFFFD$/, "") +
    marker +
    decoder.decode(bytes.subarray(bytes.length - (available - head))).replace(/^\uFFFD/, "")
  );
}

type Entry = {
  author: "user" | "assistant" | "tool";
  kind: "message" | "tool";
  text: string;
  label?: string;
};

function textOf(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function entriesOf(branch: unknown[]): Entry[] {
  const entries: Entry[] = [];
  for (const raw of branch) {
    const entry = raw as { type?: string; message?: Record<string, unknown> };
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message) continue;
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text.trim()) entries.push({ author: "user", kind: "message", text });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      // Reasoning is left out, as in Codex's synchronous profile.
      for (const part of message.content as { type?: string; [key: string]: unknown }[]) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          entries.push({ author: "assistant", kind: "message", text: part.text });
        } else if (part?.type === "toolCall") {
          entries.push({
            author: "assistant",
            kind: "tool",
            label: "tool_call",
            text: JSON.stringify({ name: part.name, arguments: part.arguments }),
          });
        }
      }
    } else if (message.role === "toolResult") {
      entries.push({
        author: "tool",
        kind: "tool",
        label: `tool_result ${String(message.toolName)}${message.isError ? " (error)" : ""}`,
        text: textOf(message.content),
      });
    } else if (message.role === "bashExecution" && message.excludeFromContext !== true) {
      // `!!` commands are kept out of model requests, so out of reviews too.
      // The operator's own `!` command; its output is still untrusted.
      entries.push({
        author: "tool",
        kind: "tool",
        label: "operator_shell_command",
        text: `$ ${String(message.command)}\n${String(message.output ?? "")}`,
      });
    }
  }
  return entries;
}

/**
 * Transcript records for the reviewer, from the session branch. Like Codex,
 * user messages are kept first, then the most recent other entries, within
 * separate message and tool budgets; omitted entries leave a notice.
 */
export function transcriptRecords(branch: unknown[]): string[] {
  const entries = entriesOf(branch).map((entry) => ({
    ...entry,
    text: truncateText(entry.text, entry.kind === "message" ? messageEntryBytes : toolEntryBytes),
  }));
  const kept = new Set<number>();
  let messageBytes = 0;
  let toolBytes = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(entries[i]!.text);
    if (entries[i]!.author === "user" && messageBytes + size <= messageBudgetBytes) {
      kept.add(i);
      messageBytes += size;
    }
  }
  let recent = 0;
  for (let i = entries.length - 1; i >= 0 && recent < maxRecentNonUserEntries; i--) {
    const entry = entries[i]!;
    if (entry.author === "user") continue;
    const size = Buffer.byteLength(entry.text);
    if (
      entry.kind === "message"
        ? messageBytes + size > messageBudgetBytes
        : toolBytes + size > toolBudgetBytes
    )
      continue;
    kept.add(i);
    recent++;
    if (entry.kind === "message") messageBytes += size;
    else toolBytes += size;
  }
  const records = entries.flatMap((entry, i) =>
    kept.has(i)
      ? [
          JSON.stringify({
            author: entry.author,
            index: i + 1,
            ...(entry.label && { label: entry.label }),
            text: entry.text,
          }),
        ]
      : [],
  );
  if (kept.size < entries.length)
    records.unshift(JSON.stringify({ author: "host", text: omissionNotice }));
  return records;
}

export function reviewSystemPrompt(config: HostReviewConfig) {
  if (!config.policyFile) return reviewInstructions();
  const stat = statSync(config.policyFile);
  if (!stat.isFile() || stat.size > maxPolicyBytes) throw new Error("invalid policy file");
  return reviewInstructions(readFileSync(config.policyFile, "utf-8"));
}

const maxPolicyBytes = 32 * 1024;
const maxReasonChars = 600;
const risks = ["low", "medium", "high", "critical"];
const authorizations = ["unknown", "low", "medium", "high"];

/**
 * Parse the reviewer's answer like Codex: strict JSON, or the outermost
 * `{...}` inside surrounding prose; `outcome` is required and missing fields
 * get Codex's defaults. Anything else throws.
 */
export function parseAssessment(text: string): Assessment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("assessment was not valid JSON");
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("assessment is not an object");
  }
  const { outcome, risk_level, user_authorization, rationale } = parsed as Record<string, unknown>;
  if (outcome !== "allow" && outcome !== "deny") throw new Error("assessment has no valid outcome");
  if (risk_level !== undefined && !risks.includes(risk_level as string))
    throw new Error("assessment has an invalid risk_level");
  if (user_authorization !== undefined && !authorizations.includes(user_authorization as string))
    throw new Error("assessment has an invalid user_authorization");
  if (rationale !== undefined && typeof rationale !== "string")
    throw new Error("assessment has an invalid rationale");
  const why = rationale?.trim()
    ? rationale.trim()
    : outcome === "allow"
      ? "Auto-review returned a low-risk allow decision."
      : "Auto-review returned a deny decision without a rationale.";
  return {
    outcome,
    risk_level: (risk_level as Assessment["risk_level"]) ?? (outcome === "allow" ? "low" : "high"),
    user_authorization: (user_authorization as Assessment["user_authorization"]) ?? "unknown",
    rationale: why.length > maxReasonChars ? why.slice(0, maxReasonChars) + "…" : why,
  };
}

/**
 * Ask the reviewer about one planned action. Never throws unless `cancel`
 * fires: errors, timeouts and unparseable answers become "ask", so the
 * operator decides.
 */
export async function reviewCommand(
  reviewer: Reviewer,
  config: HostReviewConfig,
  action: PlannedAction,
  records: string[],
  exec: ReviewExec | undefined,
  cancel: AbortSignal,
): Promise<Verdict> {
  const forced = alwaysAskReason(action.command.at(-1) ?? "");
  if (forced) return { decision: "ask", reason: `Always needs the operator: ${forced}.` };
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("review aborted"));
    signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => {});
  const tools = new ReviewToolRunner(action.cwd, exec);
  const checks = () => (tools.history.length ? { checks: tools.history } : {});
  try {
    const system = reviewSystemPrompt(config);
    const text = await Promise.race([
      reviewer(system, reviewRequest(records, action), signal, tools),
      aborted,
    ]);
    signal.throwIfAborted();
    const assessment = parseAssessment(text);
    const verdict: Verdict = {
      decision: assessment.outcome,
      risk: assessment.risk_level,
      authorization: assessment.user_authorization,
      reason: assessment.rationale,
      ...checks(),
    };
    // Codex's thresholds, enforced here too: a high-risk allow needs at least
    // medium user authorization, and critical is never allowed. An allow that
    // breaks them goes to the operator.
    if (
      verdict.decision === "allow" &&
      (verdict.risk === "critical" ||
        (verdict.risk === "high" &&
          verdict.authorization !== "medium" &&
          verdict.authorization !== "high"))
    ) {
      return { ...verdict, decision: "ask" };
    }
    return verdict;
  } catch (error) {
    if (cancel.aborted) throw error;
    const why = signal.aborted
      ? `review timed out after ${config.timeoutSeconds}s`
      : `review failed (${error instanceof Error ? error.message : String(error)})`;
    return { decision: "ask", reason: `Auto-review unavailable: ${why}.`, ...checks() };
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

/** A reviewer backed by a model from Pi's registry, using Pi's own credentials. */
export function modelReviewer(ctx: ExtensionContext, target: string): Reviewer {
  return async (system, user, signal, tools) => {
    const slash = target.indexOf("/");
    const model = ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1));
    if (!model) throw new Error(`model ${target} not found`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() },
    ];
    // Each turn either answers or makes tool calls; past the budget every call
    // is refused, and a reviewer that still will not answer fails the review.
    for (let turn = 0; turn <= maxToolCalls + 1; turn++) {
      const response = await completeSimple(
        model,
        { systemPrompt: system, messages, tools: reviewTools },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal,
          maxTokens: 2048,
          maxRetries: 1,
        },
      );
      const calls = response.content.filter((part) => part.type === "toolCall");
      if (response.stopReason === "stop" && !calls.length) {
        return response.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
      if (response.stopReason !== "toolUse" || !calls.length)
        throw new Error(`model stopped: ${response.stopReason}`);
      messages.push(response);
      for (const call of calls) {
        signal.throwIfAborted();
        const result = await tools.run(call.name, call.arguments ?? {}, signal);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result.text }],
          isError: result.isError,
          timestamp: Date.now(),
        });
      }
    }
    throw new Error("reviewer did not answer within its tool budget");
  };
}

/**
 * Append one JSON line. When the file exceeds `maxBytes`, shift log -> log.1
 * -> ... and drop the oldest, so at most `files` files (about
 * `files * maxBytes`) are kept. Failures are ignored.
 */
export function appendReviewLog(
  path: string,
  entry: Record<string, unknown>,
  config: ReviewLogConfig = DEFAULT_REVIEW_LOG_CONFIG,
) {
  if (!config.enabled) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // No log yet.
    }
    if (size > config.maxBytes) {
      const name = (n: number) => (n ? `${path}.${n}` : path);
      rmSync(name(config.files - 1), { force: true });
      for (let n = config.files - 2; n >= 0; n--) {
        try {
          renameSync(name(n), name(n + 1));
        } catch {
          // A missing generation is fine.
        }
      }
      // With files: 1 the current file was removed above.
    }
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", {
      mode: 0o600,
    });
  } catch {
    // Logging must not block or fail a host command.
  }
}
