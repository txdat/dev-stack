// Antigravity adapter (plugins/dev/bin/agy-hook.ts and --agy build): SessionStart rule
// injection, PreToolUse/PostToolUse translation to serialCheck and gateCheck, and the dist/dev-agy
// manifest/frontmatter build.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { BUN, exec, PLUGIN, planText, read, repo, tmp, write } from "./helpers.ts";

const ROOT = path.resolve(PLUGIN, "../..");
const HOOK = path.join(PLUGIN, "bin/agy-hook.ts");

const runHook = (
  payload: unknown,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, unknown> => {
  const r = exec([...BUN, HOOK], {
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

test("PreToolUse passes non-ASCII edit text to the record guard as written", () => {
  const dir = repo(tmp("dev-agy-utf8"));
  const rb = path.join(dir, "docs/runbook/1_db/rb.md");
  const log = path.join(dir, "docs/runbook/1_db/log");
  write(rb, "# Move\nStatus: approved\nSpec: abc\nIssue: none\n\n## Phases\nPH-1 — copy\n");
  write(log, "EX-1 — PH-1 ran\n");
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    runHook({ hookEventName: "PreToolUse", cwd: dir, toolCall: { id, name, args } });
  const frozen = call("u1", "edit_file", {
    Path: rb,
    Target: "PH-1 — copy",
    Replacement: "PH-1 — move",
  });
  assert.equal(frozen["decision"], "deny");
  assert.match(String(frozen["reason"]), /frozen/);
  const rewrite = call("u2", "edit_file", {
    Path: log,
    Target: "EX-1 — PH-1 ran",
    Replacement: "EX-1 — skipped",
  });
  assert.equal(rewrite["decision"], "deny");
  const append = call("u3", "write_file", {
    Path: log,
    Content: "EX-2 — PH-2 ran\n",
    Append: true,
  });
  assert.equal(append["decision"], "allow", String(append["reason"]));
  // A relative Path's Append prefix is read from the payload's cwd, not the hook's.
  const relative = runHook(
    {
      hookEventName: "PreToolUse",
      cwd: dir,
      toolCall: {
        id: "u4",
        name: "write_file",
        args: { Path: "docs/runbook/1_db/rb.md", Content: "PH-2 — drop\n", Append: true },
      },
    },
    { cwd: "/tmp" },
  );
  assert.equal(relative["decision"], "deny");
  assert.match(String(relative["reason"]), /frozen/);
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

test("PreToolUse read_file: a @ plan path in the user input resolves in the session's directory", () => {
  const dir = repo(tmp("dev-agy-path"));
  const spec = path.join(dir, "docs/plans/12_path/pr1.spec.md");
  write(
    spec,
    planText(
      {
        Issue: "#12",
        Type: "feature",
        Status: "planning",
        Spec: "-",
        Tip: "-",
        Base: "main",
        Branch: "feat/path",
      },
      [
        "## Goal",
        "g",
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
  const read = (input: string) =>
    runHook({
      hookEventName: "PreToolUse",
      cwd: dir,
      lastUserInput: input,
      toolCall: {
        id: "p1",
        name: "read_file",
        args: { Path: path.join(PLUGIN, "skills/review-feature/SKILL.md") },
      },
    });

  // The gate resolves the mention itself; the orchestrator bypass does not apply, since the input
  // names a plan.
  const allow = read("/dev:review-feature @docs/plans/12_path/pr1.spec.md");
  assert.equal(allow["decision"], "allow", JSON.stringify(allow));
  assert.equal(read("/dev:review-feature @./docs/plans/12_path/pr1.spec.md")["decision"], "allow");

  const missing = read("/dev:review-feature @docs/plans/12_path/pr9.spec.md");
  assert.equal(missing["decision"], "deny", JSON.stringify(missing));
  assert.match(String(missing["reason"]), /not found/);

  const bare = read("/dev:review-feature docs/plans/12_path/pr1.spec.md");
  assert.equal(bare["decision"], "deny", "a relative path without @ does not resolve");
  assert.match(String(bare["reason"]), /none was named|not found/);
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

  // Multi-plan / multi-stack: lastUserInput names pr1.spec.md while another plan is runnable,
  // or invokes bare run-stack / autopilot when a runnable plan exists.
  const pr2 = path.join(dir, "docs/plans/37089_other/pr1.spec.md");
  write(
    pr2,
    planText(
      {
        Issue: "#37089",
        Type: "fix",
        Status: "planning",
        Spec: "-",
        Tip: "-",
        Base: "main",
        Branch: "fix-37089",
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
  // Mark pr2 Spec as current so execute-feature gate passes on it.
  const reviewRes = exec([...BUN, path.join(PLUGIN, "bin/dev-stack.ts"), "review", pr2, "ready"], {
    cwd: dir,
  });
  assert.equal(reviewRes.code, 0, reviewRes.all);
  const claimRes = exec([...BUN, path.join(PLUGIN, "bin/dev-stack.ts"), "autopilot", pr2], {
    cwd: dir,
  });
  assert.equal(claimRes.code, 0, claimRes.all);
  const approveRes = exec([...BUN, path.join(PLUGIN, "bin/dev-stack.ts"), "approve", pr2], {
    cwd: dir,
  });
  assert.equal(approveRes.code, 0, approveRes.all);

  for (const [input, skill] of [
    [`/dev:run-stack ${spec}`, "review-feature"],
    [`run-stack ${spec}`, "execute-feature"],
    ["autopilot issue 37088", "execute-feature"],
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

  // Orchestrator input still denies a phase when no plan is at its entry status.
  const noReviewedDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "/dev:autopilot issue 37088",
    toolCall: {
      id: "s4b",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/create-pr/SKILL.md") },
    },
  });
  assert.equal(noReviewedDeny["decision"], "deny", JSON.stringify(noReviewedDeny));

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

  const subagentReviewCodeDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "",
    toolCall: {
      id: "s7",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-code/SKILL.md") },
    },
  });
  assert.equal(subagentReviewCodeDeny["decision"], "deny", JSON.stringify(subagentReviewCodeDeny));

  // Explicit wrong-status plan mention (slash command or prose, with or without the phase name)
  // is denied even when another plan is runnable.
  for (const input of [
    `/dev:execute-feature ${spec}`,
    `please execute-feature on ${spec}`,
    `implement ${spec}`,
    `finished ${spec}, continue with the stack`,
  ]) {
    const explicitDeny = runHook({
      hookEventName: "PreToolUse",
      cwd: dir,
      lastUserInput: input,
      toolCall: {
        id: "s8",
        name: "read_file",
        args: { Path: path.join(PLUGIN, "skills/execute-feature/SKILL.md") },
      },
    });
    assert.equal(explicitDeny["decision"], "deny", `${input}: ${JSON.stringify(explicitDeny)}`);
  }

  // Assistant message naming a wrong-status plan is denied even without the phase name.
  const assistantWrongDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "continue with the stack",
    lastAssistantMessage: `Working on ${spec}`,
    toolCall: {
      id: "s8b",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/execute-feature/SKILL.md") },
    },
  });
  assert.equal(assistantWrongDeny["decision"], "deny", JSON.stringify(assistantWrongDeny));

  // Assistant message naming a runnable plan takes precedence over lastUserInput.
  const assistantOverride = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: `finished ${spec}, continue with the stack`,
    lastAssistantMessage: `Starting execute-feature on ${pr2}`,
    toolCall: {
      id: "s9",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/execute-feature/SKILL.md") },
    },
  });
  assert.equal(assistantOverride["decision"], "allow", JSON.stringify(assistantOverride));

  // A current ready plan awaiting approval does not unlock review-feature, while a stale ready
  // plan (edited after review) does.
  const readyReview = exec(
    [...BUN, path.join(PLUGIN, "bin/dev-stack.ts"), "review", spec, "ready"],
    {
      cwd: dir,
    },
  );
  assert.equal(readyReview.code, 0, readyReview.all);
  const currentReadyDeny = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "",
    toolCall: {
      id: "s10",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-feature/SKILL.md") },
    },
  });
  assert.equal(currentReadyDeny["decision"], "deny", JSON.stringify(currentReadyDeny));

  write(spec, `${read(spec)}\n# edited\n`);
  const staleReadyAllow = runHook({
    hookEventName: "PreToolUse",
    cwd: dir,
    lastUserInput: "",
    toolCall: {
      id: "s11",
      name: "read_file",
      args: { Path: path.join(PLUGIN, "skills/review-feature/SKILL.md") },
    },
  });
  assert.equal(staleReadyAllow["decision"], "allow", JSON.stringify(staleReadyAllow));
});

test("PostToolUse restores unauthorized plan edits from PreToolUse snapshot and PostInvocation reports it", () => {
  const dir = repo(tmp("dev-agy-post"));
  const spec = path.join(dir, "docs/plans/1_test/pr1.spec.md");
  const original = planText({ Status: "ready", Base: "main", Branch: "p1", PR: "none" });
  write(spec, original);
  const convId = `conv-${Date.now()}`;

  const pre = runHook({
    hookEventName: "PreToolUse",
    conversationId: convId,
    cwd: dir,
    toolCall: { id: "b1", name: "run_command", args: { CommandLine: "echo tamper" } },
  });
  assert.equal(pre["decision"], "allow");

  write(spec, planText({ Status: "approved", Base: "main", Branch: "p1", PR: "none" }));
  const post = runHook({
    hookEventName: "PostToolUse",
    conversationId: convId,
    cwd: dir,
    toolCall: { id: "b1", name: "run_command", args: { CommandLine: "echo tamper" } },
  });
  assert.deepEqual(post, {});
  assert.equal(read(spec), original);

  const postInv = runHook({
    hookEventName: "PostInvocation",
    conversationId: convId,
    cwd: dir,
  });
  const steps = postInv["injectSteps"] as Array<{ systemMessage?: { systemMessage?: string } }>;
  assert.equal(steps?.length, 1);
  assert.match(steps[0]?.systemMessage?.systemMessage ?? "", /Restored from before the command/);

  // Drained after reporting once.
  const postInvAgain = runHook({
    hookEventName: "PostInvocation",
    conversationId: convId,
    cwd: dir,
  });
  assert.deepEqual(postInvAgain, {});
});

test("malformed stdin fails open with decision allow", () => {
  const out = runHook("{not-json");
  assert.equal(out["decision"], "allow");
});

test("scripts/build.ts --agy builds a valid Antigravity bundle", () => {
  const out = path.join(tmp("dev-agy-dist"), "dev-agy");
  const r = exec([...BUN, path.join(ROOT, "scripts/build.ts"), "--agy", "--out", out]);
  assert.equal(r.code, 0, r.all);

  assert.ok(fs.existsSync(path.join(out, "plugin.json")));
  assert.ok(fs.existsSync(path.join(out, "hooks.json")));
  assert.ok(fs.existsSync(path.join(out, "bin/agy-hook.js")));

  const skill = read(path.join(out, "skills/design-feature/SKILL.md"));
  assert.match(skill, /^model: gemini-4-neon-medium$/m);
  assert.doesNotMatch(skill, /Antigravity Delegation/);

  const reviewCode = read(path.join(out, "skills/review-code/SKILL.md"));
  assert.match(reviewCode, /^model: gemini-4-hydrogen-high$/m);

  for (const orch of ["autopilot", "run-stack"]) {
    const text = read(path.join(out, `skills/${orch}/SKILL.md`));
    assert.match(text, /^## Antigravity Delegation \(`swarm` default\)$/m, orch);
    assert.doesNotMatch(text, /\(not `swarm`\)/, orch);
  }

  const agent = read(path.join(out, "agents/planner.md"));
  assert.match(
    agent,
    /^tools:\n {2}- read_file\n {2}- run_command\n {2}- manage_task\n {2}- edit_file\n {2}- write_file\nsubagent: true\nmainAgent: false$/m,
  );
  assert.doesNotMatch(agent, /^ {2}- (Read|Grep|Glob|Bash|Skill|Edit|Write)$/m);

  const reviewer = read(path.join(out, "agents/reviewer.md"));
  assert.match(
    reviewer,
    /^tools:\n {2}- read_file\n {2}- run_command\n {2}- manage_task\n {2}- edit_file\n {2}- write_file\n {2}- invoke_subagent\n {2}- send_message\n {2}- manage_subagents\n {2}- swarm\nsubagent: true\nmainAgent: false$/m,
  );

  const rule = read(path.join(out, "rules/CORE.md"));
  assert.ok(rule.startsWith("---\ntrigger: manual\n---\n"));
});
