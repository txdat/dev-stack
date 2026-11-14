// core/sys.ts's run(): how a command that cannot start, is killed, or fails reads to its caller;
// replaceBytes(): one rename that keeps the file's mode.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { test } from "node:test";
import { replaceBytes, run } from "../plugins/dev/core/sys.ts";

test("run: exit codes of a command that cannot start, is killed, or fails", () => {
  const missing = run(["dev-test-no-such-command"], { env: {} });
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /ENOENT/);
  assert.equal(run(["sh", "-c", "kill -9 $$"], { env: {} }).code, 137, "128 + SIGKILL");
  assert.equal(run(["sh", "-c", "kill -15 $$"], { env: {} }).code, 143, "128 + SIGTERM");
  const failed = run(["sh", "-c", "echo out; echo err >&2; exit 3"], { env: {} });
  assert.deepEqual(failed, { code: 3, stdout: "out\n", stderr: "err\n" });
});

test("run: the child gets the caller's env over this process's", () => {
  process.env["DEV_TEST_KEPT"] = "kept";
  process.env["DEV_TEST_UNSET"] = "set";
  try {
    const ran = run(
      [
        "sh",
        "-c",
        'printf "%s|%s|" "$DEV_TEST_KEPT" "$DEV_TEST_NEW"; printenv DEV_TEST_UNSET || printf unset',
      ],
      {
        env: { DEV_TEST_NEW: "new", DEV_TEST_UNSET: undefined },
      },
    );
    assert.equal(ran.stdout, "kept|new|unset");
  } finally {
    delete process.env["DEV_TEST_KEPT"];
    delete process.env["DEV_TEST_UNSET"];
  }
});

test("replaceBytes: keeps the mode, follows no link, and leaves the file on failure", () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/dev-sys-`);
  try {
    const f = `${dir}/f`;
    fs.writeFileSync(f, "old");
    fs.chmodSync(f, 0o640);
    replaceBytes(f, "new\xe9");
    assert.deepEqual(fs.readFileSync(f), Buffer.from("new\xe9", "latin1"), "bytes, not UTF-8");
    assert.equal(fs.statSync(f).mode & 0o777, 0o640);

    replaceBytes(`${dir}/fresh`, "x");
    assert.equal(fs.statSync(`${dir}/fresh`).mode & 0o777, 0o600);

    // A symlink at the path is replaced by the file, with its target's mode; the target is kept.
    fs.symlinkSync(f, `${dir}/link`);
    replaceBytes(`${dir}/link`, "via link");
    assert.ok(!fs.lstatSync(`${dir}/link`).isSymbolicLink());
    assert.equal(fs.statSync(`${dir}/link`).mode & 0o777, 0o640);
    assert.deepEqual(fs.readFileSync(f), Buffer.from("new\xe9", "latin1"));

    // A directory at the path cannot be renamed over; it stays, with no temp file beside it.
    fs.mkdirSync(`${dir}/d`);
    assert.throws(() => replaceBytes(`${dir}/d`, "x"));
    assert.ok(fs.statSync(`${dir}/d`).isDirectory());
    assert.deepEqual(fs.readdirSync(dir).sort(), ["d", "f", "fresh", "link"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
