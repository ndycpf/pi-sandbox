import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network" | "filesystem"> & {
  /**
   * `denyMandatoryCwdFiles` is added to @carderne/sandbox-runtime by PR #21.
   * Drop it from this type once a released runtime type carries the field.
   *
   * When false, the runtime does not deny the built-in mandatory filenames
   * (.gitconfig, .bashrc, .mcp.json, ...) at the working directory root, which
   * avoids them appearing in the working tree as zero-length character devices.
   */
  filesystem?: NonNullable<SandboxRuntimeConfig["filesystem"]> & {
    denyMandatoryCwdFiles?: boolean;
  };
  enabled?: boolean;
  sandboxUserShell?: boolean;
  filePermissionProvider?: string;
  approvedProjectFiles?: Record<string, string>;
  enableAccessRequestTool?: boolean;
  permissionPromptTimeoutSeconds?: number;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
    /** Route ordinary `ssh` commands through the sandbox SOCKS proxy. */
    sshProxy?: boolean;
    /**
     * Disable network sandboxing entirely (no `--unshare-net`, no proxy) while
     * keeping filesystem sandboxing. The sandboxed process gets direct network
     * access via the host's routing/DNS/VPN. Opt-in; reduces protection.
     */
    disabled?: boolean;
    /**
     * Allow the current SSH agent socket (`SSH_AUTH_SOCK`) inside the sandbox.
     * Disabled by default. When enabled, the resolved existing socket path is
     * added to `allowUnixSockets` at sandbox-build time so macOS `/var` →
     * `/private/var` and the per-boot launchd directory are handled without a
     * broad allowlist. Non-sockets and unresolved paths are ignored.
     */
    allowSSHAgentSocket?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sandboxUserShell: true,
  enableAccessRequestTool: false,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
    sshProxy: true,
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  return {
    ...base,
    ...overrides,
    network: overrides.network
      ? ({ ...base.network, ...overrides.network } as NetworkConfig)
      : base.network,
    filesystem: overrides.filesystem
      ? ({ ...base.filesystem, ...overrides.filesystem } as FilesystemConfig)
      : base.filesystem,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function mergeConfiguredArray(
  fallback: string[] | undefined,
  globalValue: unknown,
  projectValue: unknown,
): string[] | undefined {
  const globalEntries = stringArray(globalValue);
  const projectEntries = stringArray(projectValue);
  if (globalEntries === undefined && projectEntries === undefined) return fallback;
  return [...new Set([...(globalEntries ?? []), ...(projectEntries ?? [])])];
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);

  return {
    ...merged,
    approvedProjectFiles: globalConfig.approvedProjectFiles,
    filePermissionProvider:
      typeof globalConfig.filePermissionProvider === "string" &&
      isAbsolute(globalConfig.filePermissionProvider) &&
      !globalConfig.filePermissionProvider.includes("\0") &&
      normalize(globalConfig.filePermissionProvider) === globalConfig.filePermissionProvider
        ? globalConfig.filePermissionProvider
        : undefined,
    // Cross-sandbox signals can affect unrelated host processes; only global config may grant them.
    allowProcessSignals: globalConfig.allowProcessSignals === true,
    network: {
      ...merged.network,
      allowedDomains:
        mergeConfiguredArray(
          defaults.network?.allowedDomains,
          globalConfig.network?.allowedDomains,
          projectConfig.network?.allowedDomains,
        ) ?? [],
      deniedDomains:
        mergeConfiguredArray(
          defaults.network?.deniedDomains,
          globalConfig.network?.deniedDomains,
          projectConfig.network?.deniedDomains,
        ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaults.network?.allowUnixSockets,
        globalConfig.network?.allowUnixSockets,
        projectConfig.network?.allowUnixSockets,
      ),
      allowMachLookup: mergeConfiguredArray(
        defaults.network?.allowMachLookup,
        globalConfig.network?.allowMachLookup,
        projectConfig.network?.allowMachLookup,
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        mergeConfiguredArray(
          defaults.filesystem?.denyRead,
          globalConfig.filesystem?.denyRead,
          projectConfig.filesystem?.denyRead,
        ) ?? [],
      allowRead: mergeConfiguredArray(
        defaults.filesystem?.allowRead,
        globalConfig.filesystem?.allowRead,
        projectConfig.filesystem?.allowRead,
      ),
      allowWrite:
        mergeConfiguredArray(
          defaults.filesystem?.allowWrite,
          globalConfig.filesystem?.allowWrite,
          projectConfig.filesystem?.allowWrite,
        ) ?? [],
      denyWrite:
        mergeConfiguredArray(
          defaults.filesystem?.denyWrite,
          globalConfig.filesystem?.denyWrite,
          projectConfig.filesystem?.denyWrite,
        ) ?? [],
    },
  };
}

/**
 * Strip `//` line and `/* *\/` block comments while preserving them inside
 * strings, so the JSONC examples in the README parse as written.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) out += "\n";
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseConfig(
  configPath: string,
  text = readFileSync(configPath, "utf-8"),
): SandboxConfigFile {
  const parsed: unknown = JSON.parse(stripJsonComments(text));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("configuration must be a JSON object");
  }
  return parsed as SandboxConfigFile;
}

/**
 * Read a config for the purpose of writing it back. If the file exists but
 * cannot be parsed, throw instead of returning `{}` — otherwise a permission
 * grant would silently overwrite (and destroy) the user's existing config.
 */
function readConfigForWrite(configPath: string): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    return parseConfig(configPath);
  } catch (error) {
    throw new Error(
      `Refusing to overwrite ${configPath}: existing file could not be parsed (${error}). ` +
        `Fix the file manually, then retry.`,
    );
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, CONFIG_DIR_NAME, "sandbox.json"),
  };
}

export function loadConfig(cwd: string, projectTrusted = true): SandboxConfig {
  return sessionPolicy(cwd, projectTrusted).config;
}

// The global file is the user-managed trust anchor. Hash and parse the same
// bytes so a changed project file never becomes policy via a second read.
function optionalBytes(path: string) {
  return lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path) : undefined;
}
function digest(bytes: Buffer | undefined) {
  return bytes && createHash("sha256").update(bytes).digest("hex");
}
export function configRevision(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.nlink !== 1))
    throw new Error("Review linked configuration manually.");
  return digest(optionalBytes(path));
}
export function sessionPolicy(cwd: string, trusted: boolean) {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const revisions = new Map<string, string | undefined>();
  const bytes = optionalBytes(globalPath);
  revisions.set(globalPath, digest(bytes));
  const global = bytes ? parseConfig(globalPath, bytes.toString("utf8")) : {};
  const pins = global.approvedProjectFiles ?? {};
  if (!pins || typeof pins !== "object" || Array.isArray(pins))
    throw new Error("Invalid approvedProjectFiles.");
  const approved = (path: string, onlyShell = false) => {
    if (!trusted) return {};
    const bytes = optionalBytes(path);
    const revision = digest(bytes);
    revisions.set(path, revision);
    if (!bytes && !Object.hasOwn(pins, path)) return {};
    if (!bytes) throw new Error("Missing approved project file: " + path);
    const parsed = parseConfig(path, bytes.toString("utf8"));
    if (
      onlyShell &&
      !("shellPath" in parsed || "shellCommandPrefix" in parsed) &&
      !Object.hasOwn(pins, path)
    )
      return {};
    if (pins[path] !== revision)
      throw new Error(
        "Review the project configuration and pin its SHA-256 in global approvedProjectFiles: " +
          path,
      );
    return parsed;
  };
  const project = approved(projectPath);
  for (const layer of [global, project]) {
    if (
      layer.filesystem !== undefined &&
      (!layer.filesystem || typeof layer.filesystem !== "object" || Array.isArray(layer.filesystem))
    )
      throw new Error("Invalid filesystem policy.");
    for (const key of ["allowRead", "allowWrite", "denyRead", "denyWrite"] as const)
      if (
        layer.filesystem &&
        Object.hasOwn(layer.filesystem, key) &&
        (!stringArray(layer.filesystem[key]) ||
          layer.filesystem[key]?.some((p) => !p.trim() || p.includes("\0")))
      )
        throw new Error("Invalid filesystem rule: " + key);
    if (layer.enabled !== undefined && typeof layer.enabled !== "boolean")
      throw new Error("Invalid sandbox enabled setting.");
  }
  const config = mergeConfigLayers(DEFAULT_CONFIG, global, project);
  if (Object.hasOwn(global, "filePermissionProvider") && !config.filePermissionProvider)
    config.filePermissionProvider = "";
  const shell = approved(join(dirname(projectPath), "settings.json"), true) as {
    shellPath?: string;
    shellCommandPrefix?: string;
  };
  for (const v of [shell.shellPath, shell.shellCommandPrefix])
    if (v !== undefined && typeof v !== "string") throw new Error("Invalid project shell setting.");
  return { config, revisions, globalDisabled: global.enabled === false, shell };
}

export const grantKeys = {
  domain: "allowedDomains",
  read: "allowRead",
  write: "allowWrite",
} as const;
export type GrantKind = keyof typeof grantKeys;

export function addGrantToConfig(configPath: string, kind: GrantKind, value: string) {
  const config = readConfigForWrite(configPath);
  function append(values: string[] | undefined) {
    const entries = stringArray(values) ?? [];
    return entries.includes(value) ? undefined : [...entries, value];
  }
  if (kind === "domain") {
    const allowedDomains = append(config.network?.allowedDomains);
    if (!allowedDomains) return;
    config.network = { ...config.network, allowedDomains };
  } else {
    const key = grantKeys[kind];
    const values = append(config.filesystem?.[key]);
    if (!values) return;
    config.filesystem = { ...config.filesystem, [key]: values };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
