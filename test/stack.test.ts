// dev-stack.ts against scratch repositories: the stack listing, check, review verdicts, and next,
// whose runnable actions must pass their gates. The tests run in order over one repository.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { b, utf8 } from "../plugins/dev/core/bytes.ts";
import { PlanLib } from "../plugins/dev/core/plan-lib.ts";
import { devStack } from "../plugins/dev/core/stack.ts";
import { design, type Env, gate, git, read, repo, run, tmp, write } from "./helpers.ts";

const ROOT = tmp("dev-stack-test");
const WTROOT = `${ROOT}/worktrees`;
const ENV = { AI_WORKTREES_ROOT: WTROOT };
const REPO = repo(`${ROOT}/repo`);
write(`${REPO}/README.md`, "seed\n");
git(REPO, "add", "README.md");
git(REPO, "commit", "-qm", "readme");
const DIR = `${REPO}/docs/plans/12_stack`;
const R = `${DIR}/pr1.spec.md`;
const C = `${DIR}/pr2.spec.md`;
const S = `${DIR}/pr3.spec.md`;
const G = `${DIR}/pr4.spec.md`;
const WT = `${WTROOT}/repo-12_stack-pr1`; // the root's own worktree
const NAMES: Record<string, string> = { [R]: "root", [C]: "child", [S]: "sib", [G]: "grand" };
const nameOf = (p: string) => NAMES[p] ?? path.basename(p);

/** A plan fixture; a rewritten fixture is a new plan, so it drops the old one's log lines. */
const writePlan = (plan: string, status: string, branch: string, parent?: string) => {
  write(
    plan,
    `# Stack test\nStatus: ${status}\nSpec: -\nTip: -\nType: feature\nBase: main\nBranch: ${branch}\nIssue: #12\n${
      parent ? `Stacks On: ${parent}\n` : ""
    }\n## Goal\nA ${path.basename(plan)}.\n\n` +
      "## Acceptance Criteria\nAC-1 — outcome\n  Source: request\n  Success: yes\n  Failure: no\n\n" +
      "## Test Cases\nTC-1 — scenario\n  Proves: AC-1\n  Fixture: f\n  Action: a\n  Expected: e\n\n" +
      "## Implementation Steps\nST-1 — change — satisfies TC-1\n",
  );
  const log = `${path.dirname(plan)}/log`;
  const n = /pr([0-9]+)\.spec\.md$/.exec(plan)?.[1];
  if (fs.existsSync(log))
    write(
      log,
      read(log)
        .split("\n")
        .filter((l) => !l.startsWith(`pr${n}: `))
        .join("\n"),
    );
};
const edit = (plan: string, f: (text: string) => string) => write(plan, f(read(plan)));
const setStatus = (plan: string, status: string, tip = "") =>
  edit(plan, (t) =>
    t.replace(/^Status: .*$/m, `Status: ${status}`).replace(/^Tip: .*$/m, `Tip: ${tip || "-"}`),
  );
/** sed's `/^## Goal/a <line>`. */
const addAfterGoal = (plan: string, line: string) =>
  edit(plan, (t) => t.replace(/^## Goal.*$/m, `$&\n${line}`));
const replaceLine = (plan: string, re: RegExp, by: string) => edit(plan, (t) => t.replace(re, by));
const fieldOf = (plan: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, "m").exec(read(plan))?.[1];
const hasLine = (file: string, line: string) => read(file).split("\n").includes(line);
const head = (sha: string) => git(REPO, "rev-parse", sha);

const st = (argv: string[], opts: { cwd?: string; env?: Env } = {}) =>
  run(devStack, argv, { cwd: opts.cwd ?? REPO, env: { ...ENV, ...opts.env } });
const ok = (...argv: string[]) => {
  const r = st(argv);
  assert.equal(r.code, 0, `${argv.join(" ")}: ${r.all}`);
  return r.out.replace(/\n$/, "");
};
const fails = (want: string, ...argv: string[]) => {
  const r = st(argv);
  assert.ok(
    r.code !== 0 && r.all.includes(want),
    `${argv.join(" ")}: expected '${want}': ${r.code} ${r.all}`,
  );
  return r.all;
};
const skillGate = (skill: string, plan: string) =>
  gate({ tool_input: { skill, args: plan } }, { cwd: REPO, env: ENV });

type Row = { plan: string; status: string; parent: string; action: string; reason: string };
const rows = (root: string): Row[] =>
  ok("next", root)
    .split("\n")
    .map((l) => {
      const [plan = "", status = "", parent = "", action = "", ...rest] = l.split("\t");
      return { plan, status, parent, action, reason: rest.join("\t") };
    });
const rowOf = (root: string, plan?: string) => {
  const r = rows(root).find((x) => plan === undefined || x.plan === plan);
  return r === undefined ? "" : `${r.action}|${r.reason}`;
};

/** next's actions as `<name> <action>`, each runnable one checked against its gate. */
const expectNext = (want: string) => {
  const got = rows(R).map(({ plan, action }) => {
    if (["review-feature", "execute-feature", "review-code", "create-pr"].includes(action))
      assert.equal(
        skillGate(`dev-${action}`, plan),
        "",
        `next offers ${action} for ${plan}, which its gate blocks`,
      );
    return `${nameOf(plan)} ${action}`;
  });
  assert.equal(got.join(" "), want);
};

const lib = () =>
  new PlanLib(b(REPO), { cwd: b(REPO), env: { HOME: b(ROOT), AI_WORKTREES_ROOT: b(WTROOT) } });

test("worktrees default to ~/wt", () => {
  assert.equal(
    new PlanLib(b(REPO), { cwd: b(REPO), env: { HOME: b(ROOT) } }).worktreesRoot,
    `${ROOT}/wt`,
  );
});

test("stack lists the stack from its root", () => {
  writePlan(R, "planning", "feat/root");
  writePlan(C, "planning", "feat/child", "pr1");
  writePlan(S, "planning", "feat/sib", "pr1");
  writePlan(G, "planning", "feat/grand", "pr2");
  assert.equal(ok("stack", R), [R, C, S, G].join("\n"));
  // A plan path may start with ~.
  assert.ok(
    st(["stack", "~/repo/docs/plans/12_stack/pr1.spec.md"], { env: { HOME: ROOT } }).out.startsWith(
      `${R}\n`,
    ),
  );
  git(REPO, "worktree", "add", "-q", WT, "-b", "feat/root", "main");
  assert.equal(
    st(["stack", R], { cwd: WT }).out.trim().split("\n").length,
    4,
    "stack from a worktree",
  );
  fails(`stacks on ${R}; pass the stack's root`, "stack", C);
  fails("Plan must be", "stack", `${REPO}/README.md`);
  fails("Plan must be", "stack", `${ROOT}/other/docs/plans/12_stack/pr1.spec.md`);
  replaceLine(G, /^Stacks On: .*$/m, "- Stacks On: pr2");
  fails(`Unreadable 'Stacks On:' lines in: ${G}`, "stack", R);
  writePlan(G, "planning", "feat/grand", "pr4");
  fails(`Unreadable 'Stacks On:' lines in: ${G}`, "stack", R);
  writePlan(G, "planning", "feat/grand");
  fails("more than one plan without a", "stack", R);
  writePlan(G, "planning", "feat/grand", "pr2");
});

test("check", () => {
  assert.equal(ok("check", R), [R, C, S, G].map((p) => `PASS ${p}`).join("\n"));
  const exclude = `${REPO}/.git/info/exclude`;
  const saved = read(exclude);
  write(exclude, "");
  fails("does not ignore docs/plans", "check", R);
  // Git runs under the caller's env, as core reads it: here its global config ignores the plans.
  write(`${ROOT}/ignore-plans`, "/docs/plans/\n");
  write(`${ROOT}/gitconfig`, `[core]\n\texcludesFile = ${ROOT}/ignore-plans\n`);
  assert.equal(
    st(["check", R], { env: { GIT_CONFIG_GLOBAL: `${ROOT}/gitconfig` } }).code,
    0,
    "git did not run under the caller's GIT_CONFIG_GLOBAL",
  );
  write(exclude, saved);

  replaceLine(S, /^ {2}Proves: AC-1$/m, "  Proves: AC-9");
  let out = fails("", "check", R);
  assert.ok(new RegExp(`BLOCK ${S}\\n[\\s\\S]*AC-9`).test(out) && out.includes(`PASS ${G}`), out);
  writePlan(S, "planning", "feat/sib", "pr1");

  ok("review", R, "ready");
  setStatus(R, "approved");
  const specR = fieldOf(R, "Spec");
  replaceLine(C, /^ {2}Proves: AC-1$/m, "  Proves: AC-9");
  out = fails("", "check", R);
  assert.ok(out.startsWith(`SKIP ${R} (approved)\nBLOCK ${C}\n`), out);
  writePlan(C, "planning", "feat/child", "pr1");
  replaceLine(R, /^A pr1/m, "An edited pr1");
  out = fails("", "check", R);
  assert.ok(
    out.startsWith(
      `BLOCK ${R}\nIt is frozen: its spec, or a spec below it, changed since its approval at `,
    ),
    out,
  );
  assert.ok(hasLine(`${DIR}/log`, `pr1: approve approved at ${specR}`), read(`${DIR}/log`));

  ok("reopen", R);
  writePlan(R, "planning", "feat/root");
  replaceLine(R, /^Branch: .*$/m, "Branch: main");
  out = fails("Branch is its Base", "check", R);
  assert.ok(out.startsWith(`BLOCK ${R}\n`), out);
  writePlan(R, "planning", "feat/root");
  replaceLine(S, /^Branch: .*$/m, "Branch: main");
  out = fails("Branch is its Base", "check", R);
  assert.ok(new RegExp(`BLOCK ${S}\\n[\\s\\S]*Branch is its Base`).test(out), out);
  writePlan(S, "planning", "feat/sib", "pr1");

  fails(`stacks on ${R}; pass the stack's root`, "check", C);
  replaceLine(G, /^Stacks On: .*$/m, "- Stacks On: pr2");
  fails(`Unreadable 'Stacks On:' lines in: ${G}`, "check", R);
  writePlan(G, "planning", "feat/grand");
  fails("more than one plan without a", "check", R);
  writePlan(G, "planning", "feat/grand", "pr2");

  setStatus(R, "needs-changes");
  setStatus(C, "ready");
  ok("check", R);
  setStatus(C, "planning");
  setStatus(R, "published");
  fails("is published; no phase resumes it", "check", R);
  assert.ok(
    design(C, { cwd: REPO, env: ENV }).includes(
      "is published, and a published plan never becomes a parent",
    ),
  );
  setStatus(R, "planning");
  assert.ok(design("", { cwd: REPO, env: ENV }).includes("none was named"));
  assert.ok(skillGate("dev-review-feature", C).includes("needs it 'approved'"));

  // A gate that crashes blocks each plan without stopping the check. The command's own check
  // that Git ignores the plans runs first; each gate's runs after it.
  const plansIgnored = PlanLib.prototype.plansIgnored;
  let calls = 0;
  PlanLib.prototype.plansIgnored = () => {
    if (calls++ === 0) return true;
    throw new Error("boom");
  };
  try {
    out = fails("", "check", R);
  } finally {
    PlanLib.prototype.plansIgnored = plansIgnored;
  }
  for (const p of [R, C, S, G])
    assert.ok(
      out.includes(`BLOCK ${p}\ngate-check.js failed (boom) before reaching a verdict`),
      out,
    );
  ok("check", R);
});

test("next and review verdicts", () => {
  expectNext("root review-feature child wait-parent sib wait-parent grand wait-parent");
  fails("Usage", "review", R, "maybe");
  const lines = read(R).split("\n").length;
  const out = ok("review", R, "ready");
  assert.ok(
    out.startsWith("Status: ready, Spec: ") &&
      out.endsWith(` recorded in ${R}, review-feature round 1/3`),
    out,
  );
  assert.match(
    read(R).split("\n").slice(1, 8).join(" "),
    /^Status: ready Spec: [0-9a-f]{40} Tip: - Type: feature Base: main Branch: feat\/root Issue: #12$/,
  );
  assert.equal(read(R).split("\n").length, lines, "review appended a line");
  expectNext("root wait-user child wait-parent sib wait-parent grand wait-parent");
  replaceLine(R, /^A pr1/m, "An edited pr1");
  expectNext("root review-feature child wait-parent sib wait-parent grand wait-parent");
  ok("review", R, "needs-changes");
  assert.ok(hasLine(R, "Status: needs-changes") && /^Spec: [0-9a-f]{40}$/m.test(read(R)));
  expectNext("root revise child wait-parent sib wait-parent grand wait-parent");
  replaceLine(R, /^An edited pr1/m, "A revised pr1");
  expectNext("root review-feature child wait-parent sib wait-parent grand wait-parent");
  ok("review", R, "ready");
  const spec = fieldOf(R, "Spec");
  setStatus(R, "approved");
  assert.equal(fieldOf(R, "Spec"), spec, "approval changed the Spec hash");
  fails("a verdict records only before approval", "review", R, "ready");
  expectNext("root execute-feature child review-feature sib review-feature grand wait-parent");
  ok("review", C, "ready");
  addAfterGoal(R, "Revised contract.");
  expectNext("root blocked child review-feature sib review-feature grand wait-parent");
  setStatus(R, "planning");
  fails("is frozen: it was approved at", "review", R, "ready");
  assert.ok(rowOf(R).startsWith("blocked|it was approved at "), rowOf(R));
  ok("reopen", R);
  assert.ok(hasLine(R, "Status: planning"), "reopen kept the approval");
  ok("review", R, "ready");
  setStatus(R, "approved");
  ok("review", C, "ready");
  setStatus(C, "approved");
  expectNext("root execute-feature child wait-parent sib review-feature grand review-feature");
});

test("approve: an agent's approval, as auto-approved", () => {
  const holds = "approve needs a ready plan whose review still holds";
  fails(holds, "approve", S);
  ok("review", S, "ready");
  addAfterGoal(S, "Edited after review.");
  fails(holds, "approve", S);
  writePlan(S, "planning", "feat/sib", "pr1");
  const hash = utf8(lib().planHash(b(S)) ?? "");
  assert.match(hash, /^[0-9a-f]{40}$/);
  edit(S, (t) =>
    t.replace(/^Status: .*$/m, "Status: ready").replace(/^Spec: .*$/m, `Spec: ${hash}`),
  );
  fails("no ready verdict from dev-stack.js review", "approve", S);
  writePlan(S, "planning", "feat/sib", "pr1");
  ok("review", S, "ready");
  ok("stop", S, "Failed fixes: 3/3 — test");
  fails("is stopped", "approve", S);
  ok("resume", S);
  const spec = fieldOf(S, "Spec");
  assert.equal(ok("approve", S), `Status: auto-approved recorded in ${S}`);
  assert.ok(hasLine(S, "Status: auto-approved") && hasLine(S, `Spec: ${spec}`));
  fails(holds, "approve", S);
  assert.ok(skillGate("dev-review-feature", S).includes("already auto-approved"));
  expectNext("root execute-feature child wait-parent sib wait-parent grand review-feature");
  setStatus(R, "auto-approved");
  setStatus(C, "ready");
  ok("review", G, "ready");
  fails(`${C} must be approved or auto-approved first`, "approve", G);
  setStatus(C, "auto-approved");
  expectNext("root execute-feature child wait-parent sib wait-parent grand wait-user");
  assert.equal(skillGate("dev-review-feature", G), "");
  assert.equal(
    ok("next", R, "--md").split("\n")[2],
    "| pr1 | 🔷 auto-approved | - | ▶ execute-feature | - |",
  );
  assert.equal(ok("check", R).split("\n")[0], `SKIP ${R} (auto-approved)`);
  assert.ok(skillGate("dev-review-code", R).includes("not yet implemented"));
  assert.ok(skillGate("dev-create-pr", R).includes("not yet executed"));
  addAfterGoal(R, "Stale edit.");
  assert.ok(
    rowOf(R).startsWith("blocked|"),
    "an auto-approved plan with a changed spec was not blocked",
  );
  edit(R, (t) => t.replace("Stale edit.\n", ""));
  fails("Usage", "approve", G, "extra");
  setStatus(G, "published");
  fails("is published; no phase resumes it", "approve", G);
  writePlan(G, "planning", "feat/grand", "pr2");
  ok("review", G, "ready");
  setStatus(G, "planning");
  fails(holds, "approve", G);
  assert.ok(
    rowOf(R, G).startsWith("revise|"),
    "a plan returned to planning with a ready Spec goes to revise",
  );
  ok("review", G, "needs-changes");
  fails(holds, "approve", G);
  assert.equal(
    gate(
      { hook_event_name: "UserPromptSubmit", prompt: `/dev-autopilot ${R} answers` },
      { cwd: REPO },
    ),
    "",
  );
  setStatus(R, "approved");
  setStatus(C, "approved");
  writePlan(S, "planning", "feat/sib", "pr1");
  writePlan(G, "planning", "feat/grand", "pr2");
});

test("next views", () => {
  const md = ok("next", R, "--md").split("\n");
  assert.deepEqual(md.slice(0, 2), [
    "| plan | status | parent | action | reason |",
    "|---|---|---|---|---|",
  ]);
  assert.equal(md[2], "| pr1 | 🔵 approved | - | ▶ execute-feature | - |");
  assert.equal(md[3], "| pr2 | 🔵 approved | pr1 | ⏳ wait-parent | pr1 must be reviewed first |");
  assert.equal(md.length, 6);
  fails("Usage", "next", R, "--json");
  assert.equal(ok("next", R, "--tab"), ok("next", R));
  assert.equal(
    ok("next", R, "--tree"),
    [
      "pr1 🔵 approved  ▶ execute-feature",
      "├─ pr2 🔵 approved  ⏳ wait-parent — pr1 must be reviewed first",
      "│  └─ pr4 ⚪ planning  ▶ review-feature",
      "└─ pr3 ⚪ planning  ▶ review-feature",
    ].join("\n"),
  );
});

test("runnable actions are the gate's", () => {
  setStatus(R, "implemented");
  assert.ok(
    rowOf(R).startsWith(
      "blocked|review-code: Found no 'test(red):' commit between main and feat/root ",
    ),
    rowOf(R),
  );
  assert.ok(
    ok("next", R, "--md")
      .split("\n")[2]
      ?.includes("| ⛔ blocked | review-code: Found no 'test(red):' commit"),
  );
  const seed = head("HEAD");
  for (const p of [R, C, S]) setStatus(p, "reviewed", seed);
  expectNext("root done child done sib done grand review-feature");
  setStatus(R, "implemented");
  expectNext("root blocked child blocked sib blocked grand review-feature");
  git(REPO, "commit", "-q", "--allow-empty", "-m", "fix: root repair");
  setStatus(R, "reviewed", head("HEAD"));
  assert.ok(
    rowOf(R, C).startsWith(`blocked|its reviewed SHA does not contain ${R}'s`),
    rowOf(R, C),
  );
  for (const p of [C, S, G]) setStatus(p, "reviewed", head("HEAD"));
  assert.ok(rowOf(R).startsWith("blocked|create-pr: "), rowOf(R));
  setStatus(G, "bogus");
  assert.equal(rowOf(R, G), "blocked|unknown status 'bogus'");
  setStatus(G, "published");
  assert.equal(rows(R).length, 3, "a published plan is listed");
  fails("is published", "review", G, "ready");
  for (const p of [R, C, S]) setStatus(p, "published");
  expectNext("root done child done sib done grand done");
  assert.deepEqual([...new Set(rows(R).map((r) => r.status))], ["published"]);
  assert.equal(
    ok("next", R, "--tree"),
    "pr1 🟣 published  ✅ done\n├─ pr2 🟣 published  ✅ done\n│  └─ pr4 🟣 published  ✅ done\n└─ pr3 🟣 published  ✅ done",
  );
  assert.equal(ok("stack", R).split("\n").length, 4);
  assert.equal(ok("next", R, "--md").split("\n")[2], "| pr1 | 🟣 published | - | ✅ done | - |");
  fails("is published", "stop", R, "why");
  fails("is published", "review", R, "ready");
  fails("is published", "resume", R);
  fails("is published", "check", R);
  const tree = st(["next", C, "--tree"], { env: { INCLUDE_PUBLISHED: "1" } });
  assert.ok(
    tree.code !== 0 && tree.all.includes("pass the stack's root") && !tree.all.includes("blocked"),
    tree.all,
  );
  for (const p of [R, C, S]) setStatus(p, "reviewed", head("HEAD"));
  writePlan(G, "planning", "feat/grand", "pr2");
});

test("run stops", () => {
  writePlan(S, "planning", "feat/sib", "pr1");
  const reason = () => rowOf(R, S);
  const stopped = () => reason().startsWith("stopped");
  fails("one nonempty line", "stop", S, "a\tb");
  ok("stop", S, "review round limit; Failed fixes: 2/3 — x");
  assert.equal(reason(), "stopped|review round limit; Failed fixes: 2/3 — x");
  fails("is stopped: review round limit", "review", S, "ready");
  assert.ok(stopped(), "a refused verdict cleared the stop");
  addAfterGoal(S, "Revised scope.");
  assert.ok(reason().startsWith("review-feature"), `a spec edit clears a stop: ${reason()}`);
  ok("stop", S, "needs a decision");
  setStatus(S, "approved");
  assert.ok(!stopped(), "a status change kept the stop");
  setStatus(S, "planning");
  ok("stop", S, "needs a decision");
  ok("resume", S);
  assert.ok(!stopped(), "resume kept the stop");
  ok("review", S, "ready");
  ok("stop", S, "x");
  ok("resume", S);
  assert.ok(reason().startsWith("wait-user"), `a stop voided the review: ${reason()}`);

  git(WT, "switch", "-q", "-c", "feat/sib");
  ok("stop", S, "three failed fixes");
  assert.ok(stopped());
  git(WT, "switch", "-q", "feat/root");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: the parent");
  assert.ok(stopped(), "switching the worktree or committing to another branch cleared the stop");
  git(WT, "switch", "-q", "feat/sib");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: by hand");
  assert.ok(!stopped(), "a new commit on the plan's branch kept the stop");

  ok("stop", S, "Failed fixes: 3/3 — TC-1 fails");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: another try");
  addAfterGoal(S, "Narrowed scope.");
  assert.equal(reason(), "stopped|Failed fixes: 3/3 — TC-1 fails");
  ok("resume", S);
  assert.ok(!stopped(), "resume kept three failed fixes");
  ok("stop", S, "Failed fixes: 1/3 — a; Failed fixes: 3/3 — b");
  ok("stop", S, "needs repair");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: one more");
  assert.equal(reason(), "stopped|Failed fixes: 1/3 — a; Failed fixes: 3/3 — b");
  ok("resume", S);
  ok("stop", S, "Failed fixes: 3/30 — below its limit");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: and another");
  assert.ok(!stopped(), "a count below its limit held");
  ok("stop", S, "Failed fixes: 4/6 — after a grant");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: under the raised limit");
  assert.ok(!stopped(), "a count below its raised limit held");
  ok("stop", S, "Failed fixes: 6/6 — at the raised limit");
  git(WT, "commit", "-q", "--allow-empty", "-m", "fix: past it");
  assert.equal(reason(), "stopped|Failed fixes: 6/6 — at the raised limit");
  ok("resume", S);
  assert.ok(
    ok("next", R, "--md")
      .split("\n")
      .filter((l) => l.startsWith("| ")).length >= 5,
  );
});

test("records and failures", () => {
  writePlan(S, "planning", "feat/sib", "pr1");
  ok("review", S, "ready");
  replaceLine(S, /^Spec: .*$/m, "Spec: nothex");
  assert.ok(rowOf(R, S).startsWith("review-feature|"), "a malformed Spec counts as a verdict");
  writePlan(S, "planning", "feat/sib", "pr1");
  edit(S, (t) => t.replace("Spec: -\n", "").replace("Tip: -\n", ""));
  ok("review", S, "ready");
  assert.match(
    read(S).split("\n").slice(1, 4).join(" "),
    /^Status: ready Spec: [0-9a-f]{40} Type: feature$/,
  );
  assert.ok(rowOf(R, S).startsWith("wait-user|"), "an added Spec is not current");
  const X = `${DIR}/pr7.spec.md`;
  writePlan(X, "planning", "feat/x", "pr6");
  fails("Cannot hash", "stop", X, "x");
  assert.ok(!/^pr7: stop/m.test(read(`${DIR}/log`)), "a failed stop wrote a record");
  fails("Cannot hash", "review", X, "ready");
  assert.ok(hasLine(X, "Status: planning"), "review changed Status after a hash failure");
  fails("Unreadable", "next", R);
});

const E = `${REPO}/docs/plans/12_extra`;

test("views of a second stack: multi-line reasons and number order", () => {
  writePlan(`${E}/pr1.spec.md`, "planning", "feat/e1");
  writePlan(`${E}/pr2.spec.md`, "planning", "feat/e2", "pr1");
  writePlan(`${E}/pr10.spec.md`, "planning", "feat/e10", "pr1");
  fs.appendFileSync(`${E}/pr1.spec.md`, "ST-2 — orphan\n");
  const tree = ok("next", `${E}/pr1.spec.md`, "--tree").split("\n");
  assert.equal(tree.length, 3);
  assert.match(tree[0] ?? "", /is not closed.*ST-2 has no satisfies clause/);
  assert.deepEqual(
    tree.slice(1).map((l) => l.split(" ").slice(0, 2).join(" ")),
    ["├─ pr2", "└─ pr10"],
  );
  assert.equal(ok("next", `${E}/pr1.spec.md`, "--md").split("\n").length, 5);
  assert.equal(ok("next", `${E}/pr1.spec.md`).split("\n").length, 3);
  fails("Usage", "next", `${E}/pr1.spec.md`, "--md", "--tree");
});

test("the review hash ignores only the Status, Spec, and Tip values", () => {
  const H = `${E}/pr1.spec.md`;
  writePlan(H, "planning", "feat/e1");
  ok("review", H, "ready");
  setStatus(H, "reviewed", "0".repeat(40));
  assert.equal(lib().reviewState(b(H)), "ready");
  fs.appendFileSync(H, "Note: added later\n");
  assert.equal(lib().reviewState(b(H)), "stale");
});

test("the stack log: review rounds, approvals, and code-review rounds", () => {
  const L = `${REPO}/docs/plans/12_log`;
  const L1 = `${L}/pr1.spec.md`;
  writePlan(L1, "planning", "feat/l1");
  assert.ok(ok("review", L1, "needs-changes").endsWith(", review-feature round 1/3"));
  assert.ok(
    rowOf(L1).startsWith("revise|review-feature needs-changes (1/3); revise it"),
    rowOf(L1),
  );
  addAfterGoal(L1, "Revision one.");
  assert.equal(rowOf(L1), "review-feature|round 2/3");
  ok("review", L1, "needs-changes");
  addAfterGoal(L1, "Revision two.");
  assert.match(
    ok("review", L1, "needs-changes"),
    /round 3\/3[\s\S]*Stopped: review-feature round limit \(3\/3\)/,
  );
  const log = read(`${L}/log`);
  assert.match(log, /^pr1: review needs-changes \(3\/3\) at [0-9a-f]{40}$/m);
  assert.match(log, /^pr1: stop review-feature round limit \(3\/3\) at [0-9a-f]{40}$/m);
  addAfterGoal(L1, "Revision three.");
  assert.equal(rowOf(L1), "stopped|review-feature round limit (3/3)");
  fails("is stopped: review-feature round limit (3/3)", "review", L1, "ready");
  ok("resume", L1);
  assert.equal(rowOf(L1), "review-feature|round 4/6");
  assert.ok(ok("review", L1, "ready").endsWith("round 4/6"));
  const spec = fieldOf(L1, "Spec");
  ok("approve", L1);
  assert.ok(hasLine(`${L}/log`, `pr1: approve auto-approved at ${spec}`), read(`${L}/log`));
  fails("review-code verdicts record on an implemented plan", "code-review", L1, "pass");
  setStatus(L1, "implemented");
  fails("Usage", "code-review", L1, "maybe");
  ok("code-review", L1, "needs-changes");
  ok("code-review", L1, "needs-changes");
  assert.match(
    ok("code-review", L1, "needs-changes"),
    /round 3\/3[\s\S]*Stopped: review-code round limit \(3\/3\)/,
  );
  assert.equal(rowOf(L1), "stopped|review-code round limit (3/3)");
  ok("resume", L1);
  assert.ok(ok("code-review", L1, "pass").includes("round 4/6"));
  assert.ok(
    ok("code-review", L1, "needs-changes").includes("round 1/3"),
    "a pass did not end the review-code phase",
  );
});

test("reopen", () => {
  const Q = `${REPO}/docs/plans/12_reopen`;
  const [Q1, Q2, Q3] = [1, 2, 3].map((n) => `${Q}/pr${n}.spec.md`) as [string, string, string];
  writePlan(Q1, "planning", "feat/q1");
  writePlan(Q2, "planning", "feat/q2", "pr1");
  writePlan(Q3, "planning", "feat/q3", "pr1");
  ok("review", Q1, "ready");
  ok("approve", Q1);
  ok("review", Q2, "ready");
  setStatus(Q2, "approved");
  fails("reopen takes a plan approved or later", "reopen", Q3);
  ok("stop", Q1, "Failed fixes: 3/3 — tests");
  assert.ok(rowOf(Q1).startsWith("stopped"), rowOf(Q1));
  for (const q of [Q1, Q2]) replaceLine(q, /^Tip: .*$/m, "Tip: 1234567");
  assert.equal(ok("reopen", Q1), `Reopened to planning: ${Q1} ${Q2}`);
  for (const q of [Q1, Q2, Q3]) assert.ok(hasLine(q, "Status: planning"), q);
  for (const q of [Q1, Q2]) assert.ok(hasLine(q, "Tip: -"), q);
  assert.ok(rowOf(Q1).startsWith("revise"), rowOf(Q1));
  addAfterGoal(Q1, "Reopened change.");
  assert.ok(rowOf(Q1).startsWith("review-feature"), rowOf(Q1));
  assert.ok(ok("review", Q1, "needs-changes").endsWith("review-feature round 1/3"));
});

test("auto-reopen", () => {
  const A = `${REPO}/docs/plans/12_auto`;
  const [A1, A2, A3] = [1, 2, 3].map((n) => `${A}/pr${n}.spec.md`) as [string, string, string];
  writePlan(A1, "planning", "feat/a1");
  writePlan(A2, "planning", "feat/a2", "pr1");
  writePlan(A3, "planning", "feat/a3", "pr2");
  ok("review", A1, "ready");
  ok("approve", A1);
  ok("review", A2, "ready");
  setStatus(A2, "approved");
  ok("next", A1);
  fails("auto-reopen takes a plan approved or later", "auto-reopen", A3);
  fails("carries the user's approval", "auto-reopen", A2);
  fails(`${A2} carries the user's approval`, "auto-reopen", A1);
  assert.ok(hasLine(A1, "Status: auto-approved"), "a refused auto-reopen changed the plan");
  writePlan(A2, "planning", "feat/a2", "pr1");
  ok("review", A2, "ready");
  ok("approve", A2);
  ok("stop", A2, "Failed fixes: 3/3 — tests");
  fails("Only the user clears it", "auto-reopen", A1);
  ok("resume", A2);
  setStatus(A1, "implemented");
  ok("stop", A1, "PC-1 failed");
  assert.equal(ok("auto-reopen", A1), `Auto-reopened to planning: ${A1} ${A2}`);
  for (const a of [A1, A2, A3]) assert.ok(hasLine(a, "Status: planning"), a);
  addAfterGoal(A1, "Revised change.");
  assert.ok(rowOf(A1).startsWith("review-feature"), rowOf(A1));
  assert.ok(ok("review", A1, "ready").endsWith("review-feature round 1/3"));
  ok("approve", A1);
  fails("was auto-reopened once", "auto-reopen", A1);
  ok("reopen", A1);
  assert.ok(hasLine(A1, "Status: planning"));
  fails("was auto-reopened", "drop", A1);

  const U1 = `${REPO}/docs/plans/12_auto-user/pr1.spec.md`;
  writePlan(U1, "planning", "feat/u1");
  ok("review", U1, "ready");
  ok("approve", U1);
  setStatus(U1, "approved");
  ok("next", U1);
  fails("carries the user's approval", "auto-reopen", U1);
  setStatus(U1, "implemented");
  fails("carries the user's approval", "auto-reopen", U1);
});

test("renumber and drop", () => {
  const K = `${REPO}/docs/plans/12_shape`;
  const k = (n: number) => `${K}/pr${n}.spec.md`;
  writePlan(k(1), "planning", "feat/k1");
  writePlan(k(2), "planning", "feat/k2", "pr1");
  writePlan(k(3), "planning", "feat/k3", "pr2");
  ok("review", k(1), "ready");
  ok("approve", k(1));
  ok("review", k(2), "needs-changes");
  fs.chmodSync(`${K}/log`, 0o640);
  ok("renumber", k(1), "3=4", "2=3");
  assert.equal(fs.statSync(`${K}/log`).mode & 0o777, 0o640, "the log keeps its mode");
  assert.ok(
    fs.existsSync(k(3)) && fs.existsSync(k(4)) && !fs.existsSync(k(2)),
    String(fs.readdirSync(K)),
  );
  assert.ok(hasLine(k(3), "Stacks On: pr1") && hasLine(k(4), "Stacks On: pr3"));
  let log = read(`${K}/log`);
  assert.ok(/^pr3: review needs-changes \(1\/3\)/m.test(log) && !/^pr2:/m.test(log), log);
  fails("only an unapproved plan", "renumber", k(1), "1=2");
  fails("pr4 exists and is not renumbered", "renumber", k(1), "3=4");
  fails("a parent's number is below its children's", "renumber", k(1), "3=9");
  fails("Usage", "renumber", k(1), "3:5");
  git(REPO, "branch", "feat/k3");
  fails("Branch feat/k3 exists", "renumber", k(1), "4=5");
  git(REPO, "branch", "-D", "-q", "feat/k3");
  ok("stop", k(3), "Failed fixes: 3/3 — x");
  fails("is stopped: Failed fixes: 3/3", "drop", k(3));
  fails("is stopped", "renumber", k(1), "3=5", "4=6");
  ok("resume", k(3));
  ok("drop", k(3));
  assert.ok(!fs.existsSync(k(3)) && hasLine(k(4), "Stacks On: pr1"));
  log = read(`${K}/log`);
  assert.ok(/^dropped pr3: review/m.test(log) && !/^pr3:/m.test(log), log);
  fails("only an unapproved plan", "drop", k(1));

  const D = `${REPO}/docs/plans/12_droproot`;
  writePlan(`${D}/pr1.spec.md`, "planning", "feat/d1");
  writePlan(`${D}/pr2.spec.md`, "planning", "feat/d2", "pr1");
  writePlan(`${D}/pr3.spec.md`, "planning", "feat/d3", "pr1");
  fs.chmodSync(`${D}/pr2.spec.md`, 0o640);
  const out = ok("drop", `${D}/pr1.spec.md`);
  assert.equal(fs.statSync(`${D}/pr2.spec.md`).mode & 0o777, 0o640, "the new root keeps its mode");
  assert.ok(out.endsWith(`; ${D}/pr2.spec.md is the root`), out);
  assert.ok(
    !/^Stacks On:/m.test(read(`${D}/pr2.spec.md`)) && hasLine(`${D}/pr3.spec.md`, "Stacks On: pr2"),
  );
  assert.equal(ok("stack", `${D}/pr2.spec.md`).split("\n").length, 2);
});

test("header fields", () => {
  const F = `${E}/pr3.spec.md`;
  write(
    F,
    "# Fields\nStatus: planning\nTipping: x\nSpec: old\nSpec: dup\n```\nTip: fenced\n```\n\n## Goal\nTip: body\n",
  );
  assert.equal(lib().field(b(F), "Tip") ?? "", "");
  assert.equal(lib().field(b(F), "Spec"), "old");
  assert.ok(
    lib().setHeader(b(F), [
      ["Status", "ready"],
      ["Spec", "new"],
      ["Tip", "t1"],
    ]),
  );
  assert.equal(
    read(F),
    "# Fields\nStatus: ready\nTip: t1\nTipping: x\nSpec: new\nSpec: dup\n```\nTip: fenced\n```\n\n## Goal\nTip: body\n",
  );
  write(F, "# Fields\nStatus: planning\nType: fix\n");
  assert.ok(lib().setHeader(b(F), [["Spec", "abc"]]));
  assert.equal(read(F), "# Fields\nStatus: planning\nSpec: abc\nType: fix\n");
  write(F, "# Fields\nType: fix\n");
  assert.ok(!lib().setHeader(b(F), [["Status", "x"]]), "setHeader wrote a plan without Status");
  assert.equal(read(F), "# Fields\nType: fix\n");
  assert.deepEqual(
    fs.readdirSync(E).filter((n) => !n.endsWith(".spec.md") && n !== "log"),
    [],
    "a failed setHeader left a temporary file",
  );
  fs.rmSync(F);
});

test("a plan path resolves written absolute or as a @ file mention", () => {
  const root = tmp("dev-stack-path-test");
  const r = repo(`${root}/repo`);
  const dir = `${r}/docs/plans/12_path`;
  const plan = `${dir}/pr1.spec.md`;
  writePlan(plan, "planning", "feat/path");
  const ds = (argv: string[], cwd = r) => run(devStack, argv, { cwd, env: ENV });
  const pathOf = (argv: string[], cwd = r) => {
    const res = ds(argv, cwd);
    assert.equal(res.code, 0, `${argv.join(" ")}: ${res.all}`);
    return res.out.trimEnd();
  };
  assert.equal(pathOf(["stack", plan]), plan, "an absolute path");
  assert.equal(pathOf(["stack", `@${plan}`]), plan, "a @ path that is absolute");
  assert.equal(
    pathOf(["stack", "@docs/plans/12_path/pr1.spec.md"]),
    plan,
    "a @ path relative to the caller's directory",
  );
  assert.equal(
    pathOf(["stack", "@pr1.spec.md"], dir),
    plan,
    "a @ path relative to the caller's directory inside the plans",
  );
  const tilde = run(devStack, ["stack", `~/${path.relative(root, plan)}`], {
    cwd: r,
    env: { ...ENV, HOME: root },
  });
  assert.equal(tilde.code, 0, tilde.all);
  assert.equal(tilde.out.trimEnd(), plan, "a path under ~");
  assert.notEqual(
    ds(["stack", "docs/plans/12_path/pr1.spec.md"]).code,
    0,
    "a relative path without @ does not resolve",
  );
});
