// The /dev-stack-* commands both adapters share (hooks/commands.ts): parsing, plan paths read back
// from the repository's docs/plans, and output shortened to them. dev-stack.ts is a stand-in that
// records each argv and answers with `ran`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, runCommand, type StackRun } from "../plugins/dev/hooks/commands.ts";

// The session's repository; plans live in its docs/plans.
const PLANS = "/home/u/repo/docs/plans";
// A repository path with a space; the plan's own name allows none.
const PLAN = "/tmp/my repo/docs/plans/12_s/pr1.spec.md";

const command = (name: string) => {
  const c = COMMANDS.find((c) => c.name === name);
  assert.ok(c, name);
  return c;
};

/** Runs `name` on `args`; `calls` records each dev-stack.ts argv. */
const runner = (ran: StackRun = { code: 0, stdout: "ok\n", stderr: "" }, plansRoot = PLANS) => {
  const calls: string[][] = [];
  const run = (name: string, args: string) =>
    runCommand(command(name), args, {
      cwd: "/home/u/repo/sub",
      plansRoot: () => plansRoot,
      home: "/home/u",
      devStack: (argv) => {
        calls.push(argv);
        return ran;
      },
    });
  return { calls, run };
};

test("each command runs its dev-stack.ts subcommand, a plan path with spaces kept whole", () => {
  const { calls, run } = runner();
  const cases: [string, string, string[]][] = [
    ["dev-stack-next", PLAN, ["next", PLAN]],
    ["dev-stack-next", `${PLAN} --tab`, ["next", PLAN, "--tab"]],
    ["dev-stack-next", `${PLAN} --tree`, ["next", PLAN, "--tree"]],
    ["dev-stack-next", `${PLAN} --md`, ["next", PLAN, "--md"]],
    ["dev-stack-list", PLAN, ["stack", PLAN]],
    ["dev-stack-check", PLAN, ["check", PLAN]],
    ["dev-stack-review", `${PLAN} needs-changes`, ["review", PLAN, "needs-changes"]],
    [
      "dev-stack-stop",
      `${PLAN}  Failed fixes: 3/3 — flaky test`,
      ["stop", PLAN, "Failed fixes: 3/3 — flaky test"],
    ],
    ["dev-stack-resume", PLAN, ["resume", PLAN]],
    ["dev-stack-reopen", PLAN, ["reopen", PLAN]],
  ];
  for (const [name, args, argv] of cases) {
    run(name, args);
    assert.deepEqual(calls.pop(), argv, `${name} ${args}`);
  }
});

test("a missing argument shows usage and runs nothing", () => {
  const { calls, run } = runner();
  const cases: [string, string][] = [
    ["dev-stack-next", ""],
    ["dev-stack-review", PLAN],
    ["dev-stack-review", `${PLAN} approved`],
    ["dev-stack-review", "notaplan ready"],
    ["dev-stack-stop", PLAN],
    ["dev-stack-resume", "  "],
    ["dev-stack-reopen", `${PLAN} extra`],
    ["dev-stack-next", `${PLAN} --json`],
    ["dev-stack-check", `${PLAN} extra`],
  ];
  for (const [name, args] of cases)
    assert.ok(run(name, args).text.startsWith(`Usage: /${name} `), `${name} ${args}`);
  assert.equal(calls.length, 0);
});

test("only a successful write carries a note", () => {
  const { run } = runner();
  assert.match(run("dev-stack-resume", PLAN).note ?? "", /cleared the stop on \/tmp\/my repo/);
  assert.equal(run("dev-stack-list", PLAN).note, undefined);
  const failed = runner({ code: 1, stdout: "", stderr: "Plan not found: x" }).run(
    "dev-stack-resume",
    PLAN,
  );
  assert.deepEqual(failed, { text: "Plan not found: x" });
});

test("check's blocked report on stdout is shown", () => {
  const { run } = runner({ code: 1, stdout: "PASS a\nBLOCK b\nreason\n", stderr: "" });
  assert.equal(run("dev-stack-check", PLAN).text, "PASS a\nBLOCK b\nreason");
});

test("a plan outside the repository gets a hint", () => {
  const { run } = runner({ code: 1, stdout: "", stderr: "Plan must be ~/repo/docs/plans/..." });
  assert.match(run("dev-stack-next", PLAN).text, /Run it from the plan's repository/);
});

test("plan paths show without the repository's docs/plans prefix", () => {
  const { run } = runner({
    code: 0,
    stdout:
      "/home/u/repo/docs/plans/12_s/pr1.spec.md\tplanning\t-\treview-feature\t-\n~/repo/docs/plans/12_s/pr2.spec.md\n",
    stderr: "",
  });
  assert.equal(
    run("dev-stack-next", PLAN).text,
    "12_s/pr1.spec.md\tplanning\t-\treview-feature\t-\n12_s/pr2.spec.md",
  );
});

test("outside a repository a plan path passes through as typed and nothing is shortened", () => {
  const { calls, run } = runner(
    { code: 1, stdout: "", stderr: "Plan not found: /home/u/repo/docs/plans/12_s/pr9.spec.md" },
    "",
  );
  const out = run("dev-stack-resume", "12_s/pr9.spec.md");
  assert.deepEqual(calls.pop(), ["resume", "12_s/pr9.spec.md"]);
  assert.match(out.text, /Plan not found: \/home\/u\/repo\/docs\/plans\/12_s\/pr9\.spec\.md/);
});

test("the format hint keeps its prefix", () => {
  const { run } = runner({
    code: 1,
    stdout: "",
    stderr:
      "Plan must be ~/repo/docs/plans/<issue>_<slug>/pr<N>.spec.md: /home/u/repo/docs/plans/x/pr1.spec.md",
  });
  assert.equal(
    run("dev-stack-next", PLAN).text.split("\n")[0],
    "Plan must be ~/repo/docs/plans/<issue>_<slug>/pr<N>.spec.md: x/pr1.spec.md",
  );
});

test("a plan path as shown, under docs/plans, ./, or ../, or after @, is read back", () => {
  const { calls, run } = runner();
  run("dev-stack-next", "@12_s/pr1.spec.md");
  assert.deepEqual(calls.pop(), ["next", `${PLANS}/12_s/pr1.spec.md`]);
  run("dev-stack-next", "docs/plans/12_s/pr1.spec.md");
  assert.deepEqual(calls.pop(), ["next", `${PLANS}/12_s/pr1.spec.md`], "relative to the root");
  run("dev-stack-next", "@./pr1.spec.md");
  assert.deepEqual(calls.pop(), ["next", "/home/u/repo/sub/./pr1.spec.md"], "relative to the cwd");
  run("dev-stack-next", "../docs/plans/12_s/pr1.spec.md");
  assert.deepEqual(calls.pop(), ["next", "/home/u/repo/sub/../docs/plans/12_s/pr1.spec.md"]);
  const out = run("dev-stack-resume", "12_s/pr1.spec.md");
  assert.deepEqual(calls.pop(), ["resume", `${PLANS}/12_s/pr1.spec.md`]);
  assert.match(out.note ?? "", /\/home\/u\/repo\/docs\/plans\/12_s\/pr1\.spec\.md/);
});

test("a usage error from dev-stack.ts shows the usage line; a throw is reported", () => {
  const { run } = runner({ code: 2, stdout: "", stderr: "Usage: dev-stack.js ..." });
  assert.equal(
    run("dev-stack-review", `${PLAN} ready`).text,
    "Usage: /dev-stack-review <spec file> ready|needs-changes",
  );
  const threw = runCommand(command("dev-stack-list"), PLAN, {
    cwd: "/",
    plansRoot: () => PLANS,
    home: "",
    devStack: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(threw, { text: "dev-stack.js failed: boom" });
});

test("no output reads as (no output)", () => {
  assert.equal(
    runner({ code: 0, stdout: "", stderr: "" }).run("dev-stack-list", PLAN).text,
    "(no output)",
  );
});
