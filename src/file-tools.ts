import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SandboxConfig } from "./config.ts";

import { bundledOperations } from "./bundled-file-operations.ts";
import { assertMutable, mutationTarget } from "./human-managed.ts";
import { canonicalizePath, canWrite, matchesPattern } from "./policy.ts";
import { type SessionAllowances, resolveAllowances } from "./sandbox-runtime.ts";

const markerName = "sandbox_file_provider";
const protocol = Symbol.for("pi-sandbox.file-provider.v1");
type Kind = "read" | "write" | "edit";
export interface FileRequest {
  kind: Kind;
  input: Readonly<Record<string, unknown>>;
  id: string;
  ctx: ExtensionContext;
  signal: AbortSignal;
  mutationPath?: string;
}
type Prepare = (
  request: FileRequest,
) => Promise<
  | { decision: "allow"; target?: string; execute: () => Promise<AgentToolResult<unknown>> }
  | { decision: "deny" }
>;

// Each extension owns its lifetime; reload and session changes invalidate pending operations.
function fileSession() {
  let active:
    | { manager: ExtensionContext["sessionManager"]; id: string; lifetime: AbortController }
    | undefined;
  function stop() {
    active?.lifetime.abort();
    active = undefined;
  }
  return {
    stop,
    start(ctx: ExtensionContext) {
      stop();
      const id = ctx.sessionManager?.getSessionId();
      if (id) active = { manager: ctx.sessionManager, id, lifetime: new AbortController() };
    },
    signal(ctx: ExtensionContext, abort?: AbortSignal) {
      if (
        !active ||
        active.manager !== ctx.sessionManager ||
        active.id !== ctx.sessionManager.getSessionId()
      )
        throw new Error("Sandbox: file tool session unavailable.");
      const lifetime = active.lifetime.signal;
      return abort ? AbortSignal.any([lifetime, abort]) : lifetime;
    },
  };
}

// Register from the trusted extension. Pi 0.80 exposes the winning tool's
// original schema and loader-assigned source metadata through getAllTools().
export function registerFilePermissionProvider(pi: ExtensionAPI, prepare: Prepare) {
  const session = fileSession();
  pi.on("session_start", (_event, ctx) => session.start(ctx));
  pi.on("session_shutdown", session.stop);
  const parameters = Type.Object({});
  Object.defineProperty(parameters, protocol, {
    value: async (request: FileRequest) => {
      const signal = session.signal(request.ctx, request.signal);
      signal.throwIfAborted();
      const plan = await prepare({ ...request, signal });
      signal.throwIfAborted();
      if (plan?.decision !== "allow" || typeof plan.execute !== "function")
        return { decision: "deny" };
      return {
        decision: "allow",
        target: plan.target,
        execute: () => {
          signal.throwIfAborted();
          return plan.execute();
        },
      };
    },
  });
  pi.registerTool({
    name: markerName,
    label: "File permission provider",
    description: "Identify the installed file permission protocol.",
    parameters,
    async execute() {
      return {
        content: [{ type: "text", text: "pi-sandbox file permission protocol v1" }],
        details: undefined,
      };
    },
  });
}

function validResult(result: AgentToolResult<unknown> | undefined) {
  return (
    result &&
    !("isError" in result && result.isError !== false) &&
    Array.isArray(result.content) &&
    Array.from(result.content).every(
      (part) =>
        part &&
        ((part.type === "text" && typeof part.text === "string") ||
          (part.type === "image" &&
            typeof part.data === "string" &&
            typeof part.mimeType === "string")),
    )
  );
}

export function registerFileTools(
  pi: ExtensionAPI,
  required: () => boolean,
  ready: () => boolean,
  allowances: SessionAllowances,
  policy: () => SandboxConfig,
  managed: () => readonly string[],
  ownerPath = fileURLToPath(new URL("../index.ts", import.meta.url)),
) {
  const schemas = new Map<string, object>();
  const session = fileSession();
  function checkAdapter(name: string, tools: ReturnType<ExtensionAPI["getAllTools"]>) {
    const adapter = tools.find((t) => t.name === name);
    if (
      !adapter ||
      adapter.parameters !== schemas.get(name) ||
      realpathSync(adapter.sourceInfo.path) !== realpathSync(ownerPath)
    )
      throw new Error("Sandbox: guarded file adapter unavailable.");
  }
  function lookup(ctx: ExtensionContext, name: string) {
    session.signal(ctx);
    if (!ready()) throw new Error("Sandbox: file protection unavailable.");
    const path = policy().filePermissionProvider;
    const tools = pi.getAllTools();
    checkAdapter(name, tools);
    if (path === undefined) return undefined;
    const provider = tools.find((t) => t.name === markerName);
    if (!provider || provider.sourceInfo.scope !== "user" || provider.sourceInfo.path !== path)
      throw new Error("Sandbox: trusted file permission provider unavailable.");
    const prepare = Reflect.get(provider.parameters, protocol) as Prepare | undefined;
    if (typeof prepare !== "function")
      throw new Error("Sandbox: incompatible file permission provider.");
    return prepare;
  }
  async function delegated(
    prepare: Prepare,
    kind: Kind,
    input: Record<string, unknown>,
    id: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
    mutationPath?: string,
  ) {
    signal.throwIfAborted();
    const plan = await prepare({
      kind,
      input: structuredClone(input),
      id,
      ctx,
      signal,
      mutationPath,
    });
    signal.throwIfAborted();
    if (
      !required() ||
      lookup(ctx, kind) !== prepare ||
      plan?.decision !== "allow" ||
      typeof plan.execute !== "function"
    )
      throw new Error("Sandbox: file operation refused.");
    if (mutationPath) {
      if (
        typeof plan.target !== "string" ||
        !isAbsolute(plan.target) ||
        canonicalizePath(plan.target) !== canonicalizePath(mutationPath)
      )
        throw new Error("Sandbox: provider must bind the authorized mutation target.");
      assertMutable(mutationPath, managed());
      assertMutable(plan.target, managed());
    }
    const result = await plan.execute();
    signal.throwIfAborted();
    if (!required() || lookup(ctx, kind) !== prepare)
      throw new Error("Sandbox: file provider changed.");
    if (!validResult(result)) throw new Error("Sandbox: invalid file permission provider result.");
    return { content: result.content, details: result.details };
  }
  for (const [kind, factory] of [
    ["read", createReadToolDefinition],
    ["write", createWriteToolDefinition],
    ["edit", createEditToolDefinition],
  ] as const) {
    const tool = factory(process.cwd());
    const parameters = { ...tool.parameters };
    schemas.set(kind, parameters);
    pi.registerTool({
      name: kind,
      label: tool.label,
      description: tool.description,
      parameters,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      async execute(id, args, signal, update, ctx) {
        const lifetime = session.signal(ctx, signal);
        const mutationPath =
          kind === "read" ? undefined : mutationTarget(args.path, ctx.cwd, managed());
        let operations;
        if (required()) {
          const prepare = lookup(ctx, kind);
          signal = lifetime;
          if (prepare) return delegated(prepare, kind, args, id, ctx, signal, mutationPath);
          operations = bundledOperations(
            kind,
            (path) => {
              if (!required() || lookup(ctx, kind) !== undefined)
                throw new Error("Sandbox: file provider changed.");
              if (kind !== "read") assertMutable(path, managed());
              const config = policy();
              const effective = resolveAllowances(config, allowances);
              const allowed =
                kind === "read"
                  ? matchesPattern(path, effective.readPaths, ctx.cwd)
                  : canWrite(
                      path,
                      effective.writePaths,
                      config.filesystem?.denyWrite ?? [],
                      ctx.cwd,
                    );
              if (!allowed) throw new Error("Sandbox: file policy denied this operation.");
            },
            signal,
          );
        }
        // The union of tool schemas is narrowed by the registered name.
        if (kind === "read" && "path" in args)
          return createReadToolDefinition(ctx.cwd, {
            operations,
            autoResizeImages: SettingsManager.create(ctx.cwd, undefined, {
              projectTrusted: ctx.isProjectTrusted(),
            }).getImageAutoResize(),
          }).execute(id, args, signal, update, ctx);
        if (kind === "write" && "content" in args)
          return createWriteToolDefinition(ctx.cwd, { operations }).execute(
            id,
            args,
            signal,
            update,
            ctx,
          );
        if (kind === "edit" && "edits" in args)
          return createEditToolDefinition(ctx.cwd, { operations }).execute(
            id,
            args,
            signal,
            update,
            ctx,
          );
        throw new Error("Invalid file tool input.");
      },
      ...(kind === "edit"
        ? { prepareArguments: createEditToolDefinition(process.cwd()).prepareArguments }
        : {}),
    });
  }
  return {
    start: session.start,
    stop: session.stop,
    block(name: string, ctx: ExtensionContext, path?: unknown) {
      if (!schemas.has(name)) return;
      try {
        session.signal(ctx);
        if (name !== "read") {
          mutationTarget(path, ctx.cwd, managed());
          if (!required()) checkAdapter(name, pi.getAllTools());
        }
        if (required()) lookup(ctx, name);
      } catch {
        return { block: true, reason: "Sandbox: trusted file protection unavailable." };
      }
    },
  };
}
