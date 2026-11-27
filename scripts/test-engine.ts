// Runs the Claude Code plugin module's engine tests (plugins/dev/hooks/*.test.ts) with
// `claude plugin test`. They import `claude-code/testing`, which only the engine provides, and
// load the built hooks/register.js, so node --test cannot run them and neither checkout directory
// holds both: the script builds the plugin into a scratch directory, copies the tests beside the
// built module with their relative .ts imports rewritten to .js, as the build rewrites the
// module's own, and runs the engine there. The scratch directory is removed afterwards.
// Usage: node scripts/test-engine.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const HOOKS = path.join(ROOT, "plugins/dev/hooks");

const main = (): number => {
  const tests = fs.readdirSync(HOOKS).filter((name) => name.endsWith(".test.ts"));
  if (tests.length === 0) {
    process.stderr.write(`test-engine: no *.test.ts in ${HOOKS}\n`);
    return 1;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dev-stack-engine-"));
  try {
    const plugin = path.join(scratch, "dev");
    const built = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/build.ts"), "--out", plugin],
      { stdio: "inherit" },
    );
    if (built.status !== 0) {
      process.stderr.write("test-engine: the build failed\n");
      return built.status ?? 1;
    }
    for (const name of tests) {
      const text = fs.readFileSync(path.join(HOOKS, name), "utf8");
      const rewritten = text.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
      fs.writeFileSync(path.join(plugin, "hooks", name), rewritten);
    }
    const ran = spawnSync("claude", ["plugin", "test", plugin], { stdio: "inherit" });
    if (ran.error) {
      process.stderr.write(
        `test-engine: could not run \`claude plugin test\`: ${ran.error.message}\n`,
      );
      return 1;
    }
    return ran.status ?? 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

process.exitCode = main();
