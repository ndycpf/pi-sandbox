/**
 * Pi's shared session-liveness registry (v1), read by RPC hosts such as Orca
 * and pi-web before they stop a quiet Pi session. A provider that reports
 * active work keeps the session, so background tasks are not killed by an
 * idle stop. Whoever loads first installs it; the shape matches the hosts' own.
 */
const LIVENESS_REGISTRY = Symbol.for("@agegr/pi-web/session-liveness/v1");

type LivenessProvider = {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive: () => boolean;
};
type LivenessRegistry = {
  version: 1;
  register(provider: LivenessProvider): () => void;
  hasActiveProvider(session: { sessionId?: string; sessionFile?: string }): boolean;
};

export function sessionLivenessRegistry(): LivenessRegistry {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[LIVENESS_REGISTRY] as Partial<LivenessRegistry> | undefined;
  if (
    existing &&
    typeof existing === "object" &&
    existing.version === 1 &&
    typeof existing.register === "function" &&
    typeof existing.hasActiveProvider === "function"
  ) {
    return existing as LivenessRegistry;
  }
  const providers = new Map<symbol, LivenessProvider>();
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const registry: LivenessRegistry = {
    version: 1,
    register(provider) {
      if (
        !provider ||
        !text(provider.name) ||
        !text(provider.sessionId) ||
        (provider.sessionFile !== undefined && !text(provider.sessionFile)) ||
        typeof provider.isActive !== "function"
      ) {
        throw new Error("Session liveness provider is invalid");
      }
      const key = Symbol(provider.name);
      providers.set(key, provider);
      return () => providers.delete(key);
    },
    hasActiveProvider(session) {
      const ids = new Set([session.sessionId, session.sessionFile].filter(Boolean));
      for (const provider of providers.values()) {
        if (
          !ids.has(provider.sessionId) &&
          !(provider.sessionFile && ids.has(provider.sessionFile))
        )
          continue;
        try {
          if (provider.isActive() !== false) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };
  global[LIVENESS_REGISTRY] = registry;
  return registry;
}

/**
 * Report `isActive` for the context's session until the returned function is
 * called. Returns undefined when the session has no id or the registry
 * installed by another extension is not compatible.
 */
export function trackSessionLiveness(
  ctx: { sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined } },
  name: string,
  isActive: () => boolean,
): (() => void) | undefined {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) return undefined;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  try {
    return sessionLivenessRegistry().register({
      name,
      sessionId,
      ...(sessionFile ? { sessionFile } : {}),
      isActive,
    });
  } catch {
    return undefined;
  }
}
