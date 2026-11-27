// dev-publish.ts against a local bare origin and a gh stand-in that keeps PRs in a JSON file. No
// GitHub requests are made.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { devPublish } from "../plugins/dev/core/publish.ts";
import { devWorktree } from "../plugins/dev/core/worktree.ts";
import { exec, git, gitOk, read, run, tmp, withEnv, write } from "./helpers.ts";

const ROOT = tmp("dev-publish-test");

const GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const store = process.env.GH_STORE;
if (!fs.existsSync(store)) fs.writeFileSync(store, "[]\\n");
const [a, action, ...rest] = process.argv.slice(2);
if (a !== "pr" || !["list", "create"].includes(action)) { console.error("unsupported: " + process.argv.slice(2).join(" ")); process.exit(2); }
const o = { head: "", base: "", title: "", body: "", state: "open", draft: false };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (k === "--draft") o.draft = true;
  else if (k === "--json") i++;
  else if (k === "--body-file") o.body = fs.readFileSync(rest[++i], "utf8");
  else if (["--head", "--base", "--title", "--state"].includes(k)) o[k.slice(2)] = rest[++i];
  else { console.error("unsupported option: " + k); process.exit(2); }
}
const prs = JSON.parse(fs.readFileSync(store, "utf8"));
if (action === "list") {
  const s = o.state.toUpperCase();
  console.log(JSON.stringify(prs.filter((p) => p.headRefName === o.head && (s === "ALL" || p.state === s))));
} else {
  const n = prs.length + 1;
  const url = "https://github.test/o/r/pull/" + n;
  const oid = execFileSync("git", ["rev-parse", "refs/remotes/origin/" + o.head], { encoding: "utf8" }).trim();
  prs.push({ number: n, url, state: "OPEN", headRefName: o.head, baseRefName: o.base, title: o.title, body: o.body, headRefOid: oid, isDraft: o.draft });
  fs.writeFileSync(store, JSON.stringify(prs));
  console.log(url);
}
`;
write(`${ROOT}/bin/gh`, GH);
fs.chmodSync(`${ROOT}/bin/gh`, 0o755);
const PATH = `${ROOT}/bin:${process.env["PATH"]}`;

type Fixture = ReturnType<typeof newRepo>;

/** A main tree with a bare origin, its plans in docs/plans; Base main ignores build/. */
const newRepo = (name: string) => {
  const dir = `${ROOT}/${name}`;
  git(ROOT, "init", "-q", "--bare", `${dir}/origin.git`);
  fs.mkdirSync(`${dir}/main`, { recursive: true });
  const repo = `${dir}/main`;
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", `${dir}/origin.git`);
  write(`${repo}/.gitignore`, "build/\n");
  write(`${repo}/README.md`, "seed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "seed");
  git(repo, "push", "-q", "origin", "main");
  fs.appendFileSync(`${repo}/.git/info/exclude`, "/docs/plans/\n");
  const store = `${dir}/prs.json`;
  write(store, "[]\n");
  const env = { AI_WORKTREES_ROOT: `${dir}/wt`, GH_STORE: store, PATH };
  const D = `${repo}/docs/plans/7_demo`;
  fs.mkdirSync(D, { recursive: true });

  const publish = (argv: string[], cwd = repo) =>
    withEnv(env, () => run(devPublish, argv, { cwd, env }));
  const ok = (...argv: string[]) => {
    const r = publish(argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.all}`);
    return r.out;
  };
  const fails = (want: string, ...argv: string[]) => {
    const r = publish(argv);
    assert.notEqual(r.code, 0, `expected failure: ${argv.join(" ")}: ${r.all}`);
    assert.ok(r.all.includes(want), `missing '${want}' in: ${r.all}`);
  };
  /** A plan's own worktree on a branch from a parent; its path. */
  const planWorktree = (wtName: string, branch: string, parent: string) => {
    const r = run(devWorktree, ["create", wtName, branch, parent], { cwd: repo, env });
    assert.equal(r.code, 0, r.all);
    return r.out.trim();
  };
  /** What the agent does per plan in create-pr step 2. */
  const openPr = (branch: string, base: string, body: string, draft = false) => {
    git(repo, "push", "-q", "-u", "origin", branch);
    const argv = [
      "gh",
      "pr",
      "create",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      `feat: ${branch}`,
      "--body-file",
      body,
    ];
    const r = exec(draft ? [...argv, "--draft"] : argv, {
      cwd: repo,
      env: { ...process.env, ...env },
    });
    assert.equal(r.code, 0, r.all);
  };
  const prs = (): Record<string, unknown>[] => JSON.parse(read(store));
  const editPr = (i: number, fields: Record<string, unknown>) => {
    const all = prs();
    all[i] = { ...all[i], ...fields };
    write(store, JSON.stringify(all));
  };
  const sha = (ref: string) => git(repo, "rev-parse", ref);
  /** create-pr's removal after publish: dev-worktree.js remove. */
  const remove = (...argv: string[]) => run(devWorktree, ["remove", ...argv], { cwd: repo, env });
  return { dir, repo, env, D, publish, ok, fails, planWorktree, openPr, prs, editPr, sha, remove };
};

/** A commit of a file named `name` on the worktree's current branch. */
const commitFile = (wt: string, name: string) => {
  write(`${wt}/${name}`, `${name}\n`);
  git(wt, "add", ".");
  git(wt, "commit", "-qm", `feat: ${name}`);
};

const writePlan = (file: string, branch: string, tip: string, stacksOn?: string) =>
  write(
    file,
    `# Publish demo\nStatus: reviewed\nSpec: -\nTip: ${tip || "-"}\nType: feature\nBase: main\nBranch: ${branch}\nIssue: #7\n${
      stacksOn ? `Stacks On: ${stacksOn}\n` : ""
    }\n## Goal\nPublish.\n`,
  );

/** What review-code records. */
const reviewed = (plan: string, tip: string) =>
  write(
    plan,
    read(plan)
      .replace(/^Status: .*$/m, "Status: reviewed")
      .replace(/^Tip: .*$/m, `Tip: ${tip || "-"}`),
  );

const statusOf = (plan: string) => /^Status: ([a-z]*)/m.exec(read(plan))?.[1];

test("a parent and its only child, each in its own worktree, from check through removal", () => {
  const f: Fixture = newRepo("chain");
  const { repo, D, ok, fails, planWorktree, openPr, editPr, sha, remove } = f;
  const P1 = `${D}/pr1.spec.md`;
  const P2 = `${D}/pr2.spec.md`;
  const wt = planWorktree("7_demo-pr1", "feat/demo-1", "main");
  commitFile(wt, "one.txt");
  const wt2 = planWorktree("7_demo-pr2", "feat/demo-2", "feat/demo-1");
  commitFile(wt2, "two.txt");
  let g1 = sha("feat/demo-1");
  let g2 = sha("feat/demo-2");
  assert.equal(wt, `${f.dir}/wt/main-7_demo-pr1`);
  writePlan(P1, "feat/demo-1", g1);
  writePlan(P2, "feat/demo-2", g2, "pr1");

  // check resolves each plan against its PR target: Base, or its parent plan's branch.
  let out = ok("check", P1);
  assert.ok(out.includes("feat/demo-1\tbase=main") && out.includes("PASS check"), out);
  out = ok("check", P2);
  assert.ok(out.includes(`feat/demo-2\tbase=feat/demo-1\tparent=${g1}`), out);

  // An unrelated Base advance does not block check.
  write(`${repo}/other.txt`, "other\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "-qm", "feat: unrelated");
  git(repo, "push", "-q", "origin", "main");
  ok("check", P1);

  reviewed(P2, g1);
  fails(`differs from the reviewed ${g1}`, "check", P2);
  reviewed(P2, "");
  fails("no 'Status: reviewed' with a 'Tip:' SHA", "check", P2);
  reviewed(P2, g2.slice(0, 7));
  ok("check", P2);
  reviewed(P2, g2);

  // check accepts the plan's own open PR on resume, and blocks one with another base.
  const body1 = `${ROOT}/body1.md`;
  write(body1, "First plan. Refs #7\n");
  openPr("feat/demo-1", "main", body1, true);
  ok("check", P1);
  editPr(0, { baseRefName: "other" });
  fails("open PR not based on main", "check", P1);
  editPr(0, { baseRefName: "main" });

  // A repair to the parent after its PR opens: re-reviewed, then merged forward.
  fs.appendFileSync(`${wt}/one.txt`, "fixed\n");
  git(wt, "commit", "-qam", "fix: one");
  g1 = sha("feat/demo-1");
  reviewed(P1, g1);
  fails("does not contain its parent plan's branch feat/demo-1", "check", P2);
  git(wt2, "merge", "-q", "--no-edit", "feat/demo-1");
  g2 = sha("feat/demo-2");
  reviewed(P2, g2);
  ok("check", P1);
  ok("check", P2);
  git(repo, "push", "-q", "origin", "feat/demo-1");
  editPr(0, { headRefOid: g1 }); // GitHub follows the push

  const body2 = `${ROOT}/body2.md`;
  write(body2, "After https://github.test/o/r/pull/1.\n");
  openPr("feat/demo-2", "feat/demo-1", body2);
  ok("verify", P1);
  ok("verify", P2);

  editPr(1, { body: "no links" });
  fails("body does not link the PR of 7_demo/pr1.spec.md", "verify", P2);
  fails(`Unpublished plans stack on ${P1}`, "publish", P1);
  fails("not verified", "publish", P2);
  assert.ok(
    fs.existsSync(wt) && statusOf(P2) === "reviewed",
    "publish touched state before verification",
  );
  editPr(1, { body: "After #12." });
  fails("does not link the PR of", "verify", P2);
  editPr(1, { body: "After https://github.test/o/r/pull/12." });
  fails("does not link the PR of", "verify", P2);
  editPr(1, { body: "After #1." });
  ok("verify", P2);
  reviewed(P1, sha("main"));
  fails("origin/feat/demo-1 differs from the reviewed", "verify", P1);
  reviewed(P1, g1);

  fails("Usage", "publish", P2, "--ignored-checked");
  assert.equal(statusOf(P2), "reviewed");

  // A link-deps link is no change to remove, even when Git does not ignore it.
  fs.mkdirSync(`${repo}/node_modules`, { recursive: true });
  assert.equal(run(devWorktree, ["link-deps", wt2], { cwd: repo, env: f.env }).code, 0);
  assert.ok(fs.lstatSync(`${wt2}/node_modules`).isSymbolicLink());

  // create-pr step 4: publish every plan, children before parents; no worktree goes.
  out = ok("publish", P2);
  assert.ok(out.includes(`PASS publish ${P2}; Status: published`), out);
  assert.ok(ok("publish", P1).includes("Status: published"));
  assert.ok(fs.existsSync(wt2) && fs.existsSync(wt), "publish removed a worktree");
  assert.ok(ok("publish", P2).includes("already complete"), "a publish rerun is a no-op");
  fails("is published", "check", P2);

  // Step 5, once the stack is published: remove each worktree.
  // remove, not publish, refuses a dirty worktree, and keeps it.
  write(`${wt2}/stray.txt`, "x\n");
  let r = remove(wt2);
  assert.ok(
    r.code !== 0 &&
      r.all.includes("uncommitted or untracked") &&
      fs.lstatSync(`${wt2}/node_modules`).isSymbolicLink(),
    r.all,
  );
  fs.rmSync(`${wt2}/stray.txt`);
  r = remove(wt2);
  assert.ok(r.code === 0 && r.out.trim() === "deleted feat/demo-2", r.all);
  assert.ok(!fs.existsSync(wt2) && fs.existsSync(wt), "remove took the wrong worktree");
  assert.equal(
    read(P2).split("\n").slice(1, 8).join("\n"),
    `Status: published\nSpec: -\nTip: ${g2}\nType: feature\nBase: main\nBranch: feat/demo-2\nIssue: #7`,
  );

  // remove shows ignored content before removing the worktree.
  write(`${wt}/build/out`, "x\n");
  r = remove(wt);
  assert.ok(
    r.code === 4 && r.all.includes("IGNORED in") && r.all.includes("build/") && fs.existsSync(wt),
    `${r.code} ${r.all}`,
  );
  r = remove(wt, "--ignored-checked");
  assert.ok(r.code === 0 && r.out.trim() === "deleted feat/demo-1", r.all);
  assert.ok(!fs.existsSync(wt) && statusOf(P1) === "published", "removal left state behind");
  assert.ok(
    !gitOk(repo, "rev-parse", "--verify", "-q", "refs/heads/feat/demo-1"),
    "remove kept a pushed branch",
  );
  fails("Plan not found", "publish", `${D}/pr9.spec.md`);
  fails("Usage", "cleanup", P1);
});

test("an unpushed local commit; publish after the worktree is gone by hand", () => {
  const { repo, D, ok, fails, planWorktree, openPr, sha, remove } = newRepo("unpushed");
  const P1 = `${D}/pr1.spec.md`;
  const wt = planWorktree("7_demo-pr1", "feat/u-1", "main");
  commitFile(wt, "u1.txt");
  writePlan(P1, "feat/u-1", sha("feat/u-1"));
  write(`${ROOT}/body-u.md`, "First plan. Refs #7\n");
  openPr("feat/u-1", "main", `${ROOT}/body-u.md`);
  git(wt, "commit", "-q", "--allow-empty", "-m", "wip: local only");
  fails("local tip of feat/u-1 differ", "verify", P1);
  git(wt, "reset", "-q", "--hard", "origin/feat/u-1");
  fs.rmSync(wt, { recursive: true, force: true }); // by hand: Git still registers it
  assert.ok(ok("publish", P1).includes("Status: published"));
  // remove refuses a missing directory; the branch stays for the user.
  const r = remove(wt);
  assert.ok(r.code !== 0 && r.all.includes("does not exist"), r.all);
  assert.ok(gitOk(repo, "rev-parse", "--verify", "-q", "refs/heads/feat/u-1"));
});

test("plan paths outside the layout are refused", () => {
  const { repo, D, fails } = newRepo("paths");
  fails("Plan must be", "check", `${repo}/README.md`);
  fails("Plan must be", "check", `${D}/demo.md`);
  fails("Plan must be", "check", `${ROOT}/other/docs/plans/7_demo/pr1.spec.md`);
});

test("a stack tree publishing at once: root -> child -> grandchild, root -> sibling", () => {
  // Each plan has its own worktree. create-pr runs each step on every plan, parents first, before
  // the next step.
  const { repo, D, publish, ok, fails, planWorktree, openPr, prs, sha, remove } = newRepo("tree");
  const wtr = planWorktree("7_demo-pr1", "feat/root", "main");
  commitFile(wtr, "root.txt");
  const wtc = planWorktree("7_demo-pr2", "feat/child", "feat/root");
  commitFile(wtc, "child.txt");
  const wts = planWorktree("7_demo-pr3", "feat/sib", "feat/root");
  commitFile(wts, "sib.txt");
  const wtg = planWorktree("7_demo-pr4", "feat/grand", "feat/child");
  commitFile(wtg, "grand.txt");
  const stack: [n: number, branch: string, parent: string, on: string][] = [
    [1, "feat/root", "main", ""],
    [2, "feat/child", "feat/root", "pr1"],
    [3, "feat/sib", "feat/root", "pr1"],
    [4, "feat/grand", "feat/child", "pr2"],
  ];
  const plan = (n: number) => `${D}/pr${n}.spec.md`;
  for (const [n, branch, , on] of stack) writePlan(plan(n), branch, sha(branch), on);
  // A Stacks On line inside a fence is not a header.
  fs.appendFileSync(plan(2), "\n```\nStacks On: pr3\n```\n");
  for (const [n] of stack) ok("check", plan(n));

  const bodies = ["Root.", "After #1.", "After #1.", "After #1, #2."];
  for (const [n, branch, parent] of stack) {
    write(`${ROOT}/tree-${n}.md`, `${bodies[n - 1]}\n`);
    openPr(branch, parent, `${ROOT}/tree-${n}.md`, true);
  }
  for (const [n] of stack) ok("verify", plan(n));

  fails(`Stacks On line: ${plan(2)} ${plan(3)}.`, "publish", plan(1));
  write(plan(9), "# Stray\nStatus: planning\n## Goal\nStacks On: pr4\n");
  fails(`Stacks On line: !${plan(9)}`, "publish", plan(4));
  fs.rmSync(plan(9));
  assert.ok(fs.existsSync(wtr), "the parent guard touched the worktree");

  // From inside a worktree: the main repository's plans still resolve.
  for (const [n] of [...stack].reverse()) {
    const r = publish(["publish", plan(n)], wtr);
    assert.equal(r.code, 0, `publish pr${n}: ${r.all}`);
  }
  for (const [w, branch] of [
    [wtg, "feat/grand"],
    [wts, "feat/sib"],
    [wtc, "feat/child"],
    [wtr, "feat/root"],
  ]) {
    const r = remove(w as string);
    assert.ok(r.code === 0 && r.out.trim() === `deleted ${branch}`, `remove ${w}: ${r.all}`);
  }
  assert.deepEqual(
    prs().map((p) => p["baseRefName"]),
    ["main", "feat/root", "feat/root", "feat/child"],
  );
  for (const [n] of stack) assert.equal(statusOf(plan(n)), "published");
  assert.equal(git(repo, "branch", "--list", "feat/*"), "");
  for (const w of [wtr, wtc, wts, wtg]) assert.ok(!fs.existsSync(w), `worktree left: ${w}`);
});
