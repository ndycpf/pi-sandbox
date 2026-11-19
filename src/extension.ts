import { dirname, resolve } from "node:path";

import { createSandboxManager } from "@carderne/sandbox-runtime";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  addGrantToConfig,
  grantKeys,
  type GrantKind,
  getConfigPaths,
  sessionPolicy,
  configRevision,
  type SandboxConfig,
} from "./config.ts";
import { ExecutionHistory } from "./execution-history.ts";
import { registerFileTools } from "./file-tools.ts";
import {
  assertMutable,
  mutationTarget,
  configuredSkillRoots,
  managedRoots,
  managedShellDenies,
} from "./human-managed.ts";
import { canonicalizePath, domainIsAllowed, matchesPattern } from "./policy.ts";
import {
  createSandboxedBashOps,
  initializeSandbox,
  updateSandboxConfig,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
  supportsSandboxPlatform,
  clearSessionAllowances,
} from "./sandbox-runtime.ts";
import {
  cancelPermissionPrompts,
  resetPermissionPrompts,
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionPromptResult,
  showPermissionPrompt,
  warnIfAllDomainsAllowed,
  warnIfLinuxUnenforcedGlobs,
} from "./ui.ts";
import { registerUnsandboxBash } from "./unsandbox-bash.ts";

export default function (pi: ExtensionAPI) {
  const sandboxManager = createSandboxManager();
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  // localBash supplies the tool metadata (name, description, params) via the spread
  // below. Its execute method is always overridden, and each invocation rebuilds the
  // bash tool against the session cwd, so this cwd is never used to run commands.
  const localBash = createBashToolDefinition(process.cwd());

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let snapshot: SandboxConfig | undefined;
  let roots: string[] = [];
  let revisions = new Map<string, string | undefined>();
  let shellPath: string | undefined, shellPrefix: string | undefined;
  let anchors = new Map<string, string>();
  let sessionCwd = "";
  function rememberPaths(paths: string[]) {
    for (const path of paths)
      if (!path.includes("*") && !anchors.has(path))
        anchors.set(path, canonicalizePath(path, sessionCwd));
  }
  function policy() {
    if (!snapshot) throw new Error("Sandbox policy unavailable.");
    for (const [path, original] of anchors)
      if (canonicalizePath(path, sessionCwd) !== original)
        throw new Error("A configured filesystem path changed its target; review it manually.");
    return snapshot;
  }
  function shellPolicy(cwd: string) {
    const config = policy();
    const writes = resolveAllowances(config, allowances).writePaths;
    return {
      ...config,
      filesystem: {
        ...config.filesystem,
        denyRead: config.filesystem?.denyRead ?? [],
        allowWrite: config.filesystem?.allowWrite ?? [],
        disabled: false,
        denyWrite: [
          ...(config.filesystem?.denyWrite ?? []),
          ...managedShellDenies(roots, writes, cwd),
        ],
      },
    };
  }
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

  let sandboxRequired = true;
  let sessionHistory = new ExecutionHistory();
  let projectOnlyDisable = false;
  const sandboxReady = () => sandboxEnabled && sandboxInitialized;
  const hostBash = registerUnsandboxBash(pi, () => sessionHistory, sandboxReady);
  const fileAdapters = registerFileTools(
    pi,
    () => sandboxRequired || projectOnlyDisable,
    sandboxReady,
    allowances,
    policy,
    () => roots,
  );

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      updateSandboxConfig(sandboxManager, shellPolicy(cwd), allowances, cwd);
    } catch (error) {
      console.error(`Warning: Failed to update sandbox configuration: ${error}`);
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: GrantKind,
    value: string,
    cwd: string,
  ): Promise<void> {
    if (kind === "write") mutationTarget(value, cwd, roots);
    policy();
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    if (
      choice !== "session" &&
      (!revisions.has(target) || configRevision(target) !== revisions.get(target))
    )
      throw new Error("Configuration changed; review it manually before saving a grant.");
    const grants =
      allowances[kind === "domain" ? "domains" : kind === "read" ? "readPaths" : "writePaths"];
    if (!grants.includes(value)) grants.push(value);
    try {
      if (choice !== "session") {
        addGrantToConfig(target, kind, value);
        revisions.set(target, configRevision(target));
      }
    } catch (error) {
      // The grant still applies for this session (allowances updated above);
      // only persistence failed. Surface it instead of wiping the config.
      console.error(`Warning: ${error instanceof Error ? error.message : error}`);
    }
    if (kind !== "domain") rememberPaths([value]);
    await refreshSandbox(cwd);
  }

  function updateStatus(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0], config: SandboxConfig) {
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }

    sandboxRequired = true;
    projectOnlyDisable = false;
    hostBash.start(ctx);
    fileAdapters.start(ctx);
    const config = policy();
    const platform = process.platform;
    if (!supportsSandboxPlatform(platform)) {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      await initializeSandbox(sandboxManager, shellPolicy(ctx.cwd), allowances, ctx.cwd);
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      resetPermissionPrompts(pi);
      sandboxEnabled = true;
      sandboxInitialized = true;
      warnIfAllDomainsAllowed(ctx, config);
      warnIfLinuxUnenforcedGlobs(ctx, config);
      updateStatus(ctx, config);
      return true;
    } catch (error) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  async function disableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
  ): Promise<boolean> {
    if (!sandboxEnabled && !sandboxRequired && !projectOnlyDisable) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    hostBash.start(ctx);
    fileAdapters.start(ctx);
    projectOnlyDisable = false;
    sandboxEnabled = false;
    sandboxRequired = true;
    cancelPermissionPrompts(pi);
    if (sandboxInitialized) {
      try {
        await sandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxRequired = false;
    sandboxInitialized = false;
    clearSessionAllowances(allowances);
    ctx.ui.setStatus("sandbox", "");
    return true;
  }

  async function toggleSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  async function requestAccess({
    kind,
    target,
    ctx,
    reason,
    signal,
  }: {
    kind: GrantKind;
    target: string;
    ctx: Parameters<typeof showPermissionPrompt>[1];
    reason?: string;
    signal?: AbortSignal;
  }) {
    if (kind === "write") assertMutable(target, roots);
    const config = policy();
    const title = `Add ${target} to ${grantKeys[kind]}?`;
    const generation = snapshot;
    const choice = await showPermissionPrompt(
      pi,
      ctx,
      reason ? `${title}\nReason: ${reason}` : title,
      target,
      (value) => {
        if (!value) return "Rule cannot be empty.";
        const matches =
          kind === "domain"
            ? domainIsAllowed(target, [value])
            : matchesPattern(target, [value], ctx.cwd);
        return matches ? null : `Rule must match "${target}".`;
      },
      config.permissionPromptTimeoutSeconds,
    );
    if (signal?.aborted || snapshot !== generation) throw new Error("Access request cancelled.");
    if (choice.action !== "abort") {
      await applyChoice(choice.action, kind, choice.value, ctx.cwd);
    }
    return choice;
  }

  function registerAccessTools() {
    pi.registerTool({
      name: "sandbox_status",
      label: "Sandbox status",
      description:
        "Inspect sandbox enabled state, effective allow and deny rules, and session-only grants. " +
        "Relative filesystem rules are resolved against cwd. Write access also grants read access; " +
        "denyWrite and deniedDomains override allows, while allowRead overrides denyRead.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const config = policy();
        const effective = resolveAllowances(config, allowances);
        const status = {
          enabled: sandboxEnabled,
          cwd: ctx.cwd,
          network: {
            disabled: config.network?.disabled ?? false,
            allowedDomains: effective.domains,
            deniedDomains: config.network?.deniedDomains ?? [],
          },
          filesystem: {
            disabled: config.filesystem?.disabled ?? false,
            allowRead: effective.readPaths,
            allowWrite: effective.writePaths,
            denyRead: config.filesystem?.denyRead ?? [],
            denyWrite: config.filesystem?.denyWrite ?? [],
          },
          sessionGrants: {
            domains: [...allowances.domains],
            readPaths: [...allowances.readPaths],
            writePaths: [...allowances.writePaths],
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          details: status,
        };
      },
    });
    pi.registerTool({
      name: "sandbox_request_access",
      label: "Request sandbox access",
      description:
        "Request user approval for sandboxed shell access to a path or network domain. " +
        "Use sandbox_status to inspect current permissions. Already-allowed access does not prompt.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("domain")]),
        target: Type.String({ minLength: 1, description: "Filesystem path or domain hostname" }),
        reason: Type.String({ minLength: 1, description: "Why this access is needed" }),
      }),
      async execute(_id, { kind, target: input, reason }, signal, _onUpdate, ctx) {
        if (!input.trim() || !reason.trim())
          throw new Error("Target and reason must not be empty.");
        if (signal?.aborted) throw new Error("Access request cancelled.");
        if (kind === "write") mutationTarget(input, ctx.cwd, roots);
        const target = kind === "domain" ? input.trim() : canonicalizePath(input, ctx.cwd);
        if (kind === "write") assertMutable(target, roots);
        const config = policy();
        if (
          (kind === "write" &&
            matchesPattern(target, config.filesystem?.denyWrite ?? [], ctx.cwd)) ||
          (kind === "domain" && domainIsAllowed(target, config.network?.deniedDomains ?? []))
        ) {
          throw new Error(`Sandbox: ${kind} access to "${target}" is explicitly denied.`);
        }
        const effective = resolveAllowances(config, allowances);
        const alreadyAllowed =
          kind === "domain"
            ? domainIsAllowed(target, effective.domains)
            : matchesPattern(
                target,
                kind === "read" ? effective.readPaths : effective.writePaths,
                ctx.cwd,
              );
        if (alreadyAllowed) {
          return {
            content: [
              { type: "text", text: `Access already allowed: ${kind} ${JSON.stringify(target)}.` },
            ],
            details: { kind, target, alreadyAllowed: true },
          };
        }
        if (!ctx.hasUI) throw new Error("Sandbox access requests require an approval UI.");
        const choice = await requestAccess({ kind, target, ctx, reason, signal });
        if (choice.action === "abort")
          throw new Error(`Sandbox access request denied for "${target}".`);
        return {
          content: [
            {
              type: "text",
              text:
                `Access approved: ${kind} ${JSON.stringify(target)}.\n` +
                `Rule: ${JSON.stringify(choice.value)}\nScope: ${choice.action}`,
            },
          ],
          details: { kind, target, rule: choice.value, scope: choice.action },
        };
      },
    });
  }

  function bashOps(config: SandboxConfig, kind: "bash" | "user-bash") {
    return createSandboxedBashOps(
      sandboxManager,
      shellPath,
      !config.network?.disabled && config.network?.sshProxy !== false,
      sessionHistory,
      kind,
    );
  }

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (sandboxRequired && !sandboxReady()) throw new Error("Sandbox unavailable.");
      const config = policy();
      return createBashToolDefinition(ctx.cwd, {
        operations: sandboxReady() ? bashOps(config, "bash") : undefined,
        commandPrefix: shellPrefix,
        shellPath,
      }).execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("user_bash", async () => {
    if (sandboxRequired && !sandboxReady())
      return {
        result: { output: "Sandbox unavailable.", exitCode: 1, cancelled: false, truncated: false },
      };
    if (!sandboxReady()) return;
    const config = policy();
    if (config.sandboxUserShell === false) return;
    return { operations: bashOps(config, "user-bash") };
  });

  pi.on("tool_call", (event, ctx) =>
    fileAdapters.block(event.toolName, ctx, "path" in event.input ? event.input.path : undefined),
  );

  pi.on("tool_result", (event, ctx) => {
    if (
      !sandboxEnabled ||
      (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit")
    )
      return;
    const path = event.input.path;
    if (typeof path !== "string") return;
    // Pi reports a tool outcome here. No file data or error text establishes a denial.
    sessionHistory
      .begin(event.toolName, [path, ctx.cwd, event.toolCallId])
      .finish(event.isError ? "tool-error" : "tool-completed");
  });

  pi.on("before_agent_start", ({ systemPromptOptions }, ctx) => {
    const paths = [
      ...(systemPromptOptions.contextFiles ?? []).map((f) => f.path),
      ...(systemPromptOptions.skills ?? []).map((s) => s.filePath),
    ].map((p) => resolve(ctx.cwd, p));
    const updated = new Set([...roots, ...paths, ...paths.map((p) => canonicalizePath(p))]);
    if (updated.size === roots.length) return;
    roots = [...updated];
    if (sandboxEnabled && sandboxInitialized) {
      try {
        updateSandboxConfig(sandboxManager, shellPolicy(ctx.cwd), allowances, ctx.cwd);
      } catch (error) {
        sandboxEnabled = false;
        throw error;
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionHistory.clear();
    sessionHistory = new ExecutionHistory();
    clearSessionAllowances(allowances);
    sandboxRequired = true;
    projectOnlyDisable = false;
    hostBash.start(ctx);
    fileAdapters.start(ctx);
    snapshot = undefined;
    sandboxEnabled = false;
    const trusted = ctx.isProjectTrusted();
    const accepted = sessionPolicy(ctx.cwd, trusted);
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false });
    shellPath = accepted.shell.shellPath ?? settings.getShellPath();
    shellPrefix = accepted.shell.shellCommandPrefix ?? settings.getShellCommandPrefix();
    settings.setProjectTrusted(trusted);
    const paths = getConfigPaths(ctx.cwd);
    roots = managedRoots(
      ctx.cwd,
      [
        ...(pi.getCommands?.() ?? [])
          .filter((c) => c.source === "skill")
          .map((c) => c.sourceInfo.path),
        ...configuredSkillRoots(settings.getGlobalSettings().skills, dirname(paths.globalPath)),
        ...configuredSkillRoots(settings.getProjectSettings().skills, dirname(paths.projectPath)),
      ],
      trusted,
    );
    sessionCwd = ctx.cwd;
    anchors = new Map();
    const fs = accepted.config.filesystem;
    rememberPaths([
      ...(fs?.allowRead ?? []),
      ...(fs?.allowWrite ?? []),
      ...(fs?.denyRead ?? []),
      ...(fs?.denyWrite ?? []),
    ]);
    snapshot = accepted.config;
    revisions = accepted.revisions;
    if (policy().enableAccessRequestTool === true) {
      registerAccessTools();
    }
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxRequired = false;
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!policy().enabled) {
      projectOnlyDisable = !accepted.globalDisabled;
      sandboxRequired = false;
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    hostBash.stop();
    fileAdapters.stop();
    snapshot = undefined;
    sessionHistory.clear();
    sessionHistory = new ExecutionHistory();
    sandboxEnabled = false;
    sandboxRequired = true;
    clearSessionAllowances(allowances);
    cancelPermissionPrompts(pi);
    if (!sandboxInitialized) return;
    try {
      await sandboxManager.reset();
    } catch {
      // Ignore cleanup errors.
    } finally {
      sandboxInitialized = false;
    }
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-history", {
    description: "Show recent session execution metadata",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(sessionHistory.snapshot(), null, 2), "info");
    },
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");

      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }

      if (kind === "write") mutationTarget(targetArg, ctx.cwd, roots);
      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg, ctx.cwd);
      const configKey =
        kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
      const choice = await requestAccess({ kind, target, ctx });
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

      ctx.ui.notify(`Added ${choice.value} to ${configKey}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      ctx.ui.notify(
        formatSandboxConfiguration(policy(), getConfigPaths(ctx.cwd), allowances),
        "info",
      );
    },
  });
}
