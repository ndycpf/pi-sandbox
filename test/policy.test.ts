import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  canWrite,
  domainIsAllowed,
  matchesPattern,
} from "../src/policy.ts";

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("decides write policy from deny and allow lists", () => {
  assert.equal(canWrite("/tmp/file", ["/tmp"], ["/tmp/file"]), false);
  assert.equal(canWrite("/tmp/file", ["/tmp"], []), true);
  assert.equal(canWrite("/tmp/file", ["/var"], []), false);
  assert.equal(canWrite("/tmp/file", [], []), false);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("relative paths resolve against baseCwd, not process.cwd()", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-basecwd-"));
  const project = canonicalizePath(root);

  // "." and relative entries resolve against the passed baseCwd.
  assert.equal(canonicalizePath(".", project), project);
  assert.equal(canonicalizePath("sub/file", project), join(project, "sub", "file"));

  // matchesPattern honors baseCwd for both the path and the pattern.
  assert.equal(matchesPattern(join(project, "f.txt"), ["."], project), true);
  assert.equal(matchesPattern("f.txt", ["."], project), true);
  assert.equal(matchesPattern("f.txt", ["other"], project), false);

  // canWrite threads baseCwd through to the pattern match.
  assert.equal(canWrite("f.txt", ["."], [], project), true);
  assert.equal(canWrite("f.txt", [], [], project), false);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});
