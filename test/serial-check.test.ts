import assert from "node:assert/strict";
import { test } from "node:test";
import { b } from "../plugins/dev/core/bytes.ts";
import { claudeSerialDeny, serialCheck } from "../plugins/dev/core/serial-check.ts";
import { cli, PLUGIN } from "./helpers.ts";

// A deny reason names the runner and the flag it lacks.
const REASON = /names (jest without --runInBand|vitest without --no-file-parallelism)\./;

const verdict = (command: string): "deny" | "pass" =>
  serialCheck({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: b(command) },
  }) === undefined
    ? "pass"
    : "deny";

const CASES: [want: "deny" | "pass", command: string][] = [
  // Names jest without --runInBand.
  ["deny", "jest"],
  ["deny", "npx jest src/a.test.ts"],
  ["deny", "./node_modules/.bin/jest"],
  ["deny", "node node_modules/jest/bin/jest.js"],
  ["deny", "npm ci && npx jest 2>&1 | tail"],
  ["deny", "npx jest \\\n  src/a.test.ts"],
  ["deny", "jest --maxWorkers=1"],
  ["deny", "jest -i"],
  ["deny", "jest --runInBandX"],
  ["deny", "npx jest@29 src"],
  ["deny", 'bash -c "jest"'],
  ["deny", 'bash -lc "jest src/a.test.ts"'],
  ["deny", 'bash -o pipefail -c "jest"'],
  ["deny", 'bash +o errexit -c "jest"'],
  ["deny", "if true; then jest; fi"],
  ["deny", "for f in a b; do jest $f; done"],
  ["deny", "! jest"],
  ["deny", "echo hi & jest"],
  ["deny", "yarn workspace web jest"],
  ["deny", "pnpm -F web jest"],
  ["deny", "pnpm -r jest"],
  ["deny", "pnpm -w jest"],
  ["deny", "npm -w web exec jest"],
  ["deny", "npx -w web jest"],
  ["deny", "npm exec -w web jest"],
  ["deny", "npm exec -w web -- jest"],
  ["deny", "npm run -w web jest"],
  ["deny", "sudo npm exec -w web jest"],
  ["deny", "pnpm exec -w jest"],
  ["deny", "node -r dotenv/config node_modules/.bin/jest"],
  ["deny", "timeout -k 5 60 jest"],
  ["deny", "timeout --signal=TERM 60 jest"],
  ["deny", "</dev/null jest"],
  ["deny", "< input.txt jest"],
  ["deny", "&>/dev/null jest"],
  ["deny", "&> /dev/null jest"],
  ["deny", "<<< x jest"],
  ["deny", 'bash -euo pipefail -c "jest"'],
  ["deny", 'bash -O extglob -c "jest"'],
  ["deny", 'zsh -O -c "jest src"'],
  ["deny", "NODE_ENV=test pnpm --filter web exec jest src/a.test.ts"],
  // Non-execution mentions pass.
  ["pass", "cat jest.config.js"],
  ["pass", "grep -r jest src"],
  ["pass", 'git commit -m "fix jest timeout"'],
  ["pass", "npm i -D jest"],
  // Names jest with --runInBand.
  ["pass", "jest --runInBand"],
  ["pass", "npx jest --runInBand src/a.test.ts"],
  ["pass", "npx jest \\\n  --runInBand src/a.test.ts"],
  ["pass", "jest --runInBand;"],
  ["pass", "npx jest --runInBand&&echo ok"],
  ["pass", "jest --runInBand|tail"],
  ["pass", "(cd p && npx jest --runInBand)"],
  ["pass", 'bash -c "jest --runInBand"'],
  ["pass", 'bash -lc "jest --runInBand src/a.test.ts"'],
  ["pass", "if true; then jest --runInBand; fi"],
  ["pass", "echo hi & jest --runInBand"],
  ["pass", "pnpm -F web jest --runInBand"],
  ["pass", "npm exec -w web -- jest --runInBand"],
  ["pass", "npx jest '--runInBand'"],
  // Does not name jest as a word.
  ["pass", "npm test"],
  ["pass", "ls"],
  ["pass", "npm i -D ts-jest"],
  ["pass", "cat jestconfig.json"],
  ["pass", "echo majesty"],
  // Names vitest without --no-file-parallelism.
  ["deny", "vitest"],
  ["deny", "vitest run"],
  ["deny", "npx vitest run src/a.test.ts"],
  ["deny", "./node_modules/.bin/vitest run"],
  ["deny", "pnpm exec vitest --run 2>&1 | tail"],
  ["deny", "vitest run --fileParallelism"],
  ["deny", "vitest run --no-file-parallelismX"],
  ["deny", "vitest run --runInBand"],
  ["deny", "npx vitest@3 run"],
  ["deny", 'sh -c "vitest run"'],
  ["deny", 'sh -ec "vitest run"'],
  ["deny", 'zsh -c "vitest run"'],
  ["pass", "cat vitest.config.ts"],
  ["pass", "git diff -- vitest.config.ts"],
  ["pass", "pnpm add -D vitest"],
  // Names vitest with --no-file-parallelism.
  ["pass", "vitest run --no-file-parallelism"],
  ["pass", "npx vitest --no-file-parallelism src/a.test.ts"],
  ["pass", "npx vitest run \\\n  --no-file-parallelism"],
  ["pass", "npx vitest run --no-file-parallelism&&echo ok"],
  ["pass", "npx vitest run '--no-file-parallelism'"],
  // Names both runners: each needs its own flag.
  ["deny", "jest --runInBand && vitest run"],
  ["deny", "jest && vitest run --no-file-parallelism"],
  ["pass", "jest --runInBand && vitest run --no-file-parallelism"],
  // Does not name vitest as a word.
  ["pass", "npm i -D vite"],
  ["pass", "npm i -D vitest-preview"],
  ["pass", "cat vitestconfig.json"],
];

test("each runner needs its serial flag", () => {
  for (const [want, command] of CASES) assert.equal(verdict(command), want, command);
});

test("other tools pass", () => {
  assert.equal(
    serialCheck({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "jest" },
    }),
    undefined,
  );
});

// A deny carries the fields Claude Code reads, event name, decision, and a reason naming the flag,
// and no top-level decision, which Claude Code accepts only as approve or block.
const assertDeny = (text: string) => {
  const v = JSON.parse(text);
  assert.equal(v.decision, undefined);
  assert.equal(v.reason, undefined);
  assert.equal(v.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(v.hookSpecificOutput.permissionDecision, "deny");
  assert.match(v.hookSpecificOutput.permissionDecisionReason, REASON);
};

test("a deny has Claude Code's PreToolUse shape", () => {
  const reason = serialCheck({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npx vitest run" },
  });
  assertDeny(claudeSerialDeny(reason as string));
});

test("bin/hook.ts denies, passes other tools, and reports unreadable input", () => {
  const hook = (input: string) => cli("hook", [], { cwd: PLUGIN, input });
  const denied = hook(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npx jest" },
    }),
  );
  assert.equal(denied.code, 0);
  assertDeny(denied.out);
  const edit = hook('{"tool_name":"Edit","tool_input":{"file_path":"jest"}}');
  assert.deepEqual([edit.code, edit.out], [0, ""]);
  // No verdict, and exit 1, so the adapter passes the call with a warning.
  for (const input of ["not json", "[1]", ""]) {
    const r = hook(input);
    assert.deepEqual([r.code, r.out], [1, ""], input);
  }
});
