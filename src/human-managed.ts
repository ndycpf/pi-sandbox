import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultWritePaths } from "@carderne/sandbox-runtime";
import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

import { getConfigPaths } from "./config.ts";
import { canonicalizePath } from "./policy.ts";

const directories = [".pi", ".agents", ".skills", CONFIG_DIR_NAME];
const contextNames = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

// Pi resolves literal settings entries relative to the settings directory.
// Pattern entries filter discovered skills and do not introduce scan roots.
export function configuredSkillRoots(entries: readonly string[] = [], base: string) {
  return entries
    .filter((s) => !/^[!+-]|[*?]/.test(s))
    .map((s) => {
      const path = s.trim();
      if (path === "~" || path.startsWith("~/"))
        return join(process.env.HOME || homedir(), path.slice(1));
      return resolve(base, path.startsWith("file://") ? fileURLToPath(path) : path);
    });
}

export function managedRoots(cwd: string, resources: string[], projectTrusted: boolean) {
  const agent = resolve(getAgentDir());
  const config = getConfigPaths(cwd);
  const roots = new Set([
    agent,
    config.globalPath,
    config.projectPath,
    join(agent, "settings.json"),
    join(dirname(config.projectPath), "settings.json"),
    ...contextNames.map((n) => join(agent, n)),
    ...directories.map((n) => resolve(cwd, n)),
    resolve(cwd, "SKILL.md"),
    join(process.env.HOME || homedir(), ".agents", "skills"),
    ...resources.map((p) => resolve(cwd, p)),
  ]);
  let scanSkills = projectTrusted;
  for (let p = resolve(cwd); ; p = dirname(p)) {
    for (const name of contextNames) roots.add(join(p, name));
    if (scanSkills) roots.add(join(p, ".agents", "skills"));
    if (existsSync(join(p, ".git"))) scanSkills = false;
    if (p === dirname(p)) break;
  }
  return [...new Set([...roots].flatMap((p) => [p, canonicalizePath(p)]))];
}

export function isManaged(path: string, roots: readonly string[]) {
  return [path, canonicalizePath(path)].some((p) =>
    roots.some(
      (root) =>
        p.toLowerCase() === root.toLowerCase() ||
        p.toLowerCase().startsWith(root.toLowerCase() + sep),
    ),
  );
}

// Match Pi 0.80's write/edit argument normalization before external dispatch.
export function mutationTarget(input: unknown, cwd: string, roots: readonly string[]) {
  if (typeof input !== "string" || !input) throw new Error("Invalid file target.");
  let name = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (name === "~" || name.startsWith("~/")) name = join(homedir(), name.slice(1));
  else if (name.startsWith("file://")) name = fileURLToPath(name);
  const path = resolve(cwd, name);
  assertMutable(path, roots);
  return path;
}

export function assertMutable(path: string, roots: readonly string[]) {
  if (isManaged(path, roots)) throw new Error("Human-managed path: edit manually.");
  // Refuse ambiguous hard links and dangling symlinks, including in ancestors.
  let existing = path;
  while (!lstatSync(existing, { throwIfNoEntry: false }) && dirname(existing) !== existing)
    existing = dirname(existing);
  const real = realpathSync.native(existing);
  if (
    isManaged(real, roots) ||
    (existing === path && !statSync(real).isDirectory() && statSync(real).nlink !== 1)
  )
    throw new Error("Human-managed or multiply linked target: edit manually.");
}

export function managedShellDenies(
  roots: readonly string[],
  writes: readonly string[],
  cwd: string,
) {
  const concrete = writes.filter((p) => !p.includes("*")).map((p) => canonicalizePath(p, cwd));
  const implicit = getDefaultWritePaths().filter((p) => isManaged(p, roots));
  const literals = new Set([...roots, ...concrete.filter((p) => isManaged(p, roots)), ...implicit]);
  // Bubblewrap masks the first missing component. Avoid asking it to place
  // both a directory mask and a file mask at the same absent managed root.
  const missing = new Set([...literals].filter((p) => !lstatSync(p, { throwIfNoEntry: false })));
  return [...literals].filter((p) => {
    for (let parent = dirname(p); parent !== dirname(parent); parent = dirname(parent))
      if (missing.has(parent)) return false;
    return true;
  });
}
