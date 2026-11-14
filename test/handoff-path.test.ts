import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { handoffPath } from "../plugins/dev/core/handoff-path.ts";
import { git, repo, run, tmp } from "./helpers.ts";

test("handoff path location, ignore check, and invalid inputs", () => {
  const root = tmp("handoff-path-test");
  const r = repo(`${root}/repo`);
  const at = (cwd: string, argv: string[], session: string | undefined) =>
    run(handoffPath, argv, { cwd, env: { CLAUDE_CODE_SESSION_ID: session } });

  // docs/handoff must be ignored first; this repo ignores only docs/plans.
  assert.notEqual(at(r, [], "env-session").code, 0);
  fs.appendFileSync(`${r}/.git/info/exclude`, "/docs/handoff/\n");
  assert.equal(at(r, [], "env-session").out, `${r}/docs/handoff/env-session.md\n`);
  assert.equal(at(r, ["arg-session"], "env-session").out, `${r}/docs/handoff/arg-session.md\n`);

  // A linked worktree resolves to the main root, which create-pr's cleanup keeps.
  git(r, "worktree", "add", "-q", `${root}/wt`, "-b", "side");
  assert.equal(at(`${root}/wt/`, ["0a1b-2c3d"], "").out, `${r}/docs/handoff/0a1b-2c3d.md\n`);

  assert.notEqual(at(root, [], "x").code, 0);
  assert.notEqual(at(r, [], "").code, 0);
  assert.notEqual(at(r, ["../escape"], "").code, 0);
  assert.notEqual(at(r, [], "../escape").code, 0);
  assert.notEqual(at(r, ["one", "two"], "x").code, 0);
});
