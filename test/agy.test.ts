// Antigravity adapter (plugins/dev/bin/agy-hook.ts and --agy build): SessionStart rule
// injection, PreToolUse/PostToolUse translation to serialCheck and gateCheck, and the dist/dev-agy
// manifest/frontmatter build.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { exec, PLUGIN, planText, read, repo, tmp, write } from "./helpers.ts";

const ROOT = path.resolve(PLUGIN, "../..");
const HOOK = path.join(PLUGIN, "bin/agy-hook.ts");

const runHook = (
  payload: unknown,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, unknown> => {
  const r = exec(["node", HOOK], {
    ...opts,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  assert.equal(r.code, 0, r.all);
  return JSON.parse(r.out) as Record<string, unknown>;
};

test("SessionStart injects $DEV_LIB, CORE.md, and CODING.md", () => {
  const out = runHook(
    { hookEventName: "SessionStart", cwd: ROOT },
    { env: { ...process.env, PLUGIN_ROOT: PLUGIN } },
  );
  const steps = out["injectSteps"] as Array<{ systemMessage?: { systemMessage?: string } }>;
  assert.equal(steps.length, 1);
  const msg = steps[0]?.systemMessage?.systemMessage ?? "";
  assert.ok(msg.startsWith(`$DEV_LIB is ${PLUGIN}:`));
  assert.ok(msg.includes(`${PLUGIN}/rules/CORE.md`));
  assert.ok(msg.includes(`${PLUGIN}/rules/CODING.md`));
});

test("PreToolUse enforces serialCheck and recordGuard on run_command, edit_file, and write_file", () => {
  const dir = repo(tmp("dev-agy-guard"));
  const spec = path.join(dir, "docs/plans/1_test/pr1.spec.md");
  write(spec, planText({ Status: "ready", Base: "main", Branch: "p1", PR: "none" }));

  const serialDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    toolCall: { id: "t1", name: "run_command", args: { CommandLine: "npx jest" } },
  });
  assert.equal(serialDeny["decision"], "deny");
  assert.match(String(serialDeny["reason"]), /--runInBand/);

  const serialAllow = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    toolCall: { id: "t2", name: "run_command", args: { CommandLine: "npx jest --runInBand" } },
  });
  assert.equal(serialAllow["decision"], "allow");

  const editDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    toolCall: {
      id: "t3",
      name: "edit_file",
      args: { Path: spec, Target: "Status: ready", Replacement: "Status: approved" },
    },
  });
  assert.equal(editDeny["decision"], "deny");
  assert.match(String(editDeny["reason"]), /Only the user sets 'Status: approved'/);

  const writeDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    toolCall: {
      id: "t4",
      name: "write_file",
      args: { Path: spec, Content: planText({ Status: "approved" }), Overwrite: true },
    },
  });
  assert.equal(writeDeny["decision"], "deny");
});

test("PreToolUse gates read_file on gated dev skills and allows ungated skills", () => {
  const dir = repo(tmp("dev-agy-skill"));
  const deny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "review code please",
    toolCall: {
      id: "s1",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-code/SKILL.md") },
    },
  });
  assert.equal(deny["decision"], "deny");

  const allow = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "explore the codebase",
    toolCall: {
      id: "s2",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/explore/SKILL.md") },
    },
  });
  assert.equal(allow["decision"], "allow");
});

test("PreToolUse allows read_file on gated SKILL.md when autopilot/run-stack delegates a plan", () => {
  const dir = repo(tmp("dev-agy-autopilot-skill"));
  const spec = path.join(dir, "docs/plans/37088_fix/pr1.spec.md");
  write(
    spec,
    planText(
      {
        Issue: "#37088",
        Type: "fix",
        Status: "planning",
        Spec: "-",
        Tip: "-",
        Base: "main",
        Branch: "fix-37088",
      },
      [
        "## Goal",
        "g",
        "## Scope",
        "in / out",
        "## Acceptance Criteria",
        "AC-1 — a",
        "  Source: s",
        "  Success: ok",
        "  Failure: fail",
        "## Test Cases",
        "TC-1 — t",
        "  Proves: AC-1",
        "  Fixture: f",
        "  Action: a",
        "  Expected: e",
        "## Implementation Steps",
        "ST-1 — s — satisfies TC-1",
        "  PC-1 — p — Check: true",
        "",
      ].join("\n"),
    ),
  );

  const out = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "/dev:autopilot issue 37088",
    toolCall: {
      id: "s3",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-feature/SKILL.md") },
    },
  });
  assert.equal(out["decision"], "allow", JSON.stringify(out));

  // Multi-plan run-stack: lastUserInput names pr1.spec.md while a subagent reads a gated skill
  // for pr2.spec.md, or invokes bare run-stack / autopilot.
  const pr2 = path.join(dir, "docs/plans/37088_fix/pr2.spec.md");
  write(
    pr2,
    planText({
      Issue: "#37088",
      Type: "fix",
      Status: "approved",
      Base: "fix-37088",
      Branch: "fix-37088-p2",
      "Stacks On": "docs/plans/37088_fix/pr1.spec.md",
      PR: "none",
    }),
  );

  for (const [input, skill] of [
    [`/dev:run-stack ${spec}`, "execute-feature"],
    [`run-stack ${spec}`, "review-code"],
    ["autopilot issue 37088", "create-pr"],
  ]) {
    const res = runHook({
      hookEventName: "PreToolUse",
      cwd: dir,
      lastUserInput: input,
      toolCall: {
        id: "s4",
        name: "read_file",
        args: { Path: path.join(PLUGIN, `skills/${skill}/SKILL.md`) },
      },
    });
    assert.equal(res["decision"], "allow", `${input} (${skill}): ${JSON.stringify(res)}`);
  }

  // Prose mentioning autopilot does not bypass the gate.
  const proseDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "explain how autopilot works",
    toolCall: {
      id: "s5",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-code/SKILL.md") },
    },
  });
  assert.equal(proseDeny["decision"], "deny");

  // Inside invoke_subagent, lastUserInput is empty or does not carry the parent's orchestrator
  // command; allow when a plan in docs/plans/ passes the phase gate, and deny when none does.
  const subagentReviewAllow = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "",
    toolCall: {
      id: "s6",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-feature/SKILL.md") },
    },
  });
  assert.equal(subagentReviewAllow["decision"], "allow", JSON.stringify(subagentReviewAllow));

  const subagentExecDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "",
    toolCall: {
      id: "s7",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/execute-feature/SKILL.md") },
    },
  });
  assert.equal(subagentExecDeny["decision"], "deny", JSON.stringify(subagentExecDeny));

  // Explicit wrong-status plan mention is still denied even if another plan is runnable.
  const explicitDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: `/dev:execute-feature ${spec}`,
    toolCall: {
      id: "s8",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/execute-feature/SKILL.md") },
    },
  });
  assert.equal(explicitDeny["decision"], "deny", JSON.stringify(explicitDeny));
});

test("PostToolUse restores unauthorized plan edits from PreToolUse snapshot", () => {
  const dir = repo(tmp("dev-agy-post"));
  const spec = path.join(dir, "docs/plans/1_test/pr1.spec.md");
  const original = planText({ Status: "ready", Base: "main", Branch: "p1", PR: "none" });
  write(spec, original);

  const pre = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    toolCall: { id: "b1", name: "run_command", args: { CommandLine: "echo tamper" } },
  });
  assert.equal(pre["decision"], "allow");

  write(spec, planText({ Status: "approved", Base: "main", Branch: "p1", PR: "none" }));
  const post = runHook({
    hookEventName: "PostToolUse",
    cwd: dir,
    toolCall: { id: "b1", name: "run_command", args: { CommandLine: "echo tamper" } },
  });
  assert.deepEqual(post, {});
  assert.equal(read(spec), original);
});

test("malformed stdin fails open with decision allow", () => {
  const out = runHook("{not-json");
  assert.equal(out["decision"], "allow");
});

test("scripts/build.ts --agy builds a valid Antigravity bundle", () => {
  const out = path.join(tmp("dev-agy-dist"), "dev-agy");
  const r = exec(["node", path.join(ROOT, "scripts/build.ts"), "--agy", "--out", out]);
  assert.equal(r.code, 0, r.all);

  assert.ok(fs.existsSync(path.join(out, "plugin.json")));
  assert.ok(fs.existsSync(path.join(out, "hooks.json")));
  assert.ok(fs.existsSync(path.join(out, "bin/agy-hook.js")));

  const skill = read(path.join(out, "skills/design-feature/SKILL.md"));
  assert.match(skill, /^model: gemini-4-argon$/m);

  const agent = read(path.join(out, "agents/planner.md"));
  assert.match(
    agent,
    /^tools:\n {2}- read_file\n {2}- run_command\n {2}- manage_task\n {2}- edit_file\n {2}- write_file\nsubagent: true\nmainAgent: false$/m,
  );
  assert.doesNotMatch(agent, /^ {2}- (Read|Grep|Glob|Bash|Skill|Edit|Write)$/m);

  const rule = read(path.join(out, "rules/CORE.md"));
  assert.ok(rule.startsWith("---\ntrigger: manual\n---\n"));
});
