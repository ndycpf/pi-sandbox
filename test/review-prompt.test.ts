import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { loadReviewPrompt } from "../src/review-prompt.ts";
test("operator prompt accepts bounded UTF-8 and refuses unsafe or unusable inputs", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-operator-prompt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work"),
    file = join(root, "prompt");
  mkdirSync(cwd);
  for (const candidate of [undefined, "relative", file, cwd])
    assert.equal(loadReviewPrompt(candidate, cwd), null);
  writeFileSync(file, "x".repeat(65536), { mode: 0o600 });
  assert.equal(loadReviewPrompt(file, cwd)?.length, 65536);
  chmodSync(file, 0o666);
  assert.equal(loadReviewPrompt(file, cwd), null);
  chmodSync(file, 0o600);
  symlinkSync(file, join(root, "link"));
  assert.equal(loadReviewPrompt(join(root, "link"), cwd), null);
  writeFileSync(join(cwd, "prompt"), "Synthetic fixture.");
  assert.equal(loadReviewPrompt(join(cwd, "prompt"), cwd), null);
  for (const bytes of ["x".repeat(65537), " ", "", Buffer.from([255]), "x\0y"]) {
    writeFileSync(file, bytes);
    assert.equal(loadReviewPrompt(file, cwd), null);
  }
});
