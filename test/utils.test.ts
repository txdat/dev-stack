// dev-utils.ts and dev-worktree.ts. The tests run in order over one repository: the worktree made
// early is the plan worktree the scratch cases must leave alone.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { devUtils } from "../plugins/dev/core/utils.ts";
import { devWorktree } from "../plugins/dev/core/worktree.ts";
import { exec, git, gitOk, read, run, tmp, withEnv, write } from "./helpers.ts";

const ROOT = tmp("dev-utils-test");
const WT = `${ROOT}/worktrees`;
const env = { AI_WORKTREES_ROOT: WT };
const REPO = `${ROOT}/main repo`;

const utils = (argv: string[], cwd = REPO) => run(devUtils, argv, { cwd, env });
const wt = (argv: string[], cwd = REPO) => run(devWorktree, argv, { cwd, env });
const out = (r: { code: number; out: string; all: string }) => {
  assert.equal(r.code, 0, r.all);
  return r.out.replace(/\n$/, "");
};
const rejects = (r: { code: number; all: string }, what: string) =>
  assert.notEqual(r.code, 0, `expected refusal: ${what}: ${r.all}`);
const hasBranch = (b: string) => gitOk(REPO, "rev-parse", "--verify", "-q", `refs/heads/${b}`);
const exists = (p: string) => fs.existsSync(p);
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** A node script on PATH as `name`. */
const stub = (dir: string, name: string, body: string) => {
  write(`${dir}/${name}`, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(`${dir}/${name}`, 0o755);
};

/** `date -I -d 'N days ago'`. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let worktree = "";

test("root resolution and invalid contexts", () => {
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  write(`${REPO}/README.md`, "seed\n");
  git(REPO, "add", "README.md");
  git(REPO, "commit", "-qm", "seed");
  assert.equal(out(utils(["main-root"])), REPO);
  fs.mkdirSync(`${REPO}/nested`);
  assert.equal(out(utils(["main-root"], `${REPO}/nested`)), REPO);
  rejects(utils(["main-root", "extra"]), "main-root extra");
  rejects(utils(["unknown"]), "unknown");
  rejects(utils(["main-root"], ROOT), "outside a repository");
  git(ROOT, "init", "--bare", "-q", `${ROOT}/bare.git`);
  rejects(utils(["main-root"], `${ROOT}/bare.git`), "in a bare repository");
});

test("diagnostic base precedence and missing-base refusal", () => {
  assert.equal(out(utils(["diagnostic-base"])), "refs/heads/main");
  git(REPO, "update-ref", "refs/remotes/origin/release/stable", "HEAD");
  git(REPO, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/stable");
  assert.equal(out(utils(["diagnostic-base"])), "refs/remotes/origin/release/stable");
  git(REPO, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
  assert.equal(out(utils(["diagnostic-base"])), "refs/heads/main");
  git(REPO, "branch", "-m", "main", "topic");
  git(REPO, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(out(utils(["diagnostic-base"])), "refs/remotes/origin/main");
  git(REPO, "update-ref", "-d", "refs/remotes/origin/main");
  rejects(utils(["diagnostic-base"]), "no base");
  git(REPO, "branch", "-m", "topic", "main");
});

test("literal production search and path-based test exclusions", () => {
  for (const p of [
    "src/live.ts",
    "contest/live.ts",
    "src/unit.test.ts",
    "src/unit_spec.py",
    "tests/live.ts",
    "src/tests/live.ts",
    "__tests__/live.ts",
  ])
    write(`${REPO}/${p}`, "needle.with.dot\n");
  write(`${REPO}/src/other.ts`, "needleXwithXdot\n");
  const found = out(utils(["search-production", "needle.with.dot", "."]));
  assert.ok(found.includes("src/live.ts:") && found.includes("contest/live.ts:"), found);
  for (const no of ["unit.", "unit_spec", "tests/", "other.ts"])
    assert.ok(!found.includes(no), found);
  assert.equal(utils(["search-production", "absent", "."]).code, 1);
});

test("worktree creation, root-only plan, explicit parent, and refusal cases", () => {
  git(REPO, "branch", "explicit-parent", "HEAD");
  git(REPO, "commit", "--allow-empty", "-qm", "main diverged");
  const mainTip = git(REPO, "rev-parse", "HEAD");
  const parentTip = git(REPO, "rev-parse", "explicit-parent");
  worktree = out(wt(["create", "task", "feature/task", "explicit-parent"]));
  assert.equal(worktree, `${WT}/main repo-task`);
  assert.equal(git(worktree, "rev-parse", "HEAD"), parentTip);
  assert.equal(git(REPO, "rev-parse", "HEAD"), mainTip);
  assert.equal(out(utils(["main-root"], worktree)), REPO);
  rejects(wt(["create", "task", "feature/other", "explicit-parent"]), "a taken name");
  rejects(wt(["create", "../escape", "feature/escape", "explicit-parent"]), "an escaping name");
  rejects(wt(["create", "missing", "feature/missing", "no-such-parent"]), "a missing parent");
  assert.ok(!exists(`${WT}/main repo-missing`));
  git(REPO, "branch", "feature/kept", "explicit-parent");
  git(worktree, "commit", "--allow-empty", "-qm", "unused");
  const kept = out(wt(["create", "kept", "feature/kept", "main"]));
  assert.equal(
    `${git(kept, "symbolic-ref", "--short", "HEAD")} ${git(kept, "rev-parse", "HEAD")}`,
    `feature/kept ${parentTip}`,
  );
  fs.rmSync(kept, { recursive: true, force: true });
  assert.equal(out(wt(["create", "kept", "feature/kept", "main"])), kept);
  git(REPO, "worktree", "remove", kept);

  // create takes no directories: every worktree is a full checkout.
  rejects(wt(["create", "extra", "feature/extra", "main", "src"]), "create with a directory");
  assert.ok(!exists(`${WT}/main repo-extra`) && !hasBranch("feature/extra"));
});

test("dependency isolation preserves shared and existing local content", () => {
  write(`${REPO}/node_modules/keep.txt`, "shared sentinel\n");
  fs.mkdirSync(`${REPO}/vendor`, { recursive: true });
  write(`${worktree}/vendor/keep.txt`, "local sentinel\n");
  out(wt(["link-deps", worktree]));
  assert.ok(isLink(`${worktree}/node_modules`));
  assert.ok(!isLink(`${worktree}/vendor`));
  assert.equal(fs.readlinkSync(`${worktree}/node_modules`), `${REPO}/node_modules`);
  out(wt(["isolate-dep", worktree, "node_modules"]));
  assert.ok(
    !isLink(`${worktree}/node_modules`) && fs.statSync(`${worktree}/node_modules`).isDirectory(),
  );
  assert.equal(read(`${REPO}/node_modules/keep.txt`), "shared sentinel\n");
  out(wt(["isolate-dep", worktree, "node_modules"]));
  rejects(wt(["link-deps", REPO]), "link-deps on the main root");
  rejects(wt(["link-deps", ROOT]), "link-deps outside");
  rejects(wt(["isolate-dep", worktree, "../node_modules"]), "an escaping dependency");
  write(`${worktree}/not-a-directory`, "file sentinel\n");
  rejects(wt(["isolate-dep", worktree, "not-a-directory"]), "a file dependency");
  assert.equal(read(`${worktree}/not-a-directory`), "file sentinel\n");
});

test("remove deletes clean worktrees and only branches origin already holds", () => {
  git(ROOT, "init", "--bare", "-q", `${ROOT}/origin.git`);
  git(REPO, "remote", "add", "origin", `${ROOT}/origin.git`);
  const make = (name: string) => out(wt(["create", name, `feature/${name}`, "main"]));
  const push = (dir: string, name: string) => git(dir, "push", "-q", "origin", `feature/${name}`);

  const pushed = make("pushed");
  git(pushed, "commit", "-q", "--allow-empty", "-m", "pushed");
  push(pushed, "pushed");
  assert.equal(out(wt(["remove", pushed])), "deleted feature/pushed");
  assert.ok(!exists(pushed) && !hasBranch("feature/pushed"));

  const ahead = make("ahead");
  push(ahead, "ahead");
  git(ahead, "commit", "-q", "--allow-empty", "-m", "unpushed");
  assert.equal(out(wt(["remove", ahead])), "kept feature/ahead");
  assert.ok(!exists(ahead) && hasBranch("feature/ahead"));

  const never = make("never");
  assert.equal(out(wt(["remove", never])), "kept feature/never");
  assert.ok(hasBranch("feature/never"));

  // A stale tracking ref must not stand in for origin after the remote branch is gone.
  const gone = make("gone");
  push(gone, "gone");
  git(REPO, "fetch", "-q", "origin", "feature/gone:refs/remotes/origin/feature/gone");
  exec(["git", `--git-dir=${ROOT}/origin.git`, "branch", "-q", "-D", "feature/gone"]);
  assert.equal(out(wt(["remove", gone])), "kept feature/gone");
  assert.ok(hasBranch("feature/gone"));

  const dirty = make("dirty");
  push(dirty, "dirty");
  write(`${dirty}/scratch.txt`, "untracked\n");
  rejects(wt(["remove", dirty]), "a dirty worktree");
  assert.ok(exists(`${dirty}/scratch.txt`) && hasBranch("feature/dirty"));

  // Each case below would otherwise succeed, so the refusal comes from its own check.
  const extra = make("extra");
  push(extra, "extra");
  rejects(wt(["remove", extra, "--keep-branch"]), "an extra argument");
  assert.ok(exists(extra));

  const detached = make("detached");
  push(detached, "detached");
  git(detached, "checkout", "-q", "--detach");
  rejects(wt(["remove", detached]), "a detached worktree");
  assert.ok(exists(detached));

  // Linked dependencies go as symlinks, ignored or not; the shared main-root content stays.
  const unignored = make("unignored");
  out(wt(["link-deps", unignored, "node_modules"]));
  push(unignored, "unignored");
  assert.equal(out(wt(["remove", unignored])), "deleted feature/unignored");
  fs.appendFileSync(
    `${git(REPO, "rev-parse", "--git-common-dir").replace(/^(?!\/)/, `${REPO}/`)}/info/exclude`,
    "node_modules\n",
  );
  const linked = make("linked");
  out(wt(["link-deps", linked, "node_modules"]));
  push(linked, "linked");
  assert.equal(out(wt(["remove", linked])), "deleted feature/linked");
  assert.equal(read(`${REPO}/node_modules/keep.txt`), "shared sentinel\n");

  rejects(wt(["remove", REPO]), "remove the main root");
  rejects(wt(["remove", ROOT]), "remove outside");
});

test("issue-create arguments and refusals (stubbed)", () => {
  // A local stand-in prints argument boundaries; no GitHub requests are made.
  stub(`${ROOT}/bin`, "gh", 'for (const a of process.argv.slice(2)) console.log("<" + a + ">");');
  const body = `${ROOT}/body with spaces.md`;
  write(body, "body\n");
  withEnv({ PATH: `${ROOT}/bin:${process.env["PATH"]}` }, () => {
    assert.equal(
      out(
        utils([
          "issue-create",
          "Title with spaces",
          body,
          "--label",
          "bug",
          "--milestone",
          "Next release",
        ]),
      ),
      [
        "<issue>",
        "<create>",
        "<--title>",
        "<Title with spaces>",
        "<--body-file>",
        `<${body}>`,
        "<--label>",
        "<bug>",
        "<--milestone>",
        "<Next release>",
      ].join("\n"),
    );
    // A relative body file is the caller's, in its cwd, not the process's.
    assert.match(
      out(utils(["issue-create", "title", "body with spaces.md"], ROOT)),
      /^<--body-file>\n<body with spaces\.md>$/m,
    );
    rejects(utils(["issue-create", "title", "body with spaces.md"]), "not in the caller's cwd");
    rejects(utils(["issue-create", "title", `${ROOT}/missing`]), "a missing body file");
    rejects(utils(["issue-create", "", body]), "an empty title");
  });
});

// The list stand-in records the request and applies dev-utils' own --jq filter to a fixture, so
// the request and the layout are both checked; no GitHub requests are made.
const GH_LIST = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [a, b, ...rest] = process.argv.slice(2);
if (!["issue list", "pr list"].includes(a + " " + b)) { console.error("unsupported: " + a + " " + b); process.exit(2); }
let filter = ".";
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i], v = rest[i + 1];
  if (["--assignee", "--author", "--search", "--limit"].includes(k)) fs.appendFileSync(process.env.GH_ARGS, k.slice(2) + "=" + v + "\\n");
  else if (k === "--json") fs.appendFileSync(process.env.GH_ARGS, "json=" + v + "\\n");
  else if (k === "--jq") filter = v;
  else { console.error("unsupported: " + k); process.exit(2); }
}
const r = spawnSync("jq", ["-r", filter, process.env.GH_FIXTURE], { stdio: "inherit" });
process.exit(r.status ?? 1);`;

const ghArgs = () => read(`${ROOT}/gh-args`).split("\n");
const listWith = (sub: string, fixture: string, argv: string[], gh = `${ROOT}/gh-list`) => {
  write(`${ROOT}/gh-args`, "");
  return withEnv(
    { PATH: `${gh}:${process.env["PATH"]}`, GH_ARGS: `${ROOT}/gh-args`, GH_FIXTURE: fixture },
    () => utils([sub, ...argv]),
  );
};
const row = (listing: string, re: RegExp) =>
  assert.ok(
    listing.split("\n").some((l) => re.test(l)),
    `${re} in:\n${listing}`,
  );

test("recent-issues request and layout (stubbed)", () => {
  stub(`${ROOT}/gh-list`, "gh", GH_LIST);
  write(
    `${ROOT}/issues.json`,
    JSON.stringify([
      {
        number: 7,
        title: "Older, unlabeled",
        state: "OPEN",
        createdAt: "2025-11-02T10:00:00Z",
        labels: [],
      },
      {
        number: 12,
        title: "Fix the flaky gate",
        state: "CLOSED",
        createdAt: "2025-11-01T09:00:00Z",
        labels: [{ name: "bug" }, { name: "p1" }],
      },
    ]),
  );
  write(`${ROOT}/no-issues.json`, "[]\n");
  const listed = out(listWith("recent-issues", `${ROOT}/issues.json`, ["3"]));
  const since = daysAgo(3);
  const args = ghArgs();
  assert.ok(args.includes("assignee=@me"), String(args));
  assert.ok(args.includes(`search=created:>=${since} sort:created-desc`), String(args));
  assert.ok(args.includes("limit=101"), String(args));
  row(listed, new RegExp(`^Issues assigned to @me, created since ${since}:$`));
  row(listed, /^NUMBER +CREATED +STATE +LABELS +TITLE$/);
  row(listed, /^#7 +2025-11-02 +OPEN +Older, unlabeled$/);
  row(listed, /^#12 +2025-11-01 +CLOSED +bug, p1 +Fix the flaky gate$/);
  assert.ok(listed.indexOf("#7 ") < listed.indexOf("#12 "), "the order gh returned");
  out(listWith("recent-issues", `${ROOT}/issues.json`, []));
  assert.ok(
    ghArgs().includes(`search=created:>=${daysAgo(7)} sort:created-desc`),
    "default of 7 days",
  );
  assert.equal(
    out(listWith("recent-issues", `${ROOT}/no-issues.json`, ["2"])),
    `No issues assigned to @me, created since ${daysAgo(2)}.`,
  );
  rejects(listWith("recent-issues", `${ROOT}/issues.json`, ["week"]), "week");
  rejects(listWith("recent-issues", `${ROOT}/issues.json`, ["3", "4"]), "two arguments");
});

test("recent-prs request and layout (stubbed)", () => {
  const pr = (
    n: number,
    title: string,
    createdAt: string,
    isDraft: boolean,
    reviewDecision: string | null,
    statusCheckRollup: unknown[],
  ) => ({
    number: n,
    title,
    state: "OPEN",
    createdAt,
    isDraft,
    reviewDecision,
    statusCheckRollup,
  });
  const check = (conclusion: string | null, status = "COMPLETED") => ({
    __typename: "CheckRun",
    status,
    conclusion,
    name: "c",
  });
  const ctx = (state: string) => ({ __typename: "StatusContext", state, context: "ci" });
  write(
    `${ROOT}/prs.json`,
    JSON.stringify([
      pr(4, "Rewrite the gate", "2025-11-04T09:00:00Z", false, "CHANGES_REQUESTED", [
        check("FAILURE"),
        check(null, "IN_PROGRESS"),
      ]),
      pr(5, "Add recent-prs", "2025-11-03T08:00:00Z", true, "", [ctx("PENDING")]),
      pr(3, "Fix the flaky gate", "2025-11-01T08:00:00Z", false, "APPROVED", [
        check("SUCCESS"),
        ctx("SUCCESS"),
      ]),
      pr(1, "No checks, needs review", "2025-10-30T08:00:00Z", false, "REVIEW_REQUIRED", []),
      pr(6, "Skipped and neutral", "2025-10-29T08:00:00Z", false, "DISMISSED", [
        check("SKIPPED"),
        check("NEUTRAL"),
      ]),
      pr(2, "Cancelled and errored", "2025-10-28T08:00:00Z", false, null, [
        check("CANCELLED"),
        ctx("ERROR"),
      ]),
    ]),
  );
  const opened = out(listWith("recent-prs", `${ROOT}/prs.json`, ["3"]));
  const since = daysAgo(3);
  const args = ghArgs();
  assert.ok(args.includes("author=@me") && !args.includes("assignee=@me"), String(args));
  assert.ok(args.includes(`search=created:>=${since} sort:created-desc`), String(args));
  assert.ok(
    args.includes("json=number,title,state,createdAt,isDraft,reviewDecision,statusCheckRollup"),
    String(args),
  );
  row(opened, new RegExp(`^Pull requests you opened, created since ${since}:$`));
  row(opened, /^NUMBER +CREATED +STATE +REVIEW +CHECKS +TITLE$/);
  row(opened, /^#4 +2025-11-04 +OPEN +changes +fail +Rewrite the gate$/);
  row(opened, /^#5 +2025-11-03 +DRAFT +- +pending +Add recent-prs$/);
  row(opened, /^#3 +2025-11-01 +OPEN +approved +pass +Fix the flaky gate$/);
  row(opened, /^#1 +2025-10-30 +OPEN +required +none +No checks, needs review$/);
  row(opened, /^#6 +2025-10-29 +OPEN +dismissed +pass +Skipped and neutral$/);
  row(opened, /^#2 +2025-10-28 +OPEN +- +fail +Cancelled and errored$/);
  assert.equal(opened.split("\n").filter((l) => /^#[0-9]+ /.test(l)).length, 6);
  out(listWith("recent-prs", `${ROOT}/prs.json`, []));
  assert.ok(
    ghArgs().includes(`search=created:>=${daysAgo(7)} sort:created-desc`),
    "default of 7 days",
  );
  assert.equal(
    out(listWith("recent-prs", `${ROOT}/no-issues.json`, ["2"])),
    `No pull requests you opened, created since ${daysAgo(2)}.`,
  );
  for (const bad of [["week"], ["3", "4"], [""]])
    rejects(listWith("recent-prs", `${ROOT}/prs.json`, bad), String(bad));

  // A failing gh surfaces its own error plus the command's, and no success.
  stub(`${ROOT}/gh-broken`, "gh", 'console.error("boom"); process.exit(4);');
  const broken = listWith("recent-prs", `${ROOT}/prs.json`, ["3"], `${ROOT}/gh-broken`);
  assert.notEqual(broken.code, 0);
  assert.ok(
    broken.err.includes("boom") && broken.err.includes("Cannot list your pull requests."),
    broken.err,
  );

  // A listing is trimmed to the cap, and the trim is announced only when it hid a match: exactly
  // 100 rows is a complete window, 101 is not.
  const bulk = (n: number, name: string) =>
    write(
      `${ROOT}/${name}.json`,
      JSON.stringify(
        Array.from({ length: n }, (_, i) =>
          pr(i + 1, "bulk", "2025-11-01T00:00:00Z", false, "", []),
        ),
      ),
    );
  bulk(100, "exactly-cap");
  bulk(101, "over-cap");
  assert.equal(listWith("recent-prs", `${ROOT}/exactly-cap.json`, ["3"]).err, "");
  const capped = listWith("recent-prs", `${ROOT}/over-cap.json`, ["3"]);
  assert.ok(capped.err.includes("Only the newest 100"), capped.err);
  assert.equal(capped.out.split("\n").filter((l) => /^#[0-9]+ /.test(l)).length, 100);
});

let scratch = "";
let base = "";
let patch = "";

test("scratch creation and refusals", () => {
  // A detached throwaway under the scratch root, made at a ref behind HEAD so a scratch made at
  // HEAD fails, that never reaches a plan's worktree, the main root, or shared dependencies.
  base = git(REPO, "rev-parse", "HEAD");
  git(REPO, "tag", "scratch-ref", base);
  git(REPO, "commit", "-q", "--allow-empty", "-m", "ahead");
  scratch = out(wt(["scratch", "r1", "scratch-ref"]));
  assert.equal(scratch, `${WT}/scratch/main repo-r1`);
  assert.equal(git(scratch, "rev-parse", "HEAD"), base);
  assert.ok(!gitOk(scratch, "symbolic-ref", "-q", "HEAD"), "scratch HEAD is detached");
  assert.ok(isLink(`${scratch}/node_modules`) && isLink(`${scratch}/vendor`));
  rejects(wt(["scratch", "r1", "scratch-ref"]), "a taken scratch");
  rejects(wt(["scratch", "../escape", "scratch-ref"]), "an escaping scratch");
  rejects(wt(["scratch", "r2", "no-such-ref"]), "a missing ref");
  rejects(wt(["scratch", "r2", "scratch-ref", `${ROOT}/missing.patch`]), "a missing patch");
  write(`${worktree}/plan-sentinel.txt`, "plan sentinel\n");
  // Each guard alone: a worktree under the scratch root without a recorded base, and a plan's
  // worktree with one.
  const nobase = `${WT}/scratch/main repo-nobase`;
  git(REPO, "worktree", "add", "-q", "--detach", nobase, "scratch-ref");
  const planBase = `${git(worktree, "rev-parse", "--absolute-git-dir")}/scratch-base`;
  write(planBase, `${base}\n`);
  for (const target of [worktree, REPO, ROOT, nobase]) {
    rejects(wt(["scratch-diff", target]), `scratch-diff ${target}`);
    rejects(wt(["scratch-remove", target]), `scratch-remove ${target}`);
  }
  fs.rmSync(planBase);
  git(REPO, "worktree", "remove", "--force", nobase);
  assert.equal(read(`${worktree}/plan-sentinel.txt`), "plan sentinel\n");
  assert.ok(exists(worktree) && exists(`${REPO}/node_modules`));
});

test("scratch-diff and scratch with patches", () => {
  write(`${scratch}/README.md`, "broken\n");
  write(`${scratch}/tests/repro.txt`, "repro\n");
  write(`${scratch}/tests/other.txt`, "other\n");
  git(scratch, "add", "README.md");
  const staged = git(scratch, "diff", "--cached", "--name-only");
  patch = `${ROOT}/r1.patch`;
  const diff = out(wt(["scratch-diff", scratch]));
  write(patch, `${diff}\n`);
  assert.match(diff, /^\+broken/m);
  assert.ok(diff.includes("tests/repro.txt"));
  assert.ok(!diff.includes("vendor"), "an unignored dependency link stays out");
  assert.equal(git(scratch, "diff", "--cached", "--name-only"), staged);
  const only = out(wt(["scratch-diff", scratch, "--", "tests/repro.txt"]));
  assert.ok(
    only.includes("tests/repro.txt") && !only.includes("README.md") && !only.includes("other.txt"),
  );
  rejects(wt(["scratch-diff", scratch, "tests/repro.txt"]), "paths without --");

  const committed = out(wt(["scratch", "r5", "scratch-ref"]));
  write(`${committed}/README.md`, "committed\n");
  git(committed, "commit", "-qam", "committed");
  assert.match(out(wt(["scratch-diff", committed])), /^\+committed/m);
  write(`${committed}/x.txt`, "x\n");
  assert.ok(!out(wt(["scratch-diff", committed, "--", "x.txt"])).includes("committed"));
  out(wt(["scratch-remove", committed]));

  const rerun = out(wt(["scratch", "r2", "scratch-ref", patch]));
  assert.equal(read(`${rerun}/README.md`), "broken\n");
  assert.equal(read(`${rerun}/tests/repro.txt`), "repro\n");
  out(wt(["scratch-remove", rerun]));

  // A ref that adopted the repro's file still takes the patch; one that changed it does not, and
  // leaves no scratch behind.
  const g = (input: string, ...args: string[]) => {
    const r = exec(["git", "-C", REPO, ...args], { input });
    assert.equal(r.code, 0, r.err);
    return r.out.trim();
  };
  const treeWith = (text: string) => {
    const blob = g(text, "hash-object", "-w", "--stdin");
    const tests = g(`100644 blob ${blob}\trepro.txt\n`, "mktree");
    return g(`${git(REPO, "ls-tree", base)}\n040000 tree ${tests}\ttests\n`, "mktree");
  };
  const adopted = git(REPO, "commit-tree", treeWith("repro\n"), "-p", base, "-m", "adopted");
  const diverged = git(REPO, "commit-tree", treeWith("changed\n"), "-p", base, "-m", "diverged");
  const later = out(wt(["scratch", "r3", adopted, patch]));
  assert.equal(read(`${later}/README.md`), "broken\n");
  out(wt(["scratch-remove", later]));
  rejects(wt(["scratch", "r4", diverged, patch]), "a patch that does not apply");
  assert.ok(!exists(`${WT}/scratch/main repo-r4`));
  assert.ok(!git(REPO, "worktree", "list", "--porcelain").includes("main repo-r4"));

  // Deletions, paths with spaces, and several patches round-trip; an isolated dependency stays out
  // of the diff, and a patch touching a dependency name never writes through a link into the main
  // root.
  fs.rmSync(`${scratch}/README.md`);
  write(`${scratch}/with space.txt`, "spaced\n");
  out(wt(["isolate-dep", scratch, "vendor"]));
  write(`${scratch}/vendor/local.txt`, "local\n");
  write(
    `${ROOT}/r1b.patch`,
    `${out(wt(["scratch-diff", scratch, "--", "README.md", "with space.txt"]))}\n`,
  );
  assert.ok(!out(wt(["scratch-diff", scratch])).includes("vendor"));
  write(`${REPO}/vendor/shared.txt`, "shared\n");
  write(
    `${ROOT}/dep.patch`,
    "diff --git a/vendor/shared.txt b/vendor/shared.txt\nnew file mode 100644\n--- /dev/null\n+++ b/vendor/shared.txt\n@@ -0,0 +1 @@\n+junk\n",
  );
  const both = out(wt(["scratch", "r6", "scratch-ref", `${ROOT}/r1b.patch`, `${ROOT}/dep.patch`]));
  assert.ok(!exists(`${both}/README.md`), "a deletion round-trips");
  assert.equal(read(`${both}/with space.txt`), "spaced\n");
  assert.equal(read(`${REPO}/vendor/shared.txt`), "shared\n");
  out(wt(["scratch-remove", both]));
  git(worktree, "commit", "-q", "--allow-empty", "-m", "worktree only");
  const here = out(wt(["scratch", "r7", "HEAD"], worktree));
  assert.equal(git(here, "rev-parse", "HEAD"), git(worktree, "rev-parse", "HEAD"));
  out(wt(["scratch-remove", here]));
  fs.rmSync(`${REPO}/vendor/shared.txt`);
});

test("scratch removal and recreation after loss", () => {
  out(wt(["scratch-remove", scratch]));
  assert.ok(!exists(scratch));
  assert.ok(!git(REPO, "worktree", "list", "--porcelain").includes(`worktree ${scratch}`));
  assert.equal(read(`${REPO}/node_modules/keep.txt`), "shared sentinel\n");
  const lost = out(wt(["scratch", "lost", "scratch-ref"]));
  fs.unlinkSync(`${lost}/node_modules`);
  fs.unlinkSync(`${lost}/vendor`);
  fs.rmSync(lost, { recursive: true, force: true });
  assert.equal(out(wt(["scratch", "lost", "scratch-ref"])), lost);
  out(wt(["scratch-remove", lost]));
  assert.equal(path.basename(lost), "main repo-lost");
});
