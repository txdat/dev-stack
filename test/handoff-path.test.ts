import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { handoffPath } from "../plugins/dev/core/handoff-path.ts";
import { git, repo, run, tmp } from "./helpers.ts";

test("handoff path location, ignore check, and invalid inputs", () => {
  const root = tmp("handoff-path-test");
  const r = repo(`${root}/repo`);
  // The runner's own environment carries PI_SESSION_ID in a Pi session; these cases set it.
  const at = (cwd: string, argv: string[], session: string | undefined) =>
    run(handoffPath, argv, {
      cwd,
      env: { CLAUDE_CODE_SESSION_ID: session, PI_SESSION_ID: undefined },
    });
  // Pi sets its own, and Claude Code's id wins when a session has both.
  const atPi = (cwd: string, session: string | undefined) =>
    run(handoffPath, [], {
      cwd,
      env: { CLAUDE_CODE_SESSION_ID: undefined, PI_SESSION_ID: session },
    });
  const atBoth = (cwd: string) =>
    run(handoffPath, [], {
      cwd,
      env: { CLAUDE_CODE_SESSION_ID: "claude-session", PI_SESSION_ID: "pi-session" },
    });

  // docs/handoff must be ignored first; this repo ignores only docs/plans.
  assert.notEqual(at(r, [], "env-session").code, 0);
  fs.appendFileSync(`${r}/.git/info/exclude`, "/docs/handoff/\n");
  assert.equal(at(r, [], "env-session").out, `${r}/docs/handoff/env-session.md\n`);
  assert.equal(at(r, ["arg-session"], "env-session").out, `${r}/docs/handoff/arg-session.md\n`);
  assert.equal(atPi(r, "pi-session").out, `${r}/docs/handoff/pi-session.md\n`);
  assert.equal(atBoth(r).out, `${r}/docs/handoff/claude-session.md\n`);
  assert.notEqual(atPi(r, "bad id").code, 0);

  // A linked worktree resolves to the main root, which create-pr's cleanup keeps.
  git(r, "worktree", "add", "-q", `${root}/wt`, "-b", "side");
  assert.equal(at(`${root}/wt/`, ["0a1b-2c3d"], "").out, `${r}/docs/handoff/0a1b-2c3d.md\n`);

  assert.notEqual(at(root, [], "x").code, 0);
  assert.notEqual(at(r, [], "").code, 0);
  assert.notEqual(at(r, ["../escape"], "").code, 0);
  assert.notEqual(at(r, [], "../escape").code, 0);
  assert.notEqual(at(r, ["one", "two"], "x").code, 0);
});
