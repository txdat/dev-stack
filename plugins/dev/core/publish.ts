// Publication checks for create-pr (../skills/create-pr/SKILL.md): reviewed-tip checks, PR
// verification, and marking a plan published; dev-worktree.js remove then removes its worktree.
// A plan is one PR; the PR carries code only, and the plan stays in docs/plans, untracked, as a
// published record.
//
// The main agent alone runs it. The create-pr gate (gate-check.ts) owns entry: reviewed status and
// an active worktree. The agent pushes and opens the PRs and owns their titles and bodies. This
// never merges, retargets, force-pushes, or rewrites branches; every command rechecks state, so a
// failed run can be repeated.

import { b, stripNewlines, utf8 } from "./bytes.ts";
import { devCheck } from "./check.ts";
import { type Command, type Ctx, Exit, fail, guard, Output, sh } from "./cli.ts";
import { PlanLib } from "./plan-lib.ts";
import { git, isFile, isLink, type Ran } from "./sys.ts";
import { mainRoot } from "./utils.ts";

const USAGE = [
  "Usage: dev-publish.js check <plan>",
  "       dev-publish.js verify <plan>",
  "       dev-publish.js publish <plan>",
  "<plan> is <main root>/docs/plans/<issue>_<slug>/pr<N>.spec.md, run from the repository.",
  "publish sets Status: published and keeps the plan as a record; dev-worktree.js remove then removes its worktree.",
  "Exit: 0 ok, 1 failure, 2 usage.",
].join("\n");

const usage = (): never => {
  throw new Exit(2, `${USAGE}\n`);
};

type Pr = {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  headRefOid: string;
  body: string;
};

/** Whether body names link with no digit after it: #1 and .../pull/1 are not #12. */
const links = (body: string, link: string): boolean => {
  for (let i = body.indexOf(link); i !== -1; i = body.indexOf(link, i + 1)) {
    const next = body[i + link.length];
    if (next === undefined || !/[0-9]/.test(next)) return true;
  }
  return false;
};

class Publish {
  readonly lib: PlanLib;
  readonly o: Output;
  readonly ctx: Ctx;
  readonly root: string;
  plan = "";
  branch = "";
  parentPlan = "";
  target = "";
  problems: string[] = [];

  constructor(root: string, ctx: Ctx, o: Output) {
    this.root = root;
    this.ctx = ctx;
    this.o = o;
    this.lib = new PlanLib(root, ctx);
  }

  // ── plan reading ─────────────────────────────────────────────────────

  loadPlan(arg: string): void {
    const plan = this.lib.canonicalPlan(arg);
    if (plan === undefined) fail(`Plan must be ${this.lib.planFormat}: ${arg}`);
    if (!isFile(plan) || isLink(plan)) fail(`Plan not found: ${plan}`);
    this.lib.indexStack(plan);
    this.plan = plan;
  }

  requireUnpublished(): void {
    if (this.lib.isPublished(this.plan))
      fail(`${this.plan} is published; publication of it is complete.`);
  }

  /** The plan's branch and the branch its PR targets. */
  loadFields(): void {
    this.branch = this.lib.fieldOr(this.plan, "Branch");
    if (this.branch === "") fail("Plan header has no Branch.");
    const parent = this.lib.parent(this.plan);
    if (parent === undefined) fail("Plan has an unreadable 'Stacks On:' line.");
    this.parentPlan = parent;
    this.target = this.lib.prTarget(this.plan) ?? "";
    if (this.target === "")
      fail(
        `No PR target: ${parent !== "" ? `parent plan ${parent} has no Branch` : "the plan header has no Base"}.`,
      );
  }

  /** The Tip SHA of a `Status: reviewed` plan, recorded by review-code. */
  greenSha(): string | undefined {
    const sha = this.lib.greenOf(this.plan);
    return sha === "" ? undefined : this.revParse(`${sha}^{commit}`);
  }

  // ── git and GitHub state ─────────────────────────────────────────────

  git(args: readonly string[]): Ran {
    const r = git(args, { cwd: this.root, env: this.ctx.env });
    this.o.err(r.stderr);
    return r;
  }

  revParse(ref: string): string | undefined {
    const r = this.git(["rev-parse", "--verify", "--quiet", ref]);
    return r.code === 0 ? stripNewlines(r.stdout) : undefined;
  }

  fetchOrigin(): void {
    if (this.git(["fetch", "--quiet", "--prune", "origin"]).code !== 0)
      fail("Cannot fetch origin.");
  }

  originSha(branch: string): string | undefined {
    return this.revParse(`refs/remotes/origin/${branch}^{commit}`);
  }

  localSha(branch: string): string | undefined {
    return this.revParse(`refs/heads/${branch}^{commit}`);
  }

  refSha(branch: string): string | undefined {
    return this.localSha(branch) ?? this.originSha(branch);
  }

  isAncestor(a: string, d: string): boolean {
    if (git(["cat-file", "-e", `${a}^{commit}`], { cwd: this.root, env: this.ctx.env }).code !== 0)
      return false;
    return this.git(["merge-base", "--is-ancestor", a, d]).code === 0;
  }

  /** PRs for a head branch; gh's state filter (open or all). A gh failure ends the command. */
  prsFor(branch: string, state: "open" | "all"): Pr[] {
    const r = sh(
      this.o,
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        state,
        "--json",
        "number,url,state,baseRefName,headRefOid,body",
      ],
      { cwd: this.root, env: this.ctx.env, stdout: "keep" },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8(r.stdout));
    } catch {
      fail(`gh pr list printed no JSON for ${branch}.`);
    }
    if (!Array.isArray(parsed)) fail(`gh pr list printed no JSON array for ${branch}.`);
    const s = (v: unknown): string => (typeof v === "string" ? b(v) : v == null ? "" : String(v));
    return parsed.map((p: Record<string, unknown>) => ({
      number: typeof p["number"] === "number" ? p["number"] : 0,
      url: s(p["url"]),
      state: s(p["state"]),
      baseRefName: s(p["baseRefName"]),
      headRefOid: s(p["headRefOid"]),
      body: s(p["body"]),
    }));
  }

  /** The SHA of the PR target: Base from origin (or local), a parent plan's branch from either. */
  targetSha(): string {
    if (this.parentPlan === "") {
      const sha = this.originSha(this.target) ?? this.refSha(this.target);
      if (sha === undefined) fail(`Base ${this.target} resolves neither locally nor on origin.`);
      return sha;
    }
    const sha = this.refSha(this.target);
    if (sha === undefined)
      fail(`Parent branch ${this.target} resolves neither locally nor on origin.`);
    return sha;
  }

  /** The plans below this one, nearest first; "!<plan>" ends the list at an unreadable Stacks On. */
  ancestorPlans(): string[] {
    const out: string[] = [];
    let plan = this.parentPlan;
    while (plan !== "") {
      out.push(plan);
      const next = this.lib.parent(plan);
      if (next === undefined) {
        out.push(`!${plan}`);
        break;
      }
      plan = next;
    }
    return out;
  }

  // ── commands ─────────────────────────────────────────────────────────

  /** Prints the problems as BLOCK lines; false when there are any. */
  reportProblems(): boolean {
    for (const p of this.problems) this.o.err(`BLOCK ${p}\n`);
    return this.problems.length === 0;
  }

  check(): void {
    this.problems = [];
    this.fetchOrigin();
    const target = this.targetSha();
    const tip = this.refSha(this.branch);
    if (tip === undefined) {
      this.problems.push(`branch ${this.branch} does not resolve`);
    } else {
      if (this.parentPlan !== "" && !this.isAncestor(target, tip))
        this.problems.push(
          `${this.branch} does not contain its parent plan's branch ${this.target}; merge it forward`,
        );
      const base = this.git(["merge-base", target, tip]);
      const parentSha = base.code === 0 ? stripNewlines(base.stdout) : undefined;
      const green = parentSha === undefined ? undefined : this.greenSha();
      if (parentSha === undefined) {
        this.problems.push(`no merge base with ${this.target}`);
      } else if (green === undefined) {
        this.problems.push("no 'Status: reviewed' with a 'Tip:' SHA");
      } else {
        if (green !== tip)
          this.problems.push(
            `tip ${tip} differs from the reviewed ${green}; changed code returns to review`,
          );
        if (this.git(["diff", "--quiet", parentSha, green]).code === 0)
          this.problems.push(`empty diff from ${this.target}`);
        const scan = devCheck({
          argv: ["artifacts", parentSha, green],
          env: this.ctx.env,
          cwd: this.root,
        });
        if (scan.code !== 0)
          this.problems.push(`conflict markers; run dev-check.js artifacts ${parentSha} ${green}`);
      }
      // An open PR from an earlier run is this plan's own when it targets its PR target; a repair
      // moves the tip ahead of it until the push.
      const stray = this.prsFor(this.branch, "all").filter(
        (p) => p.state === "OPEN" && p.baseRefName !== this.target,
      );
      if (stray.length !== 0)
        this.problems.push(`${this.branch} has an open PR not based on ${this.target}`);
      this.o.out(`${this.branch}\tbase=${this.target}\tparent=${parentSha ?? "?"}\ttip=${tip}\n`);
    }
    if (!this.reportProblems()) throw new Exit(1);
    this.o.out(`PASS check ${this.plan}\n`);
  }

  /** Collects problems; returns the verified PR's line. */
  verifyPublication(): string {
    this.problems = [];
    this.fetchOrigin();
    const prs = this.prsFor(this.branch, "open");
    const pr = prs[0];
    if (prs.length !== 1 || pr === undefined) {
      this.problems.push(`expected one open PR for ${this.branch}, found ${prs.length}`);
      return "";
    }
    if (pr.baseRefName !== this.target)
      this.problems.push(`PR base is ${pr.baseRefName}, expected ${this.target}`);
    const originTip = this.originSha(this.branch) ?? "";
    const tip = this.localSha(this.branch) ?? originTip;
    if (originTip === "" || pr.headRefOid !== originTip || tip !== originTip)
      this.problems.push(`PR head, origin, and local tip of ${this.branch} differ`);
    const green = this.greenSha();
    if (green === undefined) this.problems.push("no 'Status: reviewed' with a 'Tip:' SHA");
    else if (originTip !== "" && green !== originTip)
      this.problems.push(`origin/${this.branch} differs from the reviewed ${green}`);
    // The body links the PR of every plan below this one.
    const body = stripNewlines(pr.body);
    for (const plan of this.ancestorPlans()) {
      if (plan.startsWith("!")) {
        this.problems.push(
          `a plan below, ${this.lib.planLabel(plan.slice(1))}, has an unreadable 'Stacks On:' line`,
        );
        continue;
      }
      const pbranch = this.lib.fieldOr(plan, "Branch");
      const pprs = this.prsFor(pbranch, "open");
      const ppr = pprs[0];
      if (pprs.length !== 1 || ppr === undefined) {
        this.problems.push(
          `the plan below, ${this.lib.planLabel(plan)}, has no single open PR for ${pbranch}`,
        );
        continue;
      }
      if (!links(body, ppr.url) && !links(body, `#${ppr.number}`))
        this.problems.push(`body does not link the PR of ${this.lib.planLabel(plan)}, ${ppr.url}`);
    }
    return `${this.branch}\t${pr.url}\t${pr.baseRefName}\n`;
  }

  verify(): void {
    this.o.out(this.verifyPublication());
    if (!this.reportProblems()) throw new Exit(1);
    this.o.out(`PASS verify ${this.plan}\n`);
  }

  /** Marks the plan published once its publication verifies; the worktree is dev-worktree's. */
  publish(): void {
    // "!<plan>" is a plan whose Stacks On line cannot be read, so it may name this one.
    const children = this.lib.childPlans(this.plan);
    if (children.length !== 0)
      fail(
        `Unpublished plans stack on ${this.plan} or have an unreadable Stacks On line: ${children.join(" ")}. Publish its children first, children before parents; fix an unreadable line first.`,
      );
    this.verifyPublication();
    if (!this.reportProblems()) fail("Publication is not verified; the plan stays unpublished.");
    if (!this.lib.setHeader(this.plan, [["Status", "published"]]))
      fail(`Cannot set Status: published in ${this.plan}.`);
    this.o.out(`PASS publish ${this.plan}; Status: published\n`);
  }
}

export const devPublish: Command = (ctx) => {
  const o = new Output();
  return guard(o, () => {
    const argv = ctx.argv;
    const [cmd, arg = ""] = argv;
    if (cmd === "--help" || cmd === "-h") {
      o.out(`${USAGE}\n`);
      return o.done();
    }
    if (argv.length < 2) usage();
    const root = mainRoot(ctx.cwd, ctx.env, o);
    const p = new Publish(root, ctx, o);
    switch (cmd) {
      case "check":
      case "verify":
        if (argv.length !== 2) usage();
        p.loadPlan(arg);
        p.requireUnpublished();
        p.loadFields();
        if (cmd === "check") p.check();
        else p.verify();
        break;
      case "publish":
        if (argv.length !== 2) usage();
        p.loadPlan(arg);
        if (p.lib.isPublished(p.plan)) {
          o.out(`PASS publish already complete; ${p.plan} is published\n`);
          return o.done();
        }
        p.loadFields();
        p.publish();
        break;
      default:
        usage();
    }
    return o.done();
  });
};
