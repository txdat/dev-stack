// core/sys.ts's run(): how a command that cannot start, is killed, or fails reads to its caller.

import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../plugins/dev/core/sys.ts";

test("run: exit codes of a command that cannot start, is killed, or fails", () => {
  const missing = run(["dev-test-no-such-command"]);
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /ENOENT/);
  assert.equal(run(["sh", "-c", "kill -9 $$"]).code, 137, "128 + SIGKILL");
  assert.equal(run(["sh", "-c", "kill -15 $$"]).code, 143, "128 + SIGTERM");
  const failed = run(["sh", "-c", "echo out; echo err >&2; exit 3"]);
  assert.deepEqual(failed, { code: 3, stdout: "out\n", stderr: "err\n" });
});
