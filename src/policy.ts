import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function canWrite(
  path: string,
  allowWrite: string[],
  denyWrite: string[],
  baseCwd: string = process.cwd(),
) {
  return (
    !matchesPattern(path, denyWrite, baseCwd, false) &&
    !matchesPattern(path, denyWrite, baseCwd) &&
    matchesPattern(path, allowWrite, baseCwd)
  );
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

export function allowsAllDomains(allowedDomains: string[] | undefined): boolean {
  return allowedDomains?.includes("*") ?? false;
}

export function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((pattern) => domainMatchesPattern(domain, pattern));
}

function expandPath(filePath: string, baseCwd: string = process.cwd()): string {
  // Relative entries resolve against the session cwd (baseCwd), not the pi
  // process cwd — these can differ when pi is embedded in a host process
  // (e.g. the pi-web UI) whose cwd is not the project directory.
  return resolve(baseCwd, filePath.replace(/^~(?=$|\/)/, homedir()));
}

export function canonicalizePath(filePath: string, baseCwd: string = process.cwd()): string {
  const absolutePath = expandPath(filePath, baseCwd);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

export function matchesPattern(
  filePath: string,
  patterns: string[],
  baseCwd: string = process.cwd(),
  resolveLinks = true,
): boolean {
  const normalize = resolveLinks ? canonicalizePath : expandPath;
  const absolutePath = normalize(filePath, baseCwd);
  return patterns.some((pattern) => {
    const absolutePattern = pattern.includes("*")
      ? expandPath(pattern, baseCwd)
      : normalize(pattern, baseCwd);
    if (pattern.includes("*")) {
      const escaped = absolutePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(absolutePath);
    }
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
  });
}
