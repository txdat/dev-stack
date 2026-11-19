// The gate (core/gate-check.ts) against scratch repositories: block and pass cases for each phase
// gate, the hook input shapes, and the record guard. Calls run in-process; a few run bin/hook.ts
// to check the JSON Claude Code reads.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { b } from "../plugins/dev/core/bytes.ts";
import { byteEnv } from "../plugins/dev/core/cli.ts";
import { gateCheck } from "../plugins/dev/core/gate-check.ts";
import type { HookInput } from "../plugins/dev/core/hook-input.ts";
import { PlanLib } from "../plugins/dev/core/plan-lib.ts";
import { devStack } from "../plugins/dev/core/stack.ts";
import {
  cli,
  design,
  type Env,
  exec,
  gate,
  git,
  PLUGIN,
  RUN,
  read,
  run,
  tmp,
  withEnv,
  write,
} from "./helpers.ts";

const TMP = tmp("gate-check-test");
const WTROOT = `${TMP}/worktrees`;
const ENV = { AI_WORKTREES_ROOT: WTROOT };
const DS = `${RUN} '${PLUGIN}/bin/dev-stack.ts'`;

let repo = "";
let PD = "";
let P = "";
let BE = "";
let FE = "";

/** A fresh repository, its plans directory, and plan paths: P alone in its stack, and BE with FE stacked on it. */
const useRepo = () => {
  repo = fs.mkdtempSync(`${TMP}/repo.`);
  git(repo, "init", "-q", "-b", "main");
  write(`${repo}/README.md`, "seed\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "seed");
  fs.appendFileSync(`${repo}/.git/info/exclude`, "/docs/plans/\n");
  PD = `${repo}/docs/plans`;
  P = `${PD}/12_gate/pr1.spec.md`;
  BE = `${PD}/12_orders/pr1.spec.md`;
  FE = `${PD}/12_orders/pr2.spec.md`;
};

// Parser fixture, not an authoring exemplar: the gate reads only IDs and fields, so the prose is
// filler that keeps the graph closed.
const VALID = `## Acceptance Criteria
AC-1 — the gate blocks an unapproved plan
  Source: user requirement
  Success: execution is refused
  Failure: execution proceeds

## Test Cases
TC-1 — unapproved plan reaches execute-feature
  Proves: AC-1
  Fixture: a plan at Status: planning
  Action: execute-feature is invoked
  Expected: the hook blocks

## Implementation Steps
ST-1 — add the status gate — satisfies TC-1`;

const AC_FIELDS = "  Source: requirement\n  Success: it holds\n  Failure: it does not";
const TC_FIELDS = "  Fixture: a plan\n  Action: the phase runs\n  Expected: the result";

/** graph with each AC and TC declaration followed by its schema fields, for ID-only cases. */
const withFields = (graph: string) =>
  graph.replace(
    /^([-*] )?(AC|TC)-[0-9]+ — .*$/gm,
    (line, _b, p) => `${line}\n${p === "AC" ? AC_FIELDS : TC_FIELDS}`,
  );

/** A closed graph of n ACs, one TC and one step each. */
const graphN = (n: number) => {
  const r = (f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("");
  return `## Acceptance Criteria\n${r((i) => `AC-${i} — outcome ${i}\n${AC_FIELDS}\n`)}## Test Cases\n${r(
    (i) => `TC-${i} — scenario ${i}\n  Proves: AC-${i}\n${TC_FIELDS}\n`,
  )}## Implementation Steps\n${r((i) => `ST-${i} — do ${i} — satisfies TC-${i}\n`)}`.replace(
    /\n$/,
    "",
  );
};

const lib = () =>
  new PlanLib(b(repo), { cwd: b(repo), env: { HOME: b(TMP), AI_WORKTREES_ROOT: b(WTROOT) } });
const edit = (file: string, f: (text: string) => string) => write(file, f(read(file)));
const sub = (file: string, re: RegExp, by: string) => edit(file, (t) => t.replace(re, by));
const insertAfter = (file: string, re: RegExp, line: string) =>
  edit(file, (t) => t.replace(re, (m) => `${m}\n${line}`));
/** sed's `2i <lines>`. */
const insertAtLine2 = (file: string, lines: string) =>
  edit(file, (t) => {
    const rows = t.split("\n");
    rows.splice(1, 0, lines);
    return rows.join("\n");
  });
const hasLine = (file: string, line: string) => read(file).split("\n").includes(line);
const sha = (ref: string, cwd = repo) => git(cwd, "rev-parse", ref);

/** A current Spec hash for a plan, as dev-stack.ts review writes it. */
const ready = (file: string) => {
  const hash = lib().planHash(b(file)) ?? "none";
  sub(file, /^Spec: .*$/m, `Spec: ${hash}`);
};

/** The stack log line dev-stack.ts code-review writes for a passing review-code verdict at sha. */
const logPass = (plan: string, at: string) =>
  fs.appendFileSync(
    `${path.dirname(plan)}/log`,
    `pr${path.basename(plan, ".spec.md").replace("pr", "")}: code-review pass (1/3) at ${at}\n`,
  );

/**
 * A plan fixture. A bare `reviewed` gets the repository's HEAD as its Tip; `reviewed <sha>` gets
 * <sha>. A reviewed plan gets a logged review-code pass at its Tip.
 */
const writePlan = (
  file: string,
  status: string,
  graph = VALID,
  type = "feature",
  issue = "#12",
  extra = "",
  branch = "feat/gate",
) => {
  let s = status === "reviewed" ? `reviewed ${sha("HEAD")}` : status;
  let tip = "-";
  if (s.startsWith("reviewed ")) {
    tip = s.slice("reviewed ".length);
    s = "reviewed";
  }
  write(
    file,
    `# Gate test\nStatus: ${s}\nSpec: -\nTip: ${tip}\nType: ${type}\nBase: main\nBranch: ${branch}\nIssue: ${issue}\n${
      extra ? `${extra}\n` : ""
    }\n## Goal\nGate the phases.\n\n${graph}\n`,
  );
  if (tip !== "-") logPass(file, tip);
};

/** The path the gate looks for a plan's own worktree at. */
const wtOf = (plan: string) =>
  `${WTROOT}/${path.basename(repo)}-${path.basename(path.dirname(plan))}-pr${path
    .basename(plan, ".spec.md")
    .replace("pr", "")}`;

const wtCommit = (wt: string, subject: string, ...files: string[]) => {
  for (const f of files) {
    fs.mkdirSync(path.dirname(`${wt}/${f}`), { recursive: true });
    fs.appendFileSync(`${wt}/${f}`, "x\n");
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", subject);
};

/** P with its worktree on feat/gate; a reviewed plan carries its proof commits and the tip. */
const planWithWorktree = (status: string, graph = VALID, type = "feature") => {
  const wt = wtOf(P);
  git(repo, "worktree", "add", "-q", "-b", "feat/gate", wt, "main");
  let s = status;
  if (s === "reviewed") {
    wtCommit(wt, "test(red): gate", "tests/gate_test.py");
    wtCommit(wt, "feat(gate): implement", "src/gate.py");
    s = `reviewed ${sha("feat/gate")}`;
  }
  writePlan(P, s, graph, type);
};

/** The Tip SHA of a plan when it is reviewed, or "". */
const greenIn = (plan: string) =>
  hasLine(plan, "Status: reviewed") ? (/^Tip: ([0-9a-f]*)$/m.exec(read(plan))?.[1] ?? "") : "";

/** Status reviewed with Tip sha, or none. */
const setReviewed = (plan: string, at = "") => {
  edit(plan, (t) =>
    t.replace(/^Status: .*$/m, "Status: reviewed").replace(/^Tip: .*$/m, `Tip: ${at || "-"}`),
  );
  if (at) logPass(plan, at);
};

/** A proof on top of a commit: a test(red) commit, then an implementation. */
const proofOn = (base: string) => {
  const tree = sha(`${base}^{tree}`);
  const red = git(repo, "commit-tree", tree, "-p", base, "-m", "test(red): proof");
  return git(repo, "commit-tree", tree, "-p", red, "-m", "feat: proof");
};

/**
 * The gate for a skill on args in cwd. Fixtures edit specs freely, so each plan past planning first
 * gets a current ready Spec, unless staleOk keeps its records as they are.
 */
const runGate = (
  cwd: string,
  skill: string,
  args: string,
  opts: { staleOk?: boolean; env?: Env } = {},
) => {
  if (!opts.staleOk) {
    const r = exec(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (r.code === 0) {
      const plans = `${r.out.trim().replace(/\/\.git$/, "")}/docs/plans`;
      for (const d of fs.existsSync(plans) ? fs.readdirSync(plans) : [])
        for (const f of fs.existsSync(`${plans}/${d}`) && fs.statSync(`${plans}/${d}`).isDirectory()
          ? fs.readdirSync(`${plans}/${d}`)
          : []) {
          const file = `${plans}/${d}/${f}`;
          if (
            !/^pr.*\.spec\.md$/.test(f) ||
            fs.lstatSync(file).isSymbolicLink() ||
            !fs.statSync(file).isFile()
          )
            continue;
          if (!/^Status: planning/m.test(/^Status:.*$/m.exec(read(file))?.[0] ?? "")) ready(file);
        }
    }
  }
  return gate(
    { tool_input: { skill: skill.replace("dev-", "dev:"), args } },
    { cwd, env: { ...ENV, ...opts.env } },
  );
};
const promptGate = (cwd: string, prompt: string) =>
  gate({ hook_event_name: "UserPromptSubmit", prompt }, { cwd, env: ENV });
const call = (input: HookInput) => gate(input, { cwd: repo, env: ENV });

const passes = (out: string, label: string) => assert.equal(out, "", label);
const blocks = (out: string, want: string, label: string) =>
  assert.ok(
    out !== "" && out.includes(want),
    `${label}: expected '${want}' in: ${out || "(pass)"}`,
  );

/** A planning plan with a graph at review-feature: a block naming `want`, or a pass when want is "". */
const reviewGraph = (label: string, graph: string, want: string) => {
  useRepo();
  writePlan(P, "planning", graph);
  const out = runGate(repo, "dev-review-feature", P);
  if (want) blocks(out, want, label);
  else passes(out, label);
};

const stack = (...argv: string[]) => {
  const r = run(devStack, argv, { cwd: repo, env: ENV });
  assert.equal(r.code, 0, `dev-stack ${argv.join(" ")}: ${r.all}`);
};

test("plan resolution", () => {
  useRepo();
  writePlan(P, "approved");
  blocks(
    runGate(repo, "dev-execute-feature", ""),
    "none was named",
    "a lone plan is not adopted without a path",
  );
  blocks(runGate(repo, "dev-execute-feature", "gate"), "none was named", "a slug does not resolve");
  passes(runGate(repo, "dev-execute-feature", P), "an exact path resolves");
  write(`${repo}/.git/info/exclude`, "");
  blocks(
    runGate(repo, "dev-execute-feature", P),
    "does not ignore docs/plans",
    "a plan Git does not ignore blocks",
  );
  write(`${repo}/.git/info/exclude`, "/docs/plans/\n");
  passes(
    runGate(repo, "dev-execute-feature", `@${P}, please`),
    "surrounding punctuation is not part of the path",
  );
  passes(
    runGate(repo, "dev-execute-feature", "@docs/plans/12_gate/pr1.spec.md"),
    "a @ file mention resolves in the caller's directory",
  );
  passes(
    runGate(`${repo}/docs`, "dev-execute-feature", "@plans/12_gate/pr1.spec.md"),
    "a @ file mention from a subdirectory",
  );
  passes(
    runGate(`${repo}/docs`, "dev-execute-feature", "@./plans/12_gate/pr1.spec.md"),
    "a @ file mention written with ./",
  );
  blocks(
    runGate(repo, "dev-execute-feature", "@12_gate/pr1.spec.md"),
    "not found",
    "a @ file mention does not resolve in the plans directory",
  );
  blocks(
    runGate(repo, "dev-execute-feature", "@docs/plans/12_gate/pr9.spec.md"),
    `not found: ${repo}/docs/plans/12_gate/pr9.spec.md`,
    "a mistyped @ file mention blocks beside nothing",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${P} @docs/plans/12_gate/pr9.spec.md`),
    "takes one plan path",
    "a @ file mention beside an exact path is a second plan path",
  );
  passes(
    runGate(repo, "dev-execute-feature", `${P} user@host/12_gate/pr1.spec.md`),
    "an email's @ does not make a file mention",
  );
  passes(
    runGate(
      repo,
      "dev-execute-feature",
      `~/${path.basename(repo)}/docs/plans/12_gate/pr1.spec.md`,
      {
        env: { HOME: TMP },
      },
    ),
    "a path starting with ~ resolves",
  );
  blocks(
    runGate(repo, "dev-execute-feature", "12_gate/pr1.spec.md"),
    "not found",
    "a relative path does not resolve",
  );
  passes(
    runGate(
      repo,
      "dev-execute-feature",
      `${P}\nNext: 12_gate/pr2.spec.md, after 12_gate/pr1.spec.md`,
    ),
    "a relative mention beside an exact path is ignored",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${P} /other/repo/12_gate/pr1.spec.md`),
    "not found: /other/repo/12_gate/pr1.spec.md",
    "an absolute path that does not resolve blocks beside one that does",
  );
  blocks(
    runGate(repo, "dev-execute-feature", "/other/repo/12_gate/pr1.spec.md"),
    "not found",
    "outside docs/plans",
  );
  const other = `${TMP}/other/docs/plans/12_gate/pr1.spec.md`;
  writePlan(other, "approved");
  blocks(
    runGate(repo, "dev-execute-feature", other),
    "not found",
    "another repository's plan does not resolve",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/../../../other/docs/plans/12_gate/pr1.spec.md`),
    "not found",
    "traversal out of the repository plans does not resolve",
  );
  writePlan(`${PD}/12_gate/nested/pr1.spec.md`, "approved");
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/12_gate/nested/pr1.spec.md`),
    "not found",
    "a nested path",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/12_gate/pr9.spec.md`),
    `not found: ${PD}/12_gate/pr9.spec.md`,
    "a mistyped path blocks",
  );
  writePlan(
    `${PD}/12_gate/pr2.spec.md`,
    "approved",
    VALID,
    "feature",
    "#12",
    "Stacks On: pr1",
    "feat/gate-2",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${P} ${PD}/12_gate/pr2.spec.md`),
    "takes one plan path",
    "two plans",
  );
  writePlan(`${PD}/12_gate/gate.md`, "approved");
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/12_gate/gate.md`),
    "none was named",
    "a .md plan without .spec",
  );
  writePlan(`${PD}/gate/pr1.spec.md`, "approved");
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/gate/pr1.spec.md`),
    "Pass the full path of an existing",
    "a directory outside <issue>_<slug> blocks",
  );
  fs.symlinkSync("pr1.spec.md", `${PD}/12_gate/pr5.spec.md`);
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/12_gate/pr5.spec.md`),
    "is a symlink",
    "a symlinked plan",
  );

  useRepo();
  writePlan(P, "published");
  blocks(
    runGate(repo, "dev-execute-feature", P),
    "is published; no phase resumes it",
    "a published plan is a record",
  );
  writePlan(`${PD}/12_shipped/pr1.spec.md`, "published");
  writePlan(P, "approved");
  passes(runGate(repo, "dev-execute-feature", P), "a published plan in another directory is inert");
});

test("hook input shapes", () => {
  useRepo();
  writePlan(P, "approved");
  ready(P);
  blocks(
    call({
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "dev-review-feature", arguments: P },
    }),
    "already approved",
    "the Pi arguments shape resolves the plan",
  );
  for (const prompt of [
    `/dev-review-feature ${P}`,
    `/dev-review-feature, ${P}`,
    `/Dev-review-feature ${P}`,
  ])
    blocks(promptGate(repo, prompt), "already approved", prompt);
  const typed = cli("hook", [], {
    cwd: repo,
    env: ENV,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: `/dev-review-feature ${P}`,
    }),
  });
  const v = JSON.parse(typed.out);
  assert.equal(v.decision, "block");
  assert.equal(
    v.hookSpecificOutput,
    undefined,
    "a UserPromptSubmit block carries no PreToolUse output",
  );
  // bin/hook.ts, the program Claude Code runs, resolves a @ file mention in the caller's directory.
  const atHook = (mention: string) =>
    JSON.parse(
      cli("hook", [], {
        cwd: repo,
        env: ENV,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: `/dev-review-feature ${mention}`,
        }),
      }).out,
    ) as { decision?: string; reason?: string };
  const atResolved = atHook("@docs/plans/12_gate/pr1.spec.md");
  assert.equal(atResolved.decision, "block");
  assert.match(atResolved.reason ?? "", /already approved/, "the @ mention resolved to the plan");
  const atMissing = atHook("@docs/plans/12_gate/pr9.spec.md");
  assert.equal(atMissing.decision, "block");
  assert.match(atMissing.reason ?? "", /not found/, "a @ mention that does not resolve blocks");
  blocks(
    promptGate(repo, `/skill:review-feature ${P}`),
    "already approved",
    "Pi's expanded skill command is gated",
  );
  blocks(
    promptGate(repo, `/Skill:review-feature, ${P}`),
    "already approved",
    "regardless of case and punctuation",
  );
  blocks(
    promptGate(repo, `/dev:review-feature ${P}`),
    "already approved",
    "Claude's plugin skill command is gated",
  );
  blocks(
    call({
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "dev:review-feature", args: P },
    }),
    "already approved",
    "a dev:<name> Skill call is gated",
  );
  passes(
    promptGate(repo, `run /skill:review-feature ${P}`),
    "a skill command not at the start is not gated",
  );
  blocks(
    promptGate(repo, "/dev-execute-feature"),
    "none was named",
    "a typed phase without a path blocks",
  );
  passes(
    promptGate(repo, `please review-feature ${P} later`),
    "prose that mentions a skill is not gated",
  );
  passes(
    promptGate(repo, "explain /dev-review-feature to me"),
    "a slash command not at the start is not gated",
  );
  for (const prompt of [`/DEV:Review-Feature ${P}`, `/Skill:REVIEW-feature ${P}`])
    blocks(
      promptGate(repo, prompt),
      "already approved",
      `${prompt.split(" ")[0]} is gated in any case`,
    );
  for (const prompt of [`/dev-review-codebase ${P}`, `/dev:create-pr-draft ${P}`])
    passes(promptGate(repo, prompt), `${prompt.split(" ")[0]} is a longer name, not a phase`);
  for (const skill of ["dev:review-feature-notes", "x:review-code", "review-feature-notes"])
    passes(
      call({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill, args: P } }),
      `a Skill call to ${skill}, not this plugin's, is not gated`,
    );
  // Claude Code resolves a bare skill name to this plugin's skill, as the agents and run-stack
  // invoke a phase.
  for (const skill of ["review-feature", "Review_Feature", " /review-feature "])
    blocks(
      call({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill, args: P } }),
      "already approved",
      `a Skill call to the bare name '${skill}' is gated`,
    );
  passes(
    call({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { skill: "review-feature", args: P },
    }),
    "a bare phase name outside the Skill tool is not an invocation",
  );
  for (const prompt of [`/review-feature ${P}`, `/create-pr ${P}`, `/other:review-code ${P}`])
    passes(promptGate(repo, prompt), `${prompt.split(" ")[0]}, not this plugin's, is not gated`);
  passes(
    call({
      hook_event_name: "PreToolUse",
      tool_name: "run_shell_command",
      tool_input: { command: 'git commit -m "dev-review-code notes"' },
    }),
    "a shell command that mentions a dev skill is not an invocation",
  );
  blocks(
    call({
      hook_event_name: "PreToolUse",
      tool_name: "SlashCommand",
      tool_input: { command: `/dev-review-feature ${P}` },
    }),
    "already approved",
    "a slash command in a command field is gated",
  );
  const nogit = fs.mkdtempSync(`${TMP}/nogit.`);
  passes(
    promptGate(nogit, "/dev-explore where is auth handled"),
    "an ungated skill runs outside a Git repository",
  );
  passes(
    runGate(repo, "dev-fix-bug", `crash mentioned in ${P}`),
    "fix-bug is ungated even when it mentions a plan",
  );
});

test("a crash while checking a phase blocks", () => {
  useRepo();
  writePlan(P, "approved");
  ready(P);
  // An env whose reads throw fails inside the phase check, after the root resolves.
  const env = new Proxy(
    {},
    {
      get: () => {
        throw new Error("boom");
      },
    },
  );
  const ctx = { cwd: b(repo), env };
  const r = gateCheck({ tool_input: { skill: "dev:execute-feature", args: P } }, ctx);
  assert.ok(
    r !== undefined && "block" in r && r.block.includes("gate-check.js failed (boom)"),
    JSON.stringify(r),
  );
  // The record guard fails open: its error reaches the caller, which passes the call with a
  // warning, never a silent pass.
  assert.throws(
    () =>
      gateCheck(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "crash0",
          tool_input: { command: "true" },
        },
        ctx,
      ),
    /boom/,
  );
});

test("a post check that fails says so, and its snapshot is cleared", () => {
  useRepo();
  writePlan(P, "approved");
  const input = (event: string) => ({
    hook_event_name: event,
    tool_name: "Bash",
    tool_use_id: "crash1",
    tool_input: { command: "true" },
  });
  passes(call(input("PreToolUse")), "the snapshot is taken");
  // The snapshot directory resolves as before; the plan check then fails reading HOME.
  const real = byteEnv({ ...process.env, ...ENV });
  const env = new Proxy(real, {
    get: (t, k: string) => {
      if (k === "HOME") throw new Error("boom");
      return t[k];
    },
  });
  const r = gateCheck(input("PostToolUse"), { cwd: b(repo), env });
  assert.ok(
    r !== undefined && "postBlock" in r && r.postBlock.includes("failed (boom)"),
    JSON.stringify(r),
  );
  assert.equal(
    call(input("PostToolUse")),
    "",
    "the snapshot was cleared, so nothing compares again",
  );
});

test("nested Pi call ids keep their own snapshots", () => {
  useRepo();
  writePlan(P, "approved");
  const approved = read(P);
  const rollback = `sed -i 's/^Status: approved/Status: planning/' ${P}`;
  const bash = (event: string, id: string) =>
    call({
      hook_event_name: event,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: rollback },
    });
  // "X/1/1" and "X/11" read alike once "/" is dropped; the second snapshot, taken after the
  // rollback, would then stand in for the first.
  passes(bash("PreToolUse", "X/1/1"), "first snapshot");
  exec(["bash", "-c", rollback], { cwd: repo });
  passes(bash("PreToolUse", "X/11"), "second snapshot, after the rollback");
  passes(bash("PostToolUse", "X/11"), "the second call changed nothing");
  blocks(
    bash("PostToolUse", "X/1/1"),
    "never returns below approved",
    "the first call still has its own snapshot",
  );
  assert.equal(read(P), approved);
});

test("unchanged plans share a write-once snapshot store entry", async () => {
  useRepo();
  writePlan(P, "published");
  const published = read(P);
  const rewrite = `sed -i 's/^# Gate test/# Rewritten/' ${P}`;
  const bash = (event: string, id: string) =>
    call({
      hook_event_name: event,
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: rewrite },
    });
  const runtime = process.env["XDG_RUNTIME_DIR"] || process.env["TMPDIR"] || "/tmp";
  const snapOf = (id: string) =>
    fs.statSync(`${runtime}/dev-gate-check-${process.getuid?.()}/${id}/files/12_gate/pr1.spec.md`);
  const tag = Math.random().toString(36).slice(2);
  // A plan changed within the timestamp margin may change again at the same ctime: it is copied.
  passes(bash("PreToolUse", `racy${tag}`), "racy snapshot");
  assert.equal(snapOf(`racy${tag}`).nlink, 1, "a racy plan is copied, not stored");
  passes(bash("PostToolUse", `racy${tag}`), "nothing changed");
  await new Promise((r) => setTimeout(r, 2100));
  passes(bash("PreToolUse", `a${tag}`), "first snapshot stores the plan");
  passes(bash("PreToolUse", `b${tag}`), "second snapshot links the stored entry");
  assert.equal(snapOf(`a${tag}`).ino, snapOf(`b${tag}`).ino, "both link one entry");
  exec(["bash", "-c", rewrite], { cwd: repo });
  passes(bash("PreToolUse", `c${tag}`), "a snapshot after the rewrite");
  assert.notEqual(snapOf(`c${tag}`).ino, snapOf(`a${tag}`).ino, "a changed plan is copied anew");
  passes(bash("PostToolUse", `c${tag}`), "nothing changed since the third snapshot");
  blocks(bash("PostToolUse", `a${tag}`), "it is published and changed", "the first call");
  assert.equal(read(P), published, "restored from the stored bytes");
  passes(bash("PostToolUse", `b${tag}`), "already restored");
});

test("worktree and root", () => {
  useRepo();
  writePlan(P, "implemented");
  fs.mkdirSync(wtOf(P), { recursive: true });
  blocks(
    runGate(repo, "dev-review-code", P),
    `Plan ${P} has no worktree at ${wtOf(P)}`,
    "an unregistered directory at the worktree path is no worktree",
  );
  writePlan(P, `reviewed ${sha("HEAD")}`);
  blocks(
    runGate(repo, "dev-create-pr", P),
    "rerun dev-publish.js cleanup",
    "a missing worktree points to cleanup",
  );

  useRepo();
  planWithWorktree("reviewed");
  const wt = wtOf(P);
  passes(runGate(repo, "dev-create-pr", P), "a reviewed plan with a worktree enters create-pr");
  passes(runGate(wt, "dev-create-pr", P), "from a worktree, the main repository's plans resolve");
  const shim = fs.mkdtempSync(`${TMP}/gitshim.`);
  const realGit = exec(["sh", "-c", "command -v git"]).out.trim();
  write(
    `${shim}/git`,
    `#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a.some((x, i) => x === "worktree" && a[i + 1] === "list")) process.exit(1);
const r = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, a, { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
  fs.chmodSync(`${shim}/git`, 0o755);
  const out = withEnv({ PATH: `${shim}:${process.env["PATH"]}` }, () =>
    runGate(wt, "dev-execute-feature", P),
  );
  blocks(
    out,
    "main working-tree root",
    "failed root discovery does not fall back to a linked worktree",
  );
});

test("review-feature", () => {
  useRepo();
  writePlan(P, "planning");
  passes(runGate(repo, "dev-review-feature", P), "a closed planning plan enters review-feature");
  writePlan(P, "approved");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "already approved",
    "an approved plan does not re-enter review",
  );
  writePlan(P, "implemented");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "too late for review-feature",
    "an implemented plan",
  );
  writePlan(`${PD}/0_gate/pr1.spec.md`, "planning", VALID, "feature", "none");
  passes(
    runGate(repo, "dev-review-feature", `${PD}/0_gate/pr1.spec.md`),
    "Issue: none with issue 0 enters review",
  );
  const cases: [issue: string, type: string, want: string][] = [
    ["none", "feature", "starts with 12, but the header has 'Issue: none'"],
    ["#13", "feature", "starts with 12, but the header has 'Issue: #13'"],
    ["#12abc", "feature", "write 'Issue: #<n>' or 'Issue: none'"],
    ["#12", "chore", "write feature, fix, refactor, or config"],
  ];
  for (const [issue, type, want] of cases) {
    writePlan(P, "planning", VALID, type, issue);
    blocks(runGate(repo, "dev-review-feature", P), want, want);
  }
  writePlan(P, "planning", VALID, "fix");
  passes(runGate(repo, "dev-review-feature", P), "the type lives in the header only");
  writePlan(P, "planning");
  sub(P, /^Base: main$/m, "Base:");
  blocks(runGate(repo, "dev-review-feature", P), "no Base branch", "review requires a Base");
  writePlan(P, "planning", VALID, "feature", "#12", "", "");
  blocks(runGate(repo, "dev-review-feature", P), "has 'Branch: '", "review requires a Branch");
  writePlan(P, "planning", VALID, "feature", "#12", "", "bad..branch");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "has 'Branch: bad..branch'",
    "review requires a valid Branch",
  );
  writePlan(P, "planning", VALID, "feature", "#12", "", "main");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "Branch is its Base, 'main'",
    "a plan's Branch is not its Base",
  );
});

test("ID shape", () => {
  reviewGraph("eight ACs enter review without a cap", graphN(8), "");
  const raw = (ac: string, tc: string, st: string, extra = "") =>
    `## Acceptance Criteria\n${ac}\n## Test Cases\n${tc}\n## Implementation Steps\n${st}${extra}`;
  const g = (ac: string, tc: string, st: string, extra = "") => withFields(raw(ac, tc, st, extra));
  const cases: [label: string, graph: string, want: string][] = [
    [
      "a bulleted plan resolves the same graph",
      g(
        "- AC-1 — outcome",
        "- TC-1 — scenario\n  - Proves: AC-1",
        "- ST-1 — action — satisfies TC-1",
      ),
      "",
    ],
    [
      "a template-verbatim plan enters review",
      `## Design Decisions
DD-1 — reject at the API so every client gets AC-1
  Options: API or UI | Choice: API, by the user | Why: one enforcement point
${raw(
  "AC-1 — an archived user cannot check out\n  Source: issue #12\n  Success: checkout returns 403\n  Failure: an order is created",
  "TC-1 — archived user checks out\n  Proves: AC-1\n  Fixture: user u1, archived, cart with one item\n  Action: POST /checkout as u1\n  Expected: 403 and no order row",
  'ST-1 — guard checkout in api/checkout.py — satisfies TC-1\n  PC-1 — checkout reads the user before writing — Check: rg -n "get_user" api/checkout.py',
)}`,
      "",
    ],
    [
      "an unindented Proves: still belongs to its TC",
      g("AC-1 — outcome", "TC-1 — scenario\nProves: AC-1", "ST-1 — action — satisfies TC-1"),
      "",
    ],
    [
      "an em-dash title naming another ID is not a range",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\nTC-2 — TC-1 variant with an empty cart\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1, TC-2",
      ),
      "",
    ],
    [
      "a numeric em-dash summary is not a range",
      g(
        "AC-1 — the endpoint returns 200",
        "TC-1 — 200 returned for a valid request\n  Proves: AC-1",
        "ST-1 — add the handler — satisfies TC-1",
      ),
      "",
    ],
    [
      "word-embedded tokens are not IDs",
      g(
        "AC-1 — the response carries UTC-7 offsets and an SHA-256 digest",
        "TC-1 — scenario\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1",
      ),
      "",
    ],
    [
      "fenced text is not parsed",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\n~~~text\nTC-9 sample output, docs/plans/be.md#AC-2\n~~~",
        "ST-1 — action — satisfies TC-1",
      ),
      "",
    ],
    [
      "an AC no TC proves blocks",
      g(
        "AC-1 — outcome\nAC-2 — second outcome",
        "TC-1 — scenario\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1",
      ),
      "AC-2 has no TC",
    ],
    [
      "a TC no step names blocks",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\nTC-2 — second\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1",
      ),
      "TC-2 is not satisfied by any Implementation Step",
    ],
    [
      "a step naming no TC blocks",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1\nST-2 — unrelated cleanup",
      ),
      "ST-2 has no satisfies clause naming a TC",
    ],
    [
      "a TC with no Proves: blocks",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\nTC-2 — scenario with no Proves line\n  Fixture: setup",
        "ST-1 — action — satisfies TC-1 and TC-2",
      ),
      "TC-2 has no Proves: line",
    ],
    [
      "an undeclared TC blocks",
      g("AC-1 — outcome", "TC-1 — scenario\n  Proves: AC-1", "ST-1 — action — satisfies TC-1/TC-9"),
      "cites TC-9, which is not declared",
    ],
    [
      "an undeclared decision blocks",
      g(
        "AC-1 — outcome per DD-2",
        "TC-1 — scenario\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1",
      ),
      "cites DD-2, which is not declared: no line in ## Design Decisions",
    ],
    [
      "a checkbox TC is not a declaration",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\n- [ ] TC-2 — scenario\n  Proves: AC-1",
        "ST-1 — action — satisfies TC-1, TC-2",
      ),
      "cites TC-2, which is not declared",
    ],
    ...["TC-1 through TC-4", "TC-1 to TC-4", "TC-1–9", "TC-1..TC-3"].map(
      (c): [string, string, string] => [
        `'${c}' is an unreadable range`,
        g("AC-1 — outcome", "TC-1 — scenario\n  Proves: AC-1", `ST-1 — action — satisfies ${c}`),
        "uses an ID range",
      ],
    ),
    [
      "a Proves: naming no AC is unreadable",
      g(
        "AC-1 — outcome",
        "TC-1 — scenario\n  Proves: the login AC",
        "ST-1 — action — satisfies TC-1",
      ),
      "unparseable Proves:",
    ],
    [
      "a TC proving two ACs is unreadable",
      g(
        "AC-1 — outcome\nAC-2 — outcome",
        "TC-1 — scenario\n  Proves: AC-1, AC-2",
        "ST-1 — action — satisfies TC-1",
      ),
      "exactly one is required",
    ],
    [
      "two Proves: lines are unreadable",
      g(
        "AC-1 — outcome\nAC-2 — outcome",
        "TC-1 — scenario\n  Proves: AC-1\n  Proves: AC-2",
        "ST-1 — action — satisfies TC-1",
      ),
      "more than one Proves:",
    ],
    ...["AC", "TC", "ST"].map((id): [string, string, string] => [
      `a duplicate ${id} is unreadable`,
      graphN(2).replace(`${id}-2`, `${id}-1`),
      "declared more than once",
    ]),
    ["a leading zero is unreadable", graphN(1).replaceAll("AC-1", "AC-01"), "leading zero"],
    ["an ID of zero is unreadable", graphN(1).replaceAll("AC-1", "AC-0"), "IDs start at 1"],
    ...["docs/plans/be.md#AC-2", "docs/plans/be#AC-2", "api/orders.yaml#DD-1"].map(
      (cite): [string, string, string] => [
        `'${cite}' cites another artifact`,
        `${graphN(1)}\n## Context\nRelies on ${cite}`,
        "cites another artifact's IDs",
      ],
    ),
    [
      "a satisfies clause on a continuation line counts",
      g("AC-1 — outcome", "TC-1 — scenario\n  Proves: AC-1", "ST-1 — do 1\n  satisfies TC-1"),
      "",
    ],
    [
      "a step that only mentions a TC in prose satisfies nothing",
      `${graphN(1)}\nST-2 — extend the TC-1 handler`,
      "ST-2 has no satisfies clause naming a TC",
    ],
    ["PR rows are not IDs", `${graphN(1)}\n## Notes\nPR-1 ships ST-1`, ""],
  ];
  for (const [label, graph, want] of cases) reviewGraph(label, graph, want);
});

test("schema fields: review-feature requires each AC, TC, and DD's fields", () => {
  const ac = "AC-1 — outcome";
  const tc = "TC-1 — scenario\n  Proves: AC-1";
  const st = "ST-1 — action — satisfies TC-1";
  const g = (a: string, t: string, dd = "") =>
    `${dd ? `## Design Decisions\n${dd}\n` : ""}## Acceptance Criteria\n${a}\n## Test Cases\n${t}\n## Implementation Steps\n${st}`;
  const fullAc = `${ac}\n${AC_FIELDS}`;
  const fullTc = `${tc}\n${TC_FIELDS}`;
  const cases: [label: string, graph: string, want: string][] = [
    [
      "an AC without Failure: blocks",
      g(`${ac}\n  Source: requirement\n  Success: it holds`, fullTc),
      "AC-1 (line 14) has no Failure:",
    ],
    [
      "a TC without Action: and Expected: blocks, naming both",
      g(fullAc, `${tc}\n  Fixture: a plan`),
      "TC-1 (line 19) has no Action:, Expected:",
    ],
    [
      "a field with an empty value does not count",
      g(fullAc, `${tc}\n  Fixture: a plan\n  Action: the phase runs\n  Expected:`),
      "TC-1 (line 19) has no Expected:",
    ],
    [
      "a field after an unindented prose line belongs to no item",
      g(
        fullAc,
        `${tc}\n  Fixture: a plan\n  Action: the phase runs\nSee the notes.\n  Expected: e`,
      ),
      "TC-1 (line 19) has no Expected:",
    ],
    [
      "a fenced field does not count",
      g(fullAc, `${tc}\n  Fixture: a plan\n  Action: the phase runs\n~~~\n  Expected: e\n~~~`),
      "TC-1 (line 19) has no Expected:",
    ],
    [
      "the next item's fields do not count for the one before",
      g(
        `${ac}\n${fullAc.replace("AC-1", "AC-2")}`,
        `${fullTc}\nTC-2 — second\n  Proves: AC-2\n${TC_FIELDS}`,
      ),
      "AC-1 (line 14) has no Source:, Success:, Failure:",
    ],
    [
      "a DD without Why: blocks with the one-line form",
      g(
        fullAc,
        fullTc,
        "DD-1 — reject at the API\n  Options: API or UI | Choice: API, by the user",
      ),
      'DD-1 (line 14) has no Why: — write "  Options: <considered> | Choice: <chosen, by whom> | Why: <rationale, derivation>"',
    ],
    [
      "DD fields on their own lines pass",
      g(
        fullAc,
        fullTc,
        "DD-1 — reject at the API\n  Options: API or UI\n  Choice: API, by the user\n  Why: one point",
      ),
      "",
    ],
    [
      "bulleted fields pass",
      g(
        `- ${ac}\n  - Source: requirement\n  - Success: it holds\n  - Failure: it does not`,
        `- ${tc}\n  - Fixture: a plan\n  - Action: the phase runs\n  - Expected: the result`,
      ),
      "",
    ],
  ];
  for (const [label, graph, want] of cases) reviewGraph(label, graph, want);

  // A plan approved before the field check keeps entering review-code.
  useRepo();
  planWithWorktree("implemented", g(ac, tc));
  const wt = wtOf(P);
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "feat(gate): implement", "src/gate.py");
  passes(runGate(repo, "dev-review-code", P), "review-code does not require the fields");
});

test("header keys: review-feature blocks a repeated header key", () => {
  useRepo();
  writePlan(P, "planning", VALID, "feature", "#12", "Status: approved");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "repeats header keys: 'Status' on lines 2 and 9",
    "a second Status line blocks",
  );
  writePlan(P, "planning", VALID, "feature", "#12", "Base: main\nType: fix");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "'Base' on lines 6 and 9; 'Type' on lines 5 and 10",
    "every repeated key is named",
  );
  writePlan(P, "planning", `${VALID}\n\n## Context\nStatus: shipped upstream`);
  passes(runGate(repo, "dev-review-feature", P), "a key-like line in the body is not a header key");
});

test("failing closed: invalid bytes reach a verdict", () => {
  useRepo();
  writePlan(P, "planning");
  fs.appendFileSync(P, Buffer.from([0xff, 0xfe, ...Buffer.from(" stray bytes\n")]));
  passes(runGate(repo, "dev-review-feature", P), "invalid bytes in a plan reach a verdict");
});

/** A repo with BE at one status and FE stacked on it at another. */
const feRepo = (be: string, fe: string) => {
  useRepo();
  writePlan(BE, be);
  writePlan(FE, fe, VALID, "feature", "#12", "Stacks On: pr1", "feat/fe");
};

test("Stacks On: a stacked plan waits for its parent", () => {
  feRepo("planning", "planning");
  blocks(
    runGate(repo, "dev-review-feature", FE),
    `Parent plan ${BE} is 'planning'; review-feature needs it 'approved' or later`,
    "review waits for the parent approval",
  );
  blocks(
    runGate(repo, "dev-review-feature", `${FE} ${BE}`),
    "takes one plan path",
    "naming the parent beside the plan",
  );
  passes(runGate(repo, "dev-review-feature", BE), "the root plan reviews on its own");
  feRepo("approved", "planning");
  passes(runGate(repo, "dev-review-feature", FE), "review enters once the parent is approved");
  sub(FE, /^Branch: feat\/fe$/m, "Branch: feat/gate");
  blocks(
    runGate(repo, "dev-review-feature", FE),
    "its PR targets its parent plan's branch, 'feat/gate'",
    "own branch",
  );
  sub(FE, /^Branch: feat\/gate$/m, "Branch: feat/fe");
  sub(FE, /^Base: main$/m, "Base: feat/gate");
  blocks(
    runGate(repo, "dev-review-feature", FE),
    "a stacked plan uses its parent's Base",
    "shares the parent Base",
  );
  sub(FE, /^Base: feat\/gate$/m, "Base: main");
  insertAfter(BE, /^Status:.*$/m, "Stacks On: pr2");
  blocks(
    runGate(repo, "dev-execute-feature", BE),
    "'Stacks On:' line that is misplaced, repeated, or malformed",
    "a plan stacks only on a lower number, so no cycle forms",
  );
  edit(BE, (t) => t.replace(/^Stacks On:.*\n/m, ""));
  writePlan(`${PD}/12_orders/pr3.spec.md`, "planning", VALID, "feature", "#12", "", "feat/other");
  blocks(
    runGate(repo, "dev-review-feature", FE),
    "holds 2 plans without a",
    "a directory holds one root",
  );
  fs.rmSync(`${PD}/12_orders/pr3.spec.md`);
  feRepo("implemented", "approved");
  blocks(
    runGate(repo, "dev-execute-feature", FE),
    "is 'implemented'; execute-feature needs it 'reviewed' or later",
    "execution waits for the parent review",
  );
  feRepo("reviewed", "approved");
  passes(runGate(repo, "dev-execute-feature", FE), "execution enters once the parent is reviewed");
  sub(BE, /^Branch: feat\/gate$/m, "Branch: feat/fe");
  blocks(
    runGate(repo, "dev-execute-feature", FE),
    "its PR targets its parent plan's branch, 'feat/fe'",
    "rechecks",
  );
  feRepo("published", "approved");
  blocks(
    runGate(repo, "dev-execute-feature", FE),
    "a published plan never becomes a parent",
    "published parent",
  );
  feRepo("reviewed", "approved");
  writePlan(
    `${PD}/12_orders/pr5.spec.md`,
    "approved",
    VALID,
    "feature",
    "#12",
    "Stacks On: pr4",
    "feat/five",
  );
  blocks(
    runGate(repo, "dev-execute-feature", `${PD}/12_orders/pr5.spec.md`),
    "pr4.spec.md does not exist. Fix the 'Stacks On:' line",
    "a Stacks On naming a missing plan blocks",
  );
  for (const value of [
    "<pr<K> of the parent plan; stacked plans only>",
    "../elsewhere/pr1.spec.md",
    BE,
    "pr1.spec.md",
    "./pr1",
    "pr01",
  ]) {
    sub(FE, /^Stacks On: .*$/m, `Stacks On: ${value}`);
    blocks(
      runGate(repo, "dev-execute-feature", FE),
      "'Stacks On:' line that is misplaced, repeated, or malformed",
      `Stacks On: '${value}' blocks`,
    );
  }
  for (const line of [
    "  Stacks On: pr1",
    "- Stacks On: pr1",
    "**Stacks On:** pr1",
    "Stacks On:",
    "stacks on: pr1",
  ]) {
    edit(FE, (t) =>
      t
        .split("\n")
        .filter((l) => !/stacks on/.test(l.toLowerCase()))
        .flatMap((l) => (l.startsWith("Status:") ? [l, line] : [l]))
        .join("\n"),
    );
    blocks(
      runGate(repo, "dev-execute-feature", FE),
      "'Stacks On:' line that is misplaced",
      `written as '${line}'`,
    );
  }
});

test("execute-feature", () => {
  useRepo();
  writePlan(P, "planning");
  blocks(
    runGate(repo, "dev-execute-feature", P),
    "not approved",
    "a planning plan does not execute",
  );
  writePlan(P, "implemented");
  blocks(
    runGate(repo, "dev-execute-feature", P),
    "already implemented",
    "an implemented plan does not re-execute",
  );
  useRepo();
  planWithWorktree("approved");
  passes(runGate(repo, "dev-execute-feature", P), "an approved plan with a worktree resumes");
  useRepo();
  writePlan(P, "planning");
  insertAtLine2(P, "```\nStatus: approved\n```");
  blocks(
    runGate(repo, "dev-execute-feature", P),
    "Plan status is 'planning'",
    "a fenced Status line is not the header",
  );
});

test("review-code", () => {
  useRepo();
  writePlan(P, "implemented");
  blocks(
    runGate(repo, "dev-review-code", P),
    `Plan ${P} has no worktree`,
    "review-code needs the worktree",
  );
  writePlan(P, "reviewed");
  blocks(
    runGate(repo, "dev-review-code", P),
    "already reviewed",
    "status is checked before the worktree",
  );
  useRepo();
  planWithWorktree("approved");
  let wt = wtOf(P);
  blocks(
    runGate(repo, "dev-review-code", P),
    "not yet implemented",
    "an approved plan is not reviewed",
  );
  sub(P, /Status: approved/, "Status: implemented");
  blocks(
    runGate(repo, "dev-review-code", P),
    "Found no 'test(red):' commit",
    "review requires a RED commit",
  );
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "feat(gate): implement", "src/gate.py");
  passes(runGate(repo, "dev-review-code", P), "RED then implementation enters review");
  passes(
    runGate(wt, "dev-review-code", P),
    "from the worktree, the plan and worktree history combine",
  );
  git(wt, "switch", "-q", "-c", "feat/other");
  blocks(
    runGate(repo, "dev-review-code", P),
    "not this plan's branch 'feat/gate'",
    "the worktree is on the plan's branch",
  );
  git(wt, "switch", "-q", "feat/gate");
  writePlan(
    P,
    "implemented",
    "## Acceptance Criteria\nAC-1 — outcome\n## Test Cases\nTC-1 — scenario\n  Proves: AC-1\nTC-2 — added during execution\n  Proves: AC-1\n## Implementation Steps\nST-1 — action — satisfies TC-1",
  );
  blocks(
    runGate(repo, "dev-review-code", P),
    "TC-2 is not satisfied by any Implementation Step",
    "re-checks closure",
  );

  useRepo();
  planWithWorktree("implemented");
  wt = wtOf(P);
  wtCommit(wt, "chore: setup", "src/gate.py");
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "feat(gate): implement", "src/gate.py");
  blocks(runGate(repo, "dev-review-code", P), "out of sequence", "a commit before RED blocks");

  useRepo();
  planWithWorktree("implemented");
  wt = wtOf(P);
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  fs.appendFileSync(`${repo}/README.md`, "base moved\n");
  git(repo, "commit", "-qam", "chore: base moves");
  git(wt, "merge", "-q", "--no-edit", "main");
  blocks(
    runGate(repo, "dev-review-code", P),
    "out of sequence",
    "a merge after RED is not an implementation",
  );

  useRepo();
  planWithWorktree("implemented");
  wt = wtOf(P);
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "test(update): gate", "tests/gate_test.py");
  blocks(
    runGate(repo, "dev-review-code", P),
    "out of sequence",
    "a test(update) after RED is not an implementation",
  );
  wtCommit(wt, "feat(gate): implement", "src/gate.py");
  passes(
    runGate(repo, "dev-review-code", P),
    "RED, test(update), then implementation enters review",
  );
  wtCommit(wt, "test(update): gate again", "tests/gate_test.py");
  passes(runGate(repo, "dev-review-code", P), "a trailing test(update) leaves the proof complete");

  useRepo();
  planWithWorktree("implemented", VALID, "refactor");
  wt = wtOf(P);
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "refactor: split", "src/gate.py");
  blocks(
    runGate(repo, "dev-review-code", P),
    "Found no 'test: baseline' commit",
    "a refactor proves with a baseline",
  );
  git(wt, "reset", "-q", "--hard", "main");
  wtCommit(wt, "test: baseline gate", "tests/gate_test.py");
  wtCommit(wt, "refactor: split", "src/gate.py");
  passes(runGate(repo, "dev-review-code", P), "baseline then refactor enters review");
});

test("review-code: a stacked plan's proof starts at its parent plan's branch", () => {
  // The parent's history is not this plan's. The branch may be only on origin after cleanup.
  useRepo();
  git(repo, "worktree", "add", "-q", "-b", "feat/gate", wtOf(BE), "main");
  wtCommit(wtOf(BE), "test(red): be", "tests/be_test.py");
  wtCommit(wtOf(BE), "feat(be): implement", "src/be.py");
  writePlan(BE, "reviewed");
  git(repo, "worktree", "add", "-q", "-b", "feat/fe", wtOf(FE), "feat/gate");
  writePlan(FE, "implemented", VALID, "feature", "#12", "Stacks On: pr1", "feat/fe");
  wtCommit(wtOf(FE), "test(red): fe", "tests/fe_test.py");
  wtCommit(wtOf(FE), "feat(fe): implement", "src/fe.py");
  passes(runGate(repo, "dev-review-code", FE), "proof starts at the parent plan's branch");
  git(repo, "update-ref", "refs/remotes/origin/feat/gate", "feat/gate");
  git(repo, "worktree", "remove", wtOf(BE));
  git(repo, "branch", "-q", "-D", "feat/gate");
  passes(runGate(repo, "dev-review-code", FE), "a parent branch only on origin resolves");
  const late = `${repo}-late`;
  git(repo, "worktree", "add", "-q", late, "origin/feat/gate");
  wtCommit(late, "feat(be): late change", "src/be.py");
  git(repo, "update-ref", "refs/remotes/origin/feat/gate", sha("HEAD", late));
  const target = "The PR target 'feat/gate' is missing or is not an ancestor";
  blocks(
    runGate(repo, "dev-review-code", FE),
    target,
    "a change on the parent branch not merged forward blocks",
  );
  git(late, "mv", "src/be.py", "notes.md");
  git(late, "commit", "-qm", "chore: move be");
  git(repo, "update-ref", "refs/remotes/origin/feat/gate", sha("HEAD", late));
  blocks(
    runGate(repo, "dev-review-code", FE),
    target,
    "any commit on the parent branch not merged forward blocks",
  );
});

test("review-code: a parent repair merged forward reads as one line despite interleaved dates", () => {
  useRepo();
  const wt = wtOf(BE);
  const wtf = wtOf(FE);
  git(repo, "worktree", "add", "-q", "-b", "feat/gate", wt, "main");
  const dated = (at: number, body: () => void) =>
    withEnv({ GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` }, body);
  dated(1700000001, () => wtCommit(wt, "test(red): s1", "tests/s1_test.py"));
  dated(1700000002, () => wtCommit(wt, "feat(s1): implement", "src/s1.py"));
  git(repo, "worktree", "add", "-q", "-b", "feat/fe", wtf, "feat/gate");
  dated(1700000003, () => wtCommit(wtf, "test(red): s2", "tests/s2_test.py"));
  dated(1700000004, () => wtCommit(wt, "test(red): s1 repair", "tests/s1_test.py"));
  dated(1700000005, () => wtCommit(wtf, "feat(s2): implement", "src/s2.py"));
  dated(1700000006, () => wtCommit(wt, "fix(s1): repair", "src/s1.py"));
  dated(1700000007, () => git(wtf, "merge", "-q", "--no-edit", "feat/gate"));
  writePlan(BE, "reviewed");
  writePlan(FE, "implemented", VALID, "feature", "#12", "Stacks On: pr1", "feat/fe");
  passes(
    runGate(repo, "dev-review-code", FE),
    "a parent repair merged forward passes despite interleaved dates",
  );
});

test("review-code: Base", () => {
  // Base may advance without the plan merging it; review starts at the fork.
  useRepo();
  planWithWorktree("implemented");
  const wt = wtOf(P);
  wtCommit(wt, "test(red): gate", "tests/gate_test.py");
  wtCommit(wt, "feat(gate): implement", "src/gate.py");
  fs.appendFileSync(`${repo}/README.md`, "moved\n");
  git(repo, "commit", "-qam", "chore: base moves");
  passes(
    runGate(repo, "dev-review-code", P),
    "Base advancing without a merge does not block review",
  );

  // origin/<Base> wins over a stale local Base, as in dev-publish.ts.
  useRepo();
  git(repo, "checkout", "-qb", "up");
  write(`${repo}/up.txt`, "upstream\n");
  git(repo, "add", "up.txt");
  git(repo, "commit", "-qm", "feat: upstream");
  git(repo, "update-ref", "refs/remotes/origin/main", "up");
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-q", "-D", "up");
  git(repo, "worktree", "add", "-q", "-b", "feat/gate", wtOf(P), "origin/main");
  writePlan(P, "implemented");
  wtCommit(wtOf(P), "test(red): gate", "tests/gate_test.py");
  wtCommit(wtOf(P), "feat(gate): implement", "src/gate.py");
  passes(
    runGate(repo, "dev-review-code", P),
    "a plan from origin/<Base> reviews from it when local Base is behind",
  );

  feRepo("implemented", "implemented");
  git(repo, "worktree", "add", "-q", "-b", "feat/fe", wtOf(FE), "main");
  blocks(
    runGate(repo, "dev-review-code", FE),
    `Parent plan ${BE} is 'implemented'; review-code needs it 'reviewed'`,
    "code review waits for a revised parent",
  );
});

test("create-pr", () => {
  useRepo();
  planWithWorktree("reviewed");
  setReviewed(P);
  blocks(
    runGate(repo, "dev-create-pr", P),
    "Plan status is 'reviewed without its SHA'",
    "needs the root reviewed SHA",
  );
  useRepo();
  writePlan(P, `reviewed ${sha("HEAD")}`);
  blocks(
    runGate(repo, "dev-create-pr", P),
    `Plan ${P} has no worktree`,
    "create-pr needs the worktree",
  );
  useRepo();
  planWithWorktree("implemented");
  blocks(
    runGate(repo, "dev-create-pr", P),
    "run review-code first",
    "an implemented plan cannot skip review-code",
  );
  wtCommit(wtOf(P), "feat(gate): no test first", "src/gate.py");
  setReviewed(P, sha("feat/gate"));
  blocks(
    runGate(repo, "dev-create-pr", P),
    "has no 'test(red):' commit followed by implementation after",
    "a reviewed status set by hand does not skip the proof",
  );
  useRepo();
  planWithWorktree("reviewed");
  fs.appendFileSync(
    `${path.dirname(P)}/log`,
    `pr1: code-review needs-changes (2/3) at ${sha("feat/gate")}\n`,
  );
  const notPass = "its last review-code verdict in the stack log is not a pass";
  blocks(
    runGate(repo, "dev-create-pr", P),
    notPass,
    "a reviewed status after a needs-changes verdict blocks",
  );
  logPass(P, sha("main"));
  blocks(
    runGate(repo, "dev-create-pr", P),
    notPass,
    "a pass logged at another SHA does not cover the Tip",
  );
});

test("create-pr on a stack tree", () => {
  useRepo();
  planWithWorktree("reviewed");
  // A tree: P has children C2 and C3, and C2 has its only child C4, each in its own worktree.
  const C2 = `${PD}/12_gate/pr2.spec.md`;
  const C3 = `${PD}/12_gate/pr3.spec.md`;
  const C4 = `${PD}/12_gate/pr4.spec.md`;
  for (const c of [C2, C3, C4]) git(repo, "worktree", "add", "-q", "--detach", wtOf(c), "main");
  git(repo, "branch", "-q", "feat/c4", "main");
  /** Reviewed with a proof on the parent's reviewed SHA. */
  const stackOn = (plan: string, status: string, parent: string, branch: string) => {
    const s =
      status === "reviewed"
        ? `reviewed ${proofOn(greenIn(`${PD}/12_gate/${parent.replace(/^\.\//, "")}.spec.md`))}`
        : status;
    writePlan(plan, s, VALID, "feature", "#12", `Stacks On: ${parent}`, branch);
  };
  const createPr = (opts: { staleOk?: boolean } = {}) => runGate(repo, "dev-create-pr", P, opts);
  stackOn(C2, "implemented", "pr1", "feat/gate");
  blocks(
    createPr(),
    `Plan ${C2} has 'Branch: feat/gate', but its PR targets its parent plan's branch`,
    "stacks correctly",
  );
  stackOn(C2, "implemented", "pr1", "feat/c2");
  blocks(
    createPr(),
    `Plan ${C2} stacks above this plan and is 'implemented'`,
    "the root waits for its child",
  );
  writePlan(
    C2,
    "planning",
    VALID,
    "feature",
    "#12",
    "Stacks On: docs/plan/typo.spec.md",
    "feat/c2",
  );
  blocks(
    createPr(),
    `${C2} has a 'Stacks On:' line that is misplaced`,
    "a malformed Stacks On elsewhere blocks",
  );
  stackOn(C2, "reviewed", "pr1", "feat/c2");
  stackOn(C3, "reviewed", "pr1", "feat/c3");
  stackOn(C4, "approved", "pr2", "feat/c4");
  blocks(
    createPr(),
    `Plan ${C4} stacks above this plan and is 'approved'`,
    "the root waits for a grandchild",
  );
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  passes(createPr(), "the root publishes once every plan in its tree is reviewed");
  setReviewed(C4, greenIn(C2));
  blocks(
    createPr(),
    `Plan ${C4}'s reviewed SHA ${greenIn(C2)} has no 'test(red):' commit followed by implementation`,
    "a child without its own proof blocks publication",
  );
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  git(repo, "worktree", "remove", wtOf(C3));
  blocks(
    createPr(),
    `Plan ${C3} has no worktree`,
    "a plan without its worktree or branch has no worktree",
  );
  git(repo, "branch", "-q", "feat/c3", "main");
  blocks(createPr(), `Plan ${C3} has no worktree`, "a plan never uses its parent's worktree");
  git(repo, "worktree", "add", "-q", "--detach", wtOf(C3), "main");
  setReviewed(C2);
  blocks(
    createPr(),
    `Plan ${C2} stacks above this plan and is 'reviewed without its SHA'`,
    "each needs its SHA",
  );
  stackOn(C2, "reviewed", "pr1", "feat/c2");
  createPr();
  fs.appendFileSync(C4, "Note: added later\n");
  blocks(
    createPr({ staleOk: true }),
    `Plan ${C4} has no ready 'Spec:' hash`,
    "a line added after review voids it",
  );
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  sub(C4, /^Gate the phases\./m, "Gate every phase.");
  blocks(
    createPr({ staleOk: true }),
    `Plan ${C4} has no ready 'Spec:' hash`,
    "a stack plan edited after review",
  );
  sub(P, /^Gate the phases\./m, "Gate every phase.");
  blocks(
    createPr({ staleOk: true }),
    `Plan ${P} has no ready 'Spec:' hash`,
    "a root edited after review",
  );
  const stale = greenIn(C2);
  wtCommit(wtOf(P), "fix: root repair", "src/root.py");
  const green = sha("HEAD", wtOf(P));
  setReviewed(P, green);
  blocks(
    createPr(),
    `Plan ${C2}'s reviewed SHA ${stale} does not contain its parent ${P}'s, ${green}`,
    "a child reviewed before a root repair blocks publication",
  );
  stackOn(C2, "reviewed", "pr1", "feat/c2");
  stackOn(C3, "reviewed", "pr1", "feat/c3");
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  passes(createPr(), "children re-reviewed on the repaired root publish");
  const log = `${PD}/12_gate/log`;
  fs.appendFileSync(log, `pr3: stop review-code round limit (3/3) at ${"0".repeat(40)}\n`);
  blocks(
    createPr(),
    `Plan ${C3} stacks above this plan and is stopped`,
    "a stopped plan above the root blocks",
  );
  edit(log, (t) => t.replace(/^pr3: stop .*\n/m, ""));
  fs.appendFileSync(C4, "\n```\nStacks On: pr3\n```\n");
  passes(createPr(), "a Stacks On line in a fenced block is not the header");
  const misplaced = `${C4} has a 'Stacks On:' line that is misplaced`;
  stackOn(C4, "reviewed", "./pr2", "feat/c4");
  blocks(createPr(), misplaced, "a Stacks On value other than pr<K> blocks");
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  insertAtLine2(C4, "```");
  blocks(createPr(), misplaced, "an unclosed fence blocks");
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  fs.symlinkSync("pr4.spec.md", `${PD}/12_gate/pr9.spec.md`);
  blocks(createPr(), "pr9.spec.md has a 'Stacks On:' line", "a symlinked plan blocks publication");
  fs.rmSync(`${PD}/12_gate/pr9.spec.md`);
  edit(C4, (t) => t.replace(/^Stacks On:.*\n/m, "").replace(/^## Goal.*$/m, "$&\nStacks On: pr2"));
  blocks(createPr(), misplaced, "a Stacks On line below the header blocks");
  stackOn(C4, "reviewed", "pr2", "feat/c4");
  writePlan(
    `${PD}/12_gate/pr6.spec.md`,
    "reviewed",
    VALID,
    "feature",
    "#12",
    "Stacks On: pr5",
    "feat/c6",
  );
  blocks(
    createPr(),
    "pr6.spec.md has a 'Stacks On:' line that is misplaced, repeated, malformed, or names no plan",
    "a child of a missing plan blocks publication",
  );
  fs.rmSync(`${PD}/12_gate/pr6.spec.md`);
  blocks(
    runGate(repo, "dev-create-pr", C2),
    `create-pr runs once, on the stack's root ${P}`,
    "names the root",
  );
  git(repo, "worktree", "remove", wtOf(C4));
  blocks(createPr(), `Plan ${C4} has no worktree`, "publication needs every worktree in the stack");
  sub(C4, /^Status: reviewed$/m, "Status: published");
  passes(createPr(), "a plan published by an earlier cleanup leaves the stack");
});

test("a current ready Spec", () => {
  const NO_REVIEW = "no ready 'Spec:' hash for its current spec";
  const stale = (cwd: string, skill: string, plan: string) =>
    runGate(cwd, skill, plan, { staleOk: true });
  useRepo();
  writePlan(P, "approved");
  blocks(stale(repo, "dev-execute-feature", P), NO_REVIEW, "execution needs a recorded review");
  ready(P);
  passes(stale(repo, "dev-execute-feature", P), "a current review admits execution");
  sub(P, /^Gate the phases\./m, "Gate every phase.");
  blocks(
    stale(repo, "dev-execute-feature", P),
    NO_REVIEW,
    "a spec edit after review blocks execution",
  );
  sub(P, /^Spec: .*$/m, "Spec: nothex");
  blocks(
    stale(repo, "dev-execute-feature", P),
    NO_REVIEW,
    "a malformed Spec hash blocks execution",
  );
  sub(P, /^Status: approved$/m, "Status: needs-changes");
  ready(P);
  blocks(
    stale(repo, "dev-execute-feature", P),
    "Plan status is 'needs-changes' — not approved. Revise it",
    "a needs-changes verdict blocks execution",
  );
  passes(stale(repo, "dev-review-feature", P), "a needs-changes plan re-enters review");
  stack("review", P, "needs-changes");
  sub(P, /^Status: needs-changes$/m, "Status: approved");
  blocks(
    stale(repo, "dev-execute-feature", P),
    NO_REVIEW,
    "approving a needs-changes verdict by hand blocks",
  );
  sub(P, /^Status: approved$/m, "Status: ready");
  passes(stale(repo, "dev-review-feature", P), "a ready plan may be reviewed again");
  feRepo("reviewed", "approved");
  ready(FE);
  passes(stale(repo, "dev-execute-feature", FE), "a stacked plan with a current review executes");
  sub(BE, /^Gate the phases\./m, "Gate every phase.");
  blocks(
    stale(repo, "dev-execute-feature", FE),
    NO_REVIEW,
    "a parent spec edit voids the child review",
  );
  useRepo();
  planWithWorktree("implemented");
  blocks(stale(repo, "dev-review-code", P), NO_REVIEW, "code review needs a current review");
});

test("stops and the approval ratchet", () => {
  useRepo();
  writePlan(P, "planning");
  stack("stop", P, "needs a decision");
  blocks(
    runGate(repo, "dev-review-feature", P),
    "is stopped: needs a decision",
    "a stopped plan is blocked at its gate",
  );
  blocks(
    promptGate(repo, `/dev-review-feature ${P}`),
    "is stopped",
    "the user's typed phase is blocked until resume",
  );
  passes(design(P, { cwd: repo, env: ENV }), "design-feature's stack check ignores a stop");
  stack("resume", P);
  passes(runGate(repo, "dev-review-feature", P), "resume reopens the gate");
  useRepo();
  writePlan(P, "planning");
  stack("review", P, "ready");
  stack("autopilot", P);
  stack("approve", P);
  const stale = (skill: string) => runGate(repo, skill, P, { staleOk: true });
  passes(stale("dev-execute-feature"), "an auto-approved plan executes");
  sub(P, /^Gate the phases\./m, "Gate every phase.");
  blocks(
    stale("dev-execute-feature"),
    "is frozen: its spec, or a spec below it, changed since its approval",
    "an approved plan whose spec changed is frozen",
  );
  edit(P, (t) =>
    t
      .replace(/^Gate every phase\./m, "Gate the phases.")
      .replace(/^Status: .*$/m, "Status: planning"),
  );
  blocks(
    stale("dev-review-feature"),
    "never returns to planning",
    "an approved plan returned to planning is frozen",
  );
  blocks(
    design(P, { cwd: repo, env: ENV }),
    "never returns to planning",
    "design-feature's stack check refuses it too",
  );
  stack("reopen", P);
  passes(stale("dev-review-feature"), "the user's reopen lifts the freeze");
});

test("PC checks", () => {
  const pc = (...lines: string[]) => `${VALID}\n${lines.join("\n")}`;
  const counts = "PC-1 counts matches";
  const cases: [string, string, string][] = [
    [
      "a PC without a Check blocks",
      pc("  PC-1 — the gate exists"),
      'PC-1 has no "— Check: <command>"',
    ],
    ["grep -c", pc('  PC-1 — three callers — Check: test "$(grep -rc gate src)" = 3'), counts],
    ["wc -l", pc("  PC-1 — three callers — Check: grep -r gate src | wc -l | grep -qx 3"), counts],
    ["rg -c", pc("  PC-1 — three callers — Check: rg -c gate src"), counts],
    [
      "a count inside a command substitution",
      pc('  PC-1 — one gate — Check: test "$(grep "def gate" -c src/x.py)" = 1'),
      counts,
    ],
    [
      "wc -l closing a substitution",
      pc('  PC-1 — three callers — Check: test "$(grep -r "gate(" src | wc -l)" -eq 3'),
      counts,
    ],
    [
      "rg --count closing a substitution",
      pc('  PC-1 — three callers — Check: [ "$(rg gate src --count)" = 3 ]'),
      counts,
    ],
    [
      "a structural PC Check passes",
      pc(
        '  PC-1 — gate() exists — Check: grep -q "def gate" src/gate.py',
        '  PC-2 — no caller of old() — Check: ! grep -rq "old(" src',
      ),
      "",
    ],
  ];
  for (const [label, graph, want] of cases) reviewGraph(label, graph, want);
});

test("Type: config", () => {
  useRepo();
  planWithWorktree("implemented", VALID, "config");
  const wt = wtOf(P);
  blocks(
    runGate(repo, "dev-review-code", P),
    "Found no implementation commit between",
    "a config plan needs a commit",
  );
  wtCommit(wt, "chore(i18n): add strings", "locales/en.json");
  passes(
    runGate(repo, "dev-review-code", P),
    "a config plan enters review-code without a proof commit",
  );
  writePlan(P, `reviewed ${sha("feat/gate")}`, VALID, "config");
  passes(
    runGate(repo, "dev-create-pr", P),
    "a reviewed config plan publishes without a proof commit",
  );
  writePlan(P, `reviewed ${sha("main")}`, VALID, "config");
  blocks(
    runGate(repo, "dev-create-pr", P),
    "has no implementation commit after",
    "reviewed without a commit of its own",
  );
});

const guard = (tool: string, input: Record<string, unknown>) =>
  call({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input as HookInput });
const bashGuard = (command: string) => guard("Bash", { command });
const editGuard = (file: string, from: string, to: string) =>
  guard("Edit", { file_path: file, old_string: from, new_string: to });

/** A shell command between its PreToolUse snapshot and its PostToolUse check. */
const shellRun = (command: string) => {
  const id = `t${Math.random().toString(36).slice(2)}`;
  call({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: id,
    tool_input: { command },
  });
  exec(["bash", "-c", command], { cwd: repo });
  return call({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: id,
    tool_input: { command },
  });
};

test("record guard: Bash, Edit, and Write calls", () => {
  useRepo();
  const LOG = `${path.dirname(P)}/log`;
  const resume = "dev-stack.js resume is the user's alone";
  const logOnly = "written only by dev-stack.js";
  blocks(
    bashGuard(`~/.dotfiles/.ai-shared/bin/dev-stack.sh resume ${P}`),
    resume,
    "an agent cannot run resume",
  );
  blocks(
    bashGuard(`bash dev-stack.sh reopen '${P}'`),
    "dev-stack.js reopen is the user's alone",
    "or reopen",
  );
  const denied = cli("hook", [], {
    cwd: repo,
    env: ENV,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `bash dev-stack.sh reopen '${P}'` },
    }),
  });
  const v = JSON.parse(denied.out);
  assert.deepEqual(v.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: v.reason,
  });
  blocks(
    bashGuard(`cd /tmp && env FOO=1 "$HOME/.dotfiles/.ai-shared/bin/dev-stack.sh" resume ${P}`),
    resume,
    "resume after a separator and a quoted path is caught",
  );
  blocks(bashGuard(`true\ndev-stack.sh resume ${P}`), resume, "resume on a later line is caught");
  const viaCommand = `${RUN} ${PLUGIN}/bin/dev-stack-command.ts`;
  blocks(
    bashGuard(`${viaCommand} dev-stack-resume ${P}`),
    resume,
    "resume through the command CLI",
  );
  blocks(
    bashGuard(`cd /tmp && ${viaCommand} 'dev-stack-reopen' '${P}'`),
    "dev-stack.js reopen is the user's alone",
    "reopen through the command CLI",
  );
  passes(bashGuard(`${viaCommand} dev-stack-next ${P}; cat ${LOG}`), "its reads pass");
  passes(
    bashGuard(
      "grep -n 'dev-stack.sh resume' README.md; echo 'ask the user to run dev-stack.sh reopen'",
    ),
    "a mention of resume or reopen in an argument passes",
  );
  passes(bashGuard(`~/.dotfiles/.ai-shared/bin/dev-stack.sh next ${P}`), "an agent runs next");
  passes(bashGuard("git log --oneline -5 && grep resume README.md"), "an unrelated command passes");
  blocks(
    bashGuard(`echo 'pr1: cleared' >> ${LOG}`),
    logOnly,
    "an agent cannot append to the stack log",
  );
  // The runtimes, bun also with the flags the plugin runs it with.
  const RUNTIMES = ["node", "bun", RUN];
  for (const rt of RUNTIMES) {
    passes(
      bashGuard(`${rt} ${PLUGIN}/bin/dev-stack.ts next ${P}; cat ${LOG}`),
      `a dev CLI under ${rt} is no log write`,
    );
    blocks(
      bashGuard(`${rt} -e "require('fs').appendFileSync('${LOG}','x')"`),
      logOnly,
      `${rt} -e writing the log`,
    );
  }
  passes(
    bashGuard(`cd /tmp && ${RUN} '${PLUGIN}/bin/dev-stack.ts' next ${P} && cat ${LOG}`),
    "a quoted dev CLI path after cd is no log write",
  );
  for (const opt of ["--preload ./x.js", "--config=./bunfig.toml", "run"])
    blocks(
      bashGuard(`bun ${opt} ${PLUGIN}/bin/dev-stack.ts next ${P}; cat ${LOG}`),
      logOnly,
      `bun ${opt} makes a dev CLI any script`,
    );
  // Only this plugin's own bin/ is trusted: a lookalike name or a copy elsewhere is any script.
  const fake = fs.mkdtempSync(`${TMP}/fakebin.`);
  for (const script of [
    `${fake}/my-dev-stack.ts`,
    `${fake}/dev-stack.tsx`,
    `${fake}/dev-utils.ts.js`,
    `${fake}/dev-stack.ts`,
    `${PLUGIN}/bin/../core/dev-stack.ts`,
    "$DEV_LIB/bin/dev-stack.ts",
    // Run from the sources, only .ts names in bin/ are this plugin's CLIs.
    `${PLUGIN}/bin/dev-stack.js`,
  ])
    for (const rt of RUNTIMES)
      blocks(bashGuard(`${rt} ${script} ${LOG}`), logOnly, `${rt} ${script} writing the log`);
  for (const rt of [...RUNTIMES, "bun run", "bun --smol", "node --no-warnings"])
    blocks(
      bashGuard(`${rt} "$DEV_LIB/bin/dev-stack.ts" resume ${P}`),
      resume,
      `resume under ${rt} is caught`,
    );
  // The built plugin's CLIs are .js; the user's writes are caught under either extension.
  blocks(
    bashGuard(`${RUN} "$DEV_LIB/bin/dev-stack.js" resume ${P}`),
    resume,
    "resume through the built CLI is caught",
  );
  blocks(
    bashGuard(`${RUN} "$DEV_LIB/bin/dev-stack-command.js" dev-stack-reopen ${P}`),
    "dev-stack.js reopen is the user's alone",
    "reopen through the built command CLI is caught",
  );
  passes(bashGuard(`cat ${LOG} 2>/dev/null; tail -3 ${LOG}`), "an agent reads the stack log");
  passes(
    bashGuard(`grep review ${LOG} > /tmp/out; tail -3 ${LOG} >> /tmp/out`),
    "reading the log into another file",
  );
  passes(
    bashGuard(
      "cp x.go ~/wt/repo-12_slug-pr1/log/handler.go && echo x > ~/wt/repo-12_slug-pr1/log/a.go",
    ),
    "a worktree's log/ directory is not the stack log",
  );
  blocks(
    bashGuard(`cd ${path.dirname(path.dirname(P))} && printf x >> 12_gate/log`),
    logOnly,
    "a relative write",
  );
  blocks(bashGuard(`cp /tmp/x ${LOG}`), logOnly, "a copy over the stack log is caught");
  blocks(
    bashGuard(`cd ${repo} && cp /tmp/a docs/plans/12_gate/log`),
    logOnly,
    "relative to the repository root",
  );
  blocks(bashGuard(`cd ${repo}/docs && cp /tmp/a plans/12_gate/log`), logOnly, "relative to docs/");
  blocks(
    bashGuard(`sed --in-place 's/x/y/' ${LOG}`),
    logOnly,
    "sed --in-place on the stack log is caught",
  );
  blocks(bashGuard(`echo x >& ${LOG}`), logOnly, "a >& redirection into the stack log is caught");
  blocks(
    bashGuard(`cd ${path.dirname(P)} && echo x >> ../12_gate/log`),
    logOnly,
    "a ../ path to the stack log",
  );
  blocks(
    guard("Write", { file_path: LOG, content: "x" }),
    logOnly,
    "Write cannot touch the stack log",
  );
  writePlan(P, "ready");
  blocks(
    editGuard(P, "Status: ready", "Status: approved"),
    "Only the user sets 'Status: approved'",
    "cannot approve",
  );
  blocks(
    editGuard(P, "Status: ready", "Status: auto-approved"),
    "Only dev-stack.js approve",
    "cannot auto-approve",
  );
  passes(
    editGuard(P, "Gate the phases.", "Gate every phase."),
    "a plan before approval is edited freely",
  );
  writePlan(P, "approved");
  passes(
    editGuard(P, "Status: approved", "Status: implemented"),
    "an approved plan's Status moves forward",
  );
  blocks(
    editGuard(P, "Status: approved", "Status: planning"),
    "never returns to planning",
    "never back to planning",
  );
  blocks(
    editGuard(P, "Status: approved", "Status: aproved"),
    "or to an unknown value",
    "never to an unknown value",
  );
  blocks(
    editGuard(P, "Gate the phases.", "Gate every phase."),
    "frozen: after approval only its Status and Tip",
    "frozen",
  );
  blocks(
    guard("MultiEdit", {
      file_path: P,
      edits: [
        { old_string: "Status: approved", new_string: "Status: implemented" },
        { old_string: "Gate the phases.", new_string: "Gate all." },
      ],
    }),
    "frozen",
    "MultiEdit is checked edit by edit",
  );
  blocks(
    guard("Write", { file_path: P, content: read(P).replace("Gate the phases.", "Gate all.") }),
    "frozen",
    "Write is checked against the frozen spec",
  );
  passes(
    editGuard(P, "no such text", "x"),
    "an edit that matches nothing is left to fail on its own",
  );
});

test("record guard: shell commands are checked after they run", () => {
  useRepo();
  writePlan(P, "approved");
  const D = path.dirname(P);
  const n = path.basename(P, ".spec.md");
  const approved = read(P);
  const below = "never returns below approved";
  blocks(
    shellRun(`sed -i 's/^Status: approved/Status: planning/' ${P}`),
    below,
    "a shell rollback is undone",
  );
  assert.equal(read(P), approved, "rollback not restored");
  blocks(
    shellRun(`python3 -c 'import sys; p=sys.argv[1]; open(p,"a").write("x\\n")' ${P}`),
    "its spec changed",
    "any shell write to an approved spec is undone, python included",
  );
  assert.equal(read(P), approved, "spec not restored");
  blocks(shellRun(`rm -f ${P}`), "moved or deleted", "deleting an approved plan is undone");
  assert.ok(fs.existsSync(P), "deleted plan not restored");
  passes(
    shellRun(
      `sed -i 's/^Status: approved/Status: implemented/' ${P}; cat ${P} > /dev/null; cp ${P} /tmp/copy`,
    ),
    "an approved plan's Status moves forward by shell, and reads pass",
  );
  assert.ok(hasLine(P, "Status: implemented"), "forward Status reverted");

  // dev-stack.ts's own flows pass the check, and a plan removed with rm while the log holds its
  // lines comes back.
  let SD = `${PD}/13_flow`;
  writePlan(`${SD}/pr1.spec.md`, "planning");
  writePlan(`${SD}/pr2.spec.md`, "planning", VALID, "feature", "#13", "Stacks On: pr1", "feat/f2");
  passes(
    shellRun(
      `${DS} review ${SD}/pr2.spec.md needs-changes && ${DS} stop ${SD}/pr2.spec.md 'x' && ${DS} next ${SD}/pr1.spec.md`,
    ),
    "review, stop, and next pass the check",
  );
  blocks(
    shellRun(`rm ${SD}/pr2.spec.md`),
    "still holds its lines",
    "a plan removed while the log holds its lines",
  );
  assert.ok(fs.existsSync(`${SD}/pr2.spec.md`), "removed plan not restored");
  stack("resume", `${SD}/pr2.spec.md`);
  passes(shellRun(`${DS} renumber ${SD}/pr1.spec.md 2=3`), "renumber passes the check");
  passes(shellRun(`${DS} drop ${SD}/pr3.spec.md`), "drop passes the check");
  assert.ok(
    !fs.existsSync(`${SD}/pr3.spec.md`) && !fs.existsSync(`${SD}/pr2.spec.md`),
    "renumber or drop undone",
  );
  fs.rmSync(SD, { recursive: true });

  // dev-stack.ts auto-reopen passes the check; a second auto-reopen, or one over the user's
  // approval, forged by a shell command, is undone.
  SD = `${PD}/14_auto`;
  const SP = `${SD}/pr1.spec.md`;
  writePlan(SP, "planning", VALID, "feature", "#14");
  stack("review", SP, "ready");
  stack("autopilot", SP);
  stack("approve", SP);
  blocks(
    shellRun(`sed -i 's/^Status: auto-approved/Status: planning/' ${SP}`),
    below,
    "an auto-approved rollback",
  );
  assert.ok(hasLine(SP, "Status: auto-approved"));
  passes(shellRun(`${DS} auto-reopen ${SP}`), "auto-reopen passes the check");
  assert.ok(hasLine(SP, "Status: planning"), "auto-reopen undone");
  stack("review", SP, "ready");
  stack("approve", SP);
  blocks(
    shellRun(
      `sed -i 's/^Status: auto-approved/Status: planning/' ${SP} && echo 'pr1: auto-reopened' >> ${SD}/lo''g`,
    ),
    below,
    "a second auto-reopen line never lifts the freeze",
  );
  assert.ok(hasLine(SP, "Status: auto-approved"));
  blocks(
    shellRun(`sed -i '/auto-reopened/d' ${SD}/lo''g`),
    "lost a line only dev-stack.js writes",
    "an auto-reopen line stays",
  );
  fs.rmSync(SD, { recursive: true });
  writePlan(SP, "planning", VALID, "feature", "#14");
  stack("review", SP, "ready");
  stack("autopilot", SP);
  stack("approve", SP);
  sub(SP, /^Status: auto-approved/m, "Status: approved");
  blocks(
    shellRun(
      `sed -i 's/^Status: approved/Status: planning/' ${SP} && echo 'pr1: auto-reopened' >> ${SD}/lo''g`,
    ),
    below,
    "an auto-reopen line never lifts the user's approval over autopilot's",
  );
  assert.ok(hasLine(SP, "Status: approved"));
  fs.rmSync(SD, { recursive: true });
  writePlan(P, "approved");
  blocks(
    shellRun(
      `sed -i 's/^Status: approved/Status: planning/' ${P} && echo '${n}: auto-reopened' >> ${D}/lo''g`,
    ),
    below,
    "an auto-reopen line never lifts the user's approval",
  );
  assert.ok(hasLine(P, "Status: approved"));
  fs.rmSync(`${D}/log`, { force: true });

  // A command that writes the log through a path the text check cannot see (here lo''g) is still
  // judged after it runs.
  writePlan(P, "approved");
  blocks(
    shellRun(
      `sed -i 's/^Status: approved/Status: planning/' ${P} && echo '${n}: reopened' >> ${D}/lo''g`,
    ),
    below,
    "a reopen line a shell command writes never lifts the freeze",
  );
  assert.ok(hasLine(P, "Status: approved") && !fs.existsSync(`${D}/log`), "forged reopen kept");
  write(`${D}/log`, `${n}: stop review-code round limit (3/3) at ${"0".repeat(40)}\n`);
  blocks(
    shellRun(`: > ${D}/lo''g`),
    "lost a line only dev-stack.js writes",
    "a shell command cannot drop a stop line",
  );
  assert.ok(read(`${D}/log`).includes(": stop "), "stop line not restored");
  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "published");
  const published = "is published and changed";
  blocks(
    shellRun(`sed -i 's/^Status: published/Status: reviewed/' ${P}`),
    published,
    "a published plan edit is undone",
  );
  blocks(
    shellRun(
      `sed -i 's/^Status: published/Status: planning/' ${P} && echo '${n}: reopened' >> ${D}/lo''g`,
    ),
    published,
    "a reopen line never unfreezes a published plan",
  );
  fs.rmSync(`${D}/log`, { force: true });

  writePlan(P, "ready");
  passes(
    shellRun(`sed -i 's/Gate the phases\\./Gate all./' ${P}`),
    "a shell edit before approval passes",
  );
  blocks(
    shellRun(`sed -i 's/^Status: ready/Status: approved/' ${P}`),
    "which only the user sets",
    "cannot approve",
  );
  assert.ok(hasLine(P, "Status: ready"));
  blocks(
    shellRun(`sed -i 's/^Status: ready/Status: implemented/' ${P}`),
    "skipping approval",
    "cannot skip approval",
  );
  assert.ok(hasLine(P, "Status: ready"));
  blocks(
    editGuard(P, "Status: ready", "Status: implemented"),
    "only through approval",
    "an edit cannot skip approval",
  );
  const autoOnly = "only dev-stack.js approve sets";
  blocks(
    shellRun(`sed -i 's/^Status: ready/Status: auto-approved/' ${P}`),
    autoOnly,
    "cannot auto-approve by hand",
  );
  blocks(
    shellRun(
      `sed -i 's/^Status: ready/Status: auto-approved/' ${P} && echo '${n}: approve auto-approved at abc' >> ${D}/lo''g`,
    ),
    autoOnly,
    "a forged approve line at the wrong hash does not pass",
  );
  fs.rmSync(`${D}/log`, { force: true });
  passes(
    shellRun(`${DS} review ${P} ready && ${DS} autopilot ${P} && ${DS} approve ${P}`),
    "dev-stack.ts review, autopilot, and approve pass the check",
  );
  assert.ok(hasLine(P, "Status: auto-approved"));
  // One call may run review and approve from planning: the snapshot never sees ready.
  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "planning");
  passes(
    shellRun(`${DS} review ${P} ready && ${DS} autopilot ${P} && ${DS} approve ${P}`),
    "review and approve in one call pass from planning",
  );
  assert.ok(hasLine(P, "Status: auto-approved"));

  // An approve line at the real hash without a review that holds is still refused, and the line
  // goes with the restored header.
  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "planning");
  const h = lib().planHash(b(P)) ?? "";
  blocks(
    shellRun(
      `sed -i 's/^Status: planning/Status: auto-approved/' ${P} && echo '${n}: approve auto-approved at ${h}' >> ${D}/lo''g`,
    ),
    autoOnly,
    "an approve line at the real hash without a holding review does not pass",
  );
  assert.ok(hasLine(P, "Status: planning") && !fs.existsSync(`${D}/log`));
  blocks(
    shellRun(
      `sed -i 's/^Status: planning/Status: auto-approved/; s/^Spec: -/Spec: ${h}/' ${P} && echo '${n}: approve auto-approved at ${h}' >> ${D}/lo''g`,
    ),
    autoOnly,
    "a hand-written Spec at the real hash without a logged review does not pass",
  );
  assert.ok(hasLine(P, "Status: planning") && !fs.existsSync(`${D}/log`));

  // A refused call leaves the plan workable: its approve line goes, its review line stays, and the
  // next review and approve succeed.
  writePlan(P, "planning");
  blocks(
    shellRun(
      `${DS} review ${P} ready && ${DS} autopilot ${P} && ${DS} approve ${P} && sed -i 's/Gate the phases\\./Gate all./' ${P}`,
    ),
    autoOnly,
    "a spec change after approve in one call is refused",
  );
  assert.ok(hasLine(P, "Status: planning"));
  assert.ok(
    !new RegExp(`^${n}: approve `, "m").test(read(`${D}/log`)),
    "approve line of a restored plan kept",
  );
  assert.ok(
    new RegExp(`^${n}: review ready `, "m").test(read(`${D}/log`)),
    "review line of a restored plan dropped",
  );
  passes(shellRun(`${DS} review ${P} ready`), "a restored plan takes a review again");
  passes(shellRun(`${DS} approve ${P}`), "a restored plan takes an approval again");
  assert.ok(hasLine(P, "Status: auto-approved"));

  // Only the restored plan's lines go: another plan's approval in the same call stays.
  SD = `${PD}/14_pair`;
  const pair = () => {
    writePlan(`${SD}/pr1.spec.md`, "planning");
    writePlan(
      `${SD}/pr2.spec.md`,
      "planning",
      VALID,
      "feature",
      "#14",
      "Stacks On: pr1",
      "feat/p2",
    );
  };
  const approveBoth = `${DS} review ${SD}/pr1.spec.md ready && ${DS} autopilot ${SD}/pr1.spec.md && ${DS} approve ${SD}/pr1.spec.md && ${DS} review ${SD}/pr2.spec.md ready && ${DS} approve ${SD}/pr2.spec.md`;
  pair();
  blocks(
    shellRun(`${approveBoth} && sed -i 's/Gate the phases\\./Gate all./' ${SD}/pr2.spec.md`),
    autoOnly,
    "one refused plan",
  );
  assert.ok(
    hasLine(`${SD}/pr1.spec.md`, "Status: auto-approved") &&
      /^pr1: approve auto-approved at /m.test(read(`${SD}/log`)),
  );
  assert.ok(
    hasLine(`${SD}/pr2.spec.md`, "Status: planning") && !/^pr2: approve /m.test(read(`${SD}/log`)),
  );
  fs.rmSync(SD, { recursive: true });
  // A child approved in the same call over a parent undone below approved is undone too.
  pair();
  blocks(
    shellRun(
      `${approveBoth} && sed -i 's/^Status: auto-approved/Status: implemented/' ${SD}/pr1.spec.md`,
    ),
    "auto-approved over its parent",
    "a child approved over an undone parent is undone",
  );
  assert.ok(
    hasLine(`${SD}/pr1.spec.md`, "Status: planning") &&
      hasLine(`${SD}/pr2.spec.md`, "Status: planning"),
  );
  assert.ok(!read(`${SD}/log`).includes(": approve "), "approve lines of undone plans kept");
  fs.rmSync(SD, { recursive: true });
  // A plan the check cannot restore keeps its approve line, so header and log still agree: a
  // directory left at the plan's path, holding a file it cannot delete.
  writePlan(`${SD}/pr1.spec.md`, "planning");
  const out = shellRun(
    `${DS} review ${SD}/pr1.spec.md ready && ${DS} autopilot ${SD}/pr1.spec.md && ${DS} approve ${SD}/pr1.spec.md && rm ${SD}/pr1.spec.md && mkdir ${SD}/pr1.spec.md && touch ${SD}/pr1.spec.md/x && chmod 500 ${SD}/pr1.spec.md`,
  );
  fs.chmodSync(`${SD}/pr1.spec.md`, 0o700);
  blocks(out, "Could not restore it", "a plan that cannot be restored is reported");
  assert.ok(
    /^pr1: approve auto-approved at /m.test(read(`${SD}/log`)),
    "approve line of an unrestored plan removed",
  );
  fs.rmSync(SD, { recursive: true });

  // A refused auto-reopen loses its auto-reopened line with the restored header, so the plan keeps
  // its one auto-reopen.
  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "planning");
  passes(
    shellRun(`${DS} review ${P} ready && ${DS} autopilot ${P} && ${DS} approve ${P}`),
    "approval before an auto-reopen",
  );
  fs.chmodSync(`${D}/log`, 0o640);
  blocks(
    shellRun(`${DS} auto-reopen ${P} && sed -i 's/Gate the phases\\./Gate all./' ${P}`),
    "its spec changed",
    "an auto-reopen with a spec change to the approved plan in one call is refused",
  );
  assert.equal(fs.statSync(`${D}/log`).mode & 0o777, 0o640, "rewritten log lost its mode");
  assert.ok(hasLine(P, "Status: auto-approved") && !hasLine(`${D}/log`, `${n}: auto-reopened`));
  passes(shellRun(`${DS} auto-reopen ${P}`), "the plan keeps its one auto-reopen");
  assert.ok(hasLine(P, "Status: planning"));

  // A log the command rewrote, as renumber does, is left as it is and reported.
  pair();
  passes(shellRun(`${DS} review ${SD}/pr2.spec.md needs-changes`), "a verdict before a renumber");
  blocks(
    shellRun(
      `${DS} renumber ${SD}/pr1.spec.md 2=3 && ${DS} review ${SD}/pr1.spec.md ready && ${DS} autopilot ${SD}/pr1.spec.md && ${DS} approve ${SD}/pr1.spec.md && sed -i 's/^Status: auto-approved/Status: implemented/' ${SD}/pr1.spec.md`,
    ),
    "rewrote it alongside a change undone above",
    "a rewritten log is left and reported",
  );
  const pairLog = read(`${SD}/log`);
  assert.ok(
    hasLine(`${SD}/pr1.spec.md`, "Status: planning") &&
      /^pr1: approve /m.test(pairLog) &&
      /^pr3: review /m.test(pairLog),
  );
  fs.rmSync(SD, { recursive: true });

  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "approved");
  passes(
    editGuard(P, "Status: approved", "Status: reviewed"),
    "reviewed before its Tip ranks as reviewed",
  );
  passes(
    shellRun(
      `ln ${P} ${TMP}/hard; sed 's/^Status: approved/Status: planning/' ${P} > ${TMP}/soft; ln -sf ${TMP}/soft ${D}/pr2.spec.md`,
    ),
    "links pass",
  );
  assert.ok(
    fs.statSync(P).nlink === 1 && !fs.lstatSync(`${D}/pr2.spec.md`).isSymbolicLink(),
    "links not replaced",
  );
  for (const f of [`${D}/pr2.spec.md`, `${TMP}/hard`, `${TMP}/soft`]) fs.rmSync(f, { force: true });
  fs.mkdirSync(`${PD}/99_locked`, { mode: 0o000 });
  blocks(
    shellRun(`sed -i 's/^Status: approved/Status: planning/' ${P}`),
    below,
    "an unreadable entry leaves the guard on",
  );
  fs.chmodSync(`${PD}/99_locked`, 0o700);
  fs.rmdirSync(`${PD}/99_locked`);
  const other = `${TMP}/other-repo/docs/plans/5_x/pr1.spec.md`;
  write(other, "# O\nStatus: ready\nSpec: -\n");
  passes(
    shellRun(`sed -i 's/^Status: ready/Status: approved/' ${other}`),
    "another repository's plans are out of scope",
  );
  assert.ok(hasLine(other, "Status: approved"));
  fs.rmSync(`${TMP}/other-repo`, { recursive: true });
  call({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    session_id: "s1",
    tool_input: { command: "true" },
  });
  const runtime = process.env["XDG_RUNTIME_DIR"] || process.env["TMPDIR"] || "/tmp";
  assert.ok(
    !fs.existsSync(`${runtime}/dev-gate-check-${process.getuid?.()}/s1`),
    "no snapshot without a tool_use_id",
  );

  fs.rmSync(`${D}/log`, { force: true });
  writePlan(P, "ready");
  blocks(
    shellRun(`printf '# New\\nStatus: approved\\n' > ${D}/pr7.spec.md`),
    "which only the user sets",
    "a new approved plan",
  );
  assert.ok(
    hasLine(`${D}/pr7.spec.md`, "Status: planning"),
    "new approved plan not set to planning",
  );
  fs.rmSync(`${D}/pr7.spec.md`);
  passes(
    shellRun(
      `sed -i 's/Gate/Skip/' ${P} && grep 'Status: approved' ${P}; echo 'wait for Status: approved'`,
    ),
    "a mention of approved in another command passes",
  );
  const id = `failed${Math.random().toString(36).slice(2)}`;
  call({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: id,
    tool_input: { command: "x" },
  });
  sub(P, /^Status: ready/m, "Status: approved");
  blocks(
    call({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: { command: "x" },
    }),
    "which only the user sets",
    "a failed command is checked too",
  );
  passes(
    call({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "never-snapshotted",
      tool_input: { command: "true" },
    }),
    "a post check without its snapshot passes",
  );
  writePlan(P, "published");
  blocks(
    editGuard(P, "Status: published", "Status: reviewed"),
    "is published",
    "a published plan takes no edit",
  );
  passes(editGuard(`${repo}/README.md`, "seed", "x"), "files outside docs/plans pass");
});
