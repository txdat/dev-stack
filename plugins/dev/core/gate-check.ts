// Gate checker for the plan-backed phases (../rules/plan.md#sequence). Three call shapes reach it:
// a model-invoked Skill call (arguments in tool_input.args; the Pi extension sends
// tool_input.arguments), a user-typed slash command (UserPromptSubmit), and, for design-feature's
// stack check, gateDesign. Shell and edit calls go to the record guard (record-guard.ts) before
// they run, and shell calls again after.
//
// Only review-feature, execute-feature, review-code, and create-pr are gated. Each checks its entry
// status; review-feature and review-code also check the plan's ID shape (id-report.ts), every gate
// but review-feature a current ready Spec (create-pr for each plan it publishes), and review-code
// the RED/GREEN commit sequence. The gate reads identifiers and fields, never prose: whether an AC
// is right or a step satisfies its TC is the reviewer's judgment. It cannot tell who set `Status:
// approved`; only the user does. An agent's approval is `auto-approved`, set by dev-stack approve,
// and passes the same gates.
//
// Plans resolve by exact path only. A dormant plan never captures unrelated work, and a gate fires
// only for its own plan, except that create-pr reads every plan's Stacks On line in its directory
// so a stack publishes together. Plans live in the main root's docs/plans, untracked
// (plan-lib.ts); Git checks run in the main root, and proof checks in the plan's worktree.

import { asciiLower, b, stripNewlines, utf8 } from "./bytes.ts";
import { Exit } from "./cli.ts";
import {
  Block,
  block,
  type GateCtx,
  type HookInput,
  type Json,
  member,
  str,
} from "./hook-input.ts";
import { idReport } from "./id-report.ts";
import { PlanLib, planMentions, statusRank } from "./plan-lib.ts";
import { bashPostCheck, recordGuard } from "./record-guard.ts";
import { basename, dirname, git, isFile, isLink, readBytes } from "./sys.ts";
import { mainRoot } from "./utils.ts";

/** A verdict: a refusal before the call, or a report after a shell call that restored plans. */
export type GateResult = { block: string } | { postBlock: string } | undefined;

const EM = b("—");
const ARROW = b("→");
const GATED = ["review-feature", "execute-feature", "review-code", "create-pr"];
const SLUG_RE =
  "create-issue|create-pr|design-feature|design-infra|design-system|execute-feature|explore|fix-bug|review-code|review-feature|review-infra|review-system";

/** The dev phase a skill name or slash command names; "" for none. */
export const skillSlug = (name: string): string => {
  let raw = asciiLower(name.startsWith("/") ? name.slice(1) : name).replace(/_/g, "-");
  if (raw.startsWith("skill:")) raw = raw.slice(6);
  if (raw.startsWith("dev:") || raw.startsWith("dev-")) {
    const rest = raw.slice(4);
    if (new RegExp(`^(${SLUG_RE})$`).test(rest)) return rest;
  }
  const m = new RegExp(`dev[:-](${SLUG_RE})`).exec(raw);
  if (m?.[1]) return m[1];
  const w = new RegExp(`(^|[ \\t\\n\\v\\f\\r/])(${SLUG_RE})([ \\t\\n\\v\\f\\r]|$)`).exec(raw);
  return w?.[2] ?? "";
};

/**
 * The skill a call invokes. Only a leading slash command invokes one from a prompt; prose that
 * mentions one is never gated. Claude Code types a plugin skill as /dev:<name>, Pi as
 * /skill:<name>.
 */
const rawSkill = (input: HookInput, event: string): string => {
  if (event === "UserPromptSubmit") {
    const m =
      /^[ \t\n\v\f\r]*\/(([Ss][Kk][Ii][Ll][Ll]:)?([Dd][Ee][Vv][-:])?[A-Za-z_-]+)([^A-Za-z0-9_-]|$)/.exec(
        str(input["prompt"]) ?? "",
      );
    return m?.[1] ?? "";
  }
  const t = input["tool_input"];
  const command = (v: Json | undefined): string | undefined => {
    const s = str(v);
    return s !== undefined && /^[ \t\n\v\f\r]*\/dev[-:]/i.test(s) ? s : undefined;
  };
  const candidates = [
    str(member(t, "skill")),
    str(member(t, "skill_name")),
    str(member(t, "name")),
    str(member(t, "arguments")),
    str(input["skill"]),
    str(input["skill_name"]),
    str(member(input["arguments"], "skill")),
    command(member(t, "command")),
    command(input["command"]),
  ];
  return candidates.find((c) => c !== undefined && c !== "") ?? "";
};

/** The text a call names its plan in. */
const hookText = (input: HookInput): string => {
  const t = input["tool_input"];
  return [
    member(t, "args"),
    member(t, "arguments"),
    member(t, "command"),
    input["arguments"],
    input["command"],
    input["prompt"],
  ]
    .map(str)
    .filter((s): s is string => s !== undefined)
    .join(" ");
};

/**
 * Checks one hook call. A gated phase fails closed: an unexpected error blocks. The record guard
 * and post check fail open: an error passes.
 */
export const gateCheck = (input: HookInput, ctx: GateCtx): GateResult => {
  const tool = str(input["tool_name"]) ?? "";
  const event = str(input["hook_event_name"]) ?? "";
  if (tool === "Bash" && event.startsWith("PostToolUse")) {
    try {
      const report = bashPostCheck(input, ctx);
      return report === undefined ? undefined : { postBlock: report };
    } catch {
      return undefined;
    }
  }
  if (tool === "Bash" || tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    try {
      recordGuard(tool, input, ctx);
    } catch (e) {
      if (e instanceof Block) return { block: e.reason };
    }
    return undefined;
  }
  const slug = skillSlug(rawSkill(input, event));
  // Everything else is ungated and runs outside a Git repository too.
  if (!GATED.includes(slug)) return undefined;
  return phaseGate(slug, hookText(input), false, ctx);
};

/** design-feature's stack check: the review-feature gate without its parent-approval and stop checks. */
export const gateDesign = (plan: string, ctx: GateCtx): GateResult =>
  phaseGate("review-feature", plan, true, ctx);

const phaseGate = (slug: string, text: string, design: boolean, ctx: GateCtx): GateResult => {
  try {
    new Gate(slug, text, design, ctx).run();
    return undefined;
  } catch (e) {
    if (e instanceof Block) return { block: e.reason };
    const why = e instanceof Error ? e.message : String(e);
    return {
      block: `gate-check.ts failed (${why}) before reaching a verdict; this blocks rather than passing. Check the plan for invalid bytes or report the failure.`,
    };
  }
};

const STACKS_ON_HELP =
  "Write it as one plain header line, 'Stacks On: pr<K>', naming a plan in the same directory with a lower number, or delete it for the stack's root (rules/plan.md#stacks).";

type Proof = { re: RegExp | undefined; what: string };

class Gate {
  readonly slug: string;
  readonly text: string;
  readonly design: boolean;
  readonly root: string;
  readonly lib: PlanLib;
  /** Where history checks run: the main root, or the plan's worktree when it has one. */
  tree: string;
  plan = "";
  status = "";
  parentPlan = "";

  constructor(slug: string, text: string, design: boolean, ctx: GateCtx) {
    this.slug = slug;
    this.text = text;
    this.design = design;
    let root: string;
    try {
      root = mainRoot(ctx.cwd);
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      block(
        "Cannot resolve the main working-tree root; do not substitute the current linked worktree.",
      );
    }
    this.root = root;
    this.tree = root;
    this.lib = new PlanLib(root, {
      home: ctx.env["HOME"] ?? "",
      worktreesRoot: ctx.env["AI_WORKTREES_ROOT"],
    });
  }

  run(): void {
    this.resolvePlan();
    if (!this.lib.plansIgnored())
      block(
        `Git does not ignore docs/plans in ${this.root}, so a plan could be committed. Add /docs/plans/ to the global excludes file (git config core.excludesFile) or to .git/info/exclude (rules/plan.md#artifact).`,
      );
    this.lib.indexStack(this.plan);
    this.loadPlan();
    this.requireOneRoot();
    if (this.slug === "review-feature") this.reviewFeature();
    else if (this.slug === "execute-feature") this.executeFeature();
    else if (this.slug === "review-code") this.reviewCode();
    else this.createPr();
  }

  field(plan: string, key: string): string {
    return this.lib.fieldOr(plan, key);
  }

  // ── plan resolution ──────────────────────────────────────────────────

  /** Exactly one plan path, which must resolve: a typo or foreign path blocks. */
  resolvePlan(): void {
    const named: string[] = [];
    const format = this.lib.planFormat;
    for (const mention of planMentions(this.text)) {
      if (mention === "") continue;
      const doc = this.lib.canonicalPlan(mention);
      if (doc === undefined)
        block(
          `Named plan not found: ${mention}. Pass the full path of an existing ${format} of this repository.`,
        );
      if (!named.includes(doc)) named.push(doc);
    }
    if (named.length === 0)
      block(
        `${this.slug} operates on a plan and none was named. Pass its exact path: ${this.slug} ${format}. A slug or the only plan in a directory does not resolve. No plan yet ${ARROW} run design-feature first.`,
      );
    if (named.length > 1)
      block(
        `${this.slug} takes one plan path; ${named.length} were named: ${named.join(" ")}. Pass only the plan; its Stacks On parent is read from its header.`,
      );
    const plan = named[0] as string;
    if (!isFile(plan)) block(`Named plan not found: ${plan}. Pass an existing ${format}.`);
    this.plan = plan;
  }

  loadPlan(): void {
    const plan = this.plan;
    if (isLink(plan))
      block(`Plan ${plan} is a symlink; a plan is a regular file (rules/plan.md#artifact).`);
    this.status = this.lib.status(plan);
    // Before anything else: a published record ends delivery.
    if (this.status === "published")
      block(
        `Plan ${plan} is published; no phase resumes it. For follow-up work, start a new stack in a new directory with design-feature.`,
      );
    const reason = this.lib.freezeReason(plan);
    if (reason !== "") block(`Plan ${plan} is frozen: ${reason}.`);
    // design-feature's stack check runs on plans run-stack may hold stopped.
    if (!this.design) this.requireNotStopped(plan, `Plan ${plan} is stopped`);
    const wt = this.lib.worktreeOf(plan);
    if (wt !== "") this.tree = wt;
  }

  requireNotStopped(plan: string, what: string): void {
    const reason = this.lib.stopReason(plan);
    if (reason === undefined)
      block(
        `Cannot hash ${plan} with the plans below it: one is missing or has an unreadable 'Stacks On:' line.`,
      );
    if (reason !== "")
      block(
        `${what}: ${reason}. Only the user clears it, with dev-stack.ts resume (skills/run-stack/SKILL.md#stops).`,
      );
  }

  /** Plan has a worktree; the block names where it belongs. */
  requireWorktree(plan = this.plan): void {
    if (this.lib.worktreeOf(plan) !== "") return;
    const name = this.lib.worktreeName(plan);
    block(
      `Plan ${plan} has no worktree at ${this.lib.worktreePath(name)}. Create it with dev-worktree.ts create ${name} ${this.field(plan, "Branch")} <PR target>, which reattaches an existing Branch. If publication cleanup removed it, rerun dev-publish.ts cleanup on the plans not yet published (rules/plan.md#worktree).`,
    );
  }

  /** The plan's worktree is on its Branch. */
  requireHead(): void {
    const branch = this.field(this.plan, "Branch");
    const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: this.tree });
    const head = r.code === 0 ? stripNewlines(r.stdout) : "";
    if (head !== branch)
      block(
        `Worktree ${this.tree} is on '${head || "a detached HEAD"}', not this plan's branch '${branch}'; switch it to '${branch}' before ${this.slug} (rules/plan.md#worktree).`,
      );
  }

  /** The directory's issue agrees with the header, and the type is known. */
  checkName(): void {
    const dir = basename(dirname(this.plan));
    const num = dir.includes("_") ? dir.slice(0, dir.indexOf("_")) : dir;
    const issue = this.field(this.plan, "Issue");
    let want = "";
    if (issue === "none") want = "0";
    else if (/^#[1-9]/.test(issue)) want = /^[0-9]+$/.test(issue.slice(1)) ? issue.slice(1) : "";
    if (want === "")
      block(
        `Plan header has 'Issue: ${issue}'; write 'Issue: #<n>' or 'Issue: none' (rules/plan.md#schema).`,
      );
    if (num !== want)
      block(
        `Plan directory starts with ${num}, but the header has 'Issue: ${issue}'. The directory's <issue> is the issue number, or 0 for none; fix the header, or move the stack.`,
      );
    const type = asciiLower(this.field(this.plan, "Type"));
    if (!/^(feature|fix|refactor|config)$/.test(type))
      block(
        `Plan header has 'Type: ${type}'; write feature, fix, refactor, or config (rules/plan.md#schema).`,
      );
  }

  /** The plan's parent from its Stacks On line; "" for the root. */
  stacksOn(plan: string): string {
    const parent = this.lib.parent(plan);
    if (parent === undefined)
      block(
        `Plan has a 'Stacks On:' line that is misplaced, repeated, or malformed. ${STACKS_ON_HELP}`,
      );
    return parent;
  }

  /**
   * A stacked plan enters review once its parent is approved, and execution and code review once
   * it is reviewed. The whole stack publishes at once, so the parent is unpublished until then.
   */
  requireParentRank(need: number, needName: string): void {
    this.parentPlan = this.stacksOn(this.plan);
    const parent = this.parentPlan;
    if (parent === "") return;
    if (!isFile(parent)) block(`Parent plan ${parent} does not exist. Fix the 'Stacks On:' line.`);
    const status = this.lib.status(parent);
    if (status === "published")
      block(
        `Parent plan ${parent} is published, and a published plan never becomes a parent. Wait until its stack merges, then start a new stack in a new directory on Base (rules/plan.md#stacks).`,
      );
    const rank = statusRank(status);
    if (rank === undefined || rank < need)
      block(
        `Parent plan ${parent} is '${status}'; ${this.slug} needs it '${needName}' or later (rules/plan.md#stacks).`,
      );
  }

  /** A directory holds one stack: exactly one plan in it has no Stacks On line. */
  requireOneRoot(): void {
    const n = this.lib.rootPlans(this.plan).length;
    // None is left to the checks of the plan's own Stacks On line and parent.
    if (n > 1)
      block(
        `Plan directory ${dirname(this.plan)} holds ${n} plans without a 'Stacks On:' line; a directory holds one stack with one root. Stack the others on a plan in it, or move them to their own directory (rules/plan.md#stacks).`,
      );
  }

  requireIds(): void {
    const report = idReport(readBytes(this.plan) ?? "");
    if (report.length === 0) return;
    if (report.some((l) => l.startsWith("!")))
      block(
        `gate-check.ts cannot read the IDs in ${this.plan}; fix them per rules/plan.md#schema and re-run. This is NOT a traceability verdict:\n${report.map((l) => l.replace(/^[!@]/, "")).join("\n")}`,
      );
    if (report.some((l) => l.startsWith("@")))
      block(
        `${this.plan} cites another artifact's IDs. A plan cites only its own IDs; refer to other artifacts by path and restate contract facts as PCs (rules/plan.md#schema):\n${report
          .filter((l) => l.startsWith("@"))
          .map((l) => l.slice(1))
          .join("\n")}`,
      );
    block(
      `The plan shape in ${this.plan} fails: its ID graph is not closed, or a PC lacks a Check or counts matches (rules/plan.md#schema, skills/design-feature/SKILL.md#3-write-the-spec):\n${report.join("\n")}\n\nThis is shape, not correctness: fixing these does not make an edge or a Check right.`,
    );
  }

  // ── branch and proof ─────────────────────────────────────────────────

  /** The plan names its own branch, distinct from Base. */
  requireBranch(): void {
    const branch = this.field(this.plan, "Branch");
    const base = this.field(this.plan, "Base");
    if (base === "")
      block(
        "Plan header has no Base branch. Set it to the branch the stack is based on, then re-run.",
      );
    if (
      branch === "" ||
      git(["check-ref-format", "--branch", branch], { cwd: this.root }).code !== 0
    )
      block(
        `Plan header has 'Branch: ${branch}'; set it to the valid, new branch this plan's PR comes from (rules/plan.md#schema).`,
      );
    if (branch === base)
      block(`Plan's Branch is its Base, '${base}'; the plan's PR needs its own branch.`);
  }

  /** A commit in the plan's tree, or undefined. */
  treeSha(ref: string): string | undefined {
    const r = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: this.tree });
    return r.code === 0 ? stripNewlines(r.stdout) : undefined;
  }

  /**
   * Where the plan's branch leaves its PR target. For Base, the fork point from origin/<Base> (or
   * the local branch without one), as dev-publish resolves it: Base may advance without the plan
   * merging it. For a parent plan's branch, its tip, which the branch must contain; that branch
   * may exist only as origin/<branch> after cleanup.
   */
  reviewBase(target: string): string | undefined {
    if (this.parentPlan === "") {
      const sha =
        this.treeSha(`refs/remotes/origin/${target}`) ?? this.treeSha(`refs/heads/${target}`);
      if (sha === undefined) return undefined;
      const r = git(["merge-base", sha, "HEAD"], { cwd: this.tree });
      return r.code === 0 ? stripNewlines(r.stdout) : undefined;
    }
    const sha =
      this.treeSha(`refs/heads/${target}`) ?? this.treeSha(`refs/remotes/origin/${target}`);
    if (sha === undefined) return undefined;
    return git(["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: this.tree }).code === 0
      ? sha
      : undefined;
  }

  /**
   * How plan proves itself: refactors with a passing baseline commit, config plans with their TC
   * checks at the tip and no proof commit (re undefined), the rest with a failing test.
   */
  proofKind(plan: string): Proof {
    const type = asciiLower(this.field(plan, "Type"));
    if (type === "refactor")
      return { re: /^test:[ \t\n\v\f\r]*baseline/, what: "'test: baseline'" };
    if (type === "config") return { re: undefined, what: "implementation" };
    return { re: /^test\(red\):/, what: "'test(red):'" };
  }

  /**
   * The plan needs a proof commit followed by at least one implementation commit, and nothing may
   * precede the first proof. Topological order, so a repair merged forward reads as one line of
   * history whatever its dates. A merge commit implements nothing, so it never completes the
   * proof; a test(update) commit, a revised plan's test change, is neither proof nor
   * implementation (../rules/plan.md#verification).
   */
  proofSequenceOk(base: string, re: RegExp | undefined, tip = "HEAD"): boolean {
    if (re === undefined) {
      // A config plan needs only a commit of its own.
      const r = git(["log", "--format=%H", "--no-merges", `${base}..${tip}`], { cwd: this.tree });
      return r.code === 0 && r.stdout !== "";
    }
    const r = git(
      ["log", "--format=%s", "--topo-order", "--no-merges", "--reverse", `${base}..${tip}`],
      {
        cwd: this.tree,
      },
    );
    if (r.code !== 0) return false;
    const subjects = r.stdout.split("\n");
    if (subjects[subjects.length - 1] === "") subjects.pop();
    let proofs = 0;
    let waiting = false;
    let seen = false;
    let bad = false;
    for (const s of subjects) {
      if (/^test\(update\):/.test(s)) continue;
      if (re.test(s)) {
        if (waiting) bad = true;
        proofs++;
        waiting = true;
        seen = true;
        continue;
      }
      if (!seen) bad = true;
      waiting = false;
    }
    return !(proofs < 1 || waiting || bad);
  }

  /** Plan's reviewed SHA holds its proof after base, as review-code checked. */
  requireReviewedProof(plan: string, base: string): void {
    const green = this.lib.greenOf(plan);
    const kind = this.proofKind(plan);
    const what =
      kind.re === undefined
        ? "implementation commit"
        : `${kind.what} commit followed by implementation`;
    if (base === "" || !this.proofSequenceOk(base, kind.re, green))
      block(
        `Plan ${plan}'s reviewed SHA ${green} has no ${what} after ${base || "its PR target"}; run review-code on it (rules/plan.md#verification).`,
      );
  }

  /** Plan shares parent's Base and has its own branch; rechecked until the parent publishes. */
  requireStacked(plan: string, parent: string): void {
    const base = this.field(plan, "Base");
    const parentBase = this.field(parent, "Base");
    if (base !== parentBase)
      block(
        `Plan ${plan} has 'Base: ${base}', but its parent plan ${parent} has 'Base: ${parentBase}'; a stacked plan uses its parent's Base (rules/plan.md#stacks).`,
      );
    const branch = this.field(plan, "Branch");
    const parentBranch = this.field(parent, "Branch");
    if (parentBranch === "" || branch === parentBranch)
      block(
        `Plan ${plan} has 'Branch: ${branch}', but its PR targets its parent plan's branch, '${parentBranch || "none recorded"}'; each plan has its own branch (rules/plan.md#stacks).`,
      );
  }

  /** The spec, with the specs below it, is the one review-feature passed, by its Spec. */
  requireCurrentReview(plan = this.plan): void {
    const state = this.lib.reviewState(plan);
    if (state === undefined)
      block(
        `Cannot hash ${plan} with the plans below it: one is missing or has an unreadable 'Stacks On:' line.`,
      );
    if (state !== "ready")
      block(
        `Plan ${plan} has no ready 'Spec:' hash for its current spec and the specs below it: it changed after review-feature, its verdict was needs-changes, or no verdict was recorded. An approved plan is frozen: the user reverts the change, or reopens it with dev-stack.ts reopen (rules/plan.md#changes).`,
      );
  }

  /** Plan's Status of reviewed rests on a review-code pass logged at its Tip. */
  requirePassed(plan: string): void {
    if (!this.lib.passedAtTip(plan))
      block(
        `Plan ${plan} is reviewed, but its last review-code verdict in the stack log is not a pass at its Tip ${this.lib.greenOf(plan)}. Run review-code and record its verdict with dev-stack.ts code-review; the main agent sets reviewed only after a logged pass (skills/review-code/SKILL.md#finalize).`,
      );
  }

  // ── gates ────────────────────────────────────────────────────────────

  reviewFeature(): void {
    const s = this.status;
    if (s === "approved" || s === "auto-approved")
      block(`Plan is already ${s}. Run execute-feature next.`);
    if (s === "implemented" || s === "reviewed")
      block(`Plan status is '${s}' ${EM} too late for review-feature. Continue forward.`);
    if (s !== "planning" && s !== "needs-changes" && s !== "ready")
      block(
        `Plan status is '${s}' ${EM} expected 'planning', 'needs-changes', or 'ready'. Run design-feature first.`,
      );
    this.checkName();
    // design-feature checks a stack before the user approves any of it.
    if (this.design) this.requireParentRank(0, "planning");
    else this.requireParentRank(1, "approved");
    this.requireIds();
    this.requireBranch();
    if (this.parentPlan !== "") this.requireStacked(this.plan, this.parentPlan);
  }

  executeFeature(): void {
    const s = this.status;
    if (s === "planning")
      block(
        `Plan status is 'planning' ${EM} not approved. Run review-feature; then the user sets 'Status: approved', or dev-autopilot 'auto-approved'.`,
      );
    if (s === "needs-changes")
      block(
        `Plan status is 'needs-changes' ${EM} not approved. Revise it, then run review-feature again.`,
      );
    if (s === "ready")
      block(
        `Plan status is 'ready' ${EM} awaiting approval: the user sets 'Status: approved', or dev-autopilot 'auto-approved'.`,
      );
    if (s === "implemented") block("Plan is already implemented. Run review-code next.");
    if (s === "reviewed") block("Plan is already reviewed. Run create-pr next.");
    if (s !== "approved" && s !== "auto-approved")
      block(`Plan status is '${s}' ${EM} expected 'approved' or 'auto-approved'.`);
    this.requireParentRank(3, "reviewed");
    this.requireBranch();
    if (this.parentPlan !== "") this.requireStacked(this.plan, this.parentPlan);
    this.requireCurrentReview();
    // Resuming on an existing Branch happens in the plan's worktree, on it.
    if (this.lib.branchExists(this.field(this.plan, "Branch"))) {
      this.requireWorktree();
      this.requireHead();
    }
  }

  reviewCode(): void {
    const s = this.status;
    if (["planning", "needs-changes", "ready", "approved", "auto-approved"].includes(s))
      block(`Plan status is '${s}' ${EM} not yet implemented. Run execute-feature first.`);
    if (s === "reviewed") block("Plan is already reviewed. Run create-pr next.");
    if (s !== "implemented") block(`Plan status is '${s}' ${EM} expected 'implemented'.`);
    this.requireWorktree();
    // A parent revised since execution returns this plan to its repair.
    this.requireParentRank(3, "reviewed");
    this.requireBranch();
    if (this.parentPlan !== "") this.requireStacked(this.plan, this.parentPlan);
    this.requireCurrentReview();
    // Re-checked here: the gate before execution may not have run.
    this.requireIds();
    this.requireHead();
    const branch = this.field(this.plan, "Branch");
    const target = this.lib.prTarget(this.plan) ?? "";
    const base = this.reviewBase(target);
    if (base === undefined)
      block(
        `The PR target '${target}' is missing or is not an ancestor of '${branch}'. If a repair landed on the parent plan's branch, merge it forward first (rules/plan.md#worktree).`,
      );
    const kind = this.proofKind(this.plan);
    let count: number;
    if (kind.re !== undefined) {
      const re = kind.re;
      const r = git(["log", "--format=%s", `${base}..HEAD`], { cwd: this.tree });
      count = r.stdout.split("\n").filter((l) => re.test(l)).length;
    } else {
      const r = git(["log", "--format=%H", "--no-merges", `${base}..HEAD`], { cwd: this.tree });
      count = r.stdout.split("\n").filter((l) => l !== "").length;
    }
    if (count < 1)
      block(
        `Found no ${kind.what} commit between ${target} and ${branch} (rules/plan.md#verification).`,
      );
    if (!this.proofSequenceOk(base, kind.re))
      block(
        `Proof is out of sequence: each ${kind.what} commit needs at least one implementation commit after it, and nothing may come before the first (rules/plan.md#verification).`,
      );
  }

  createPr(): void {
    const s = this.status;
    if (s === "implemented") block(`Plan status is 'implemented' ${EM} run review-code first.`);
    if (["planning", "needs-changes", "ready", "approved", "auto-approved"].includes(s))
      block(`Plan status is '${s}' ${EM} not yet executed. Continue the workflow.`);
    if (s !== "reviewed") block(`Plan status is '${s}' ${EM} expected 'reviewed'.`);
    this.requireWorktree();
    this.requireCurrentReview();
    this.requirePassed(this.plan);
    // create-pr publishes a whole stack at once, from its root.
    const own = this.stacksOn(this.plan);
    if (own !== "")
      block(
        `Plan stacks on ${own}. create-pr runs once, on the stack's root ${this.lib.rootPlans(this.plan)[0] ?? ""}, and publishes every plan in the stack together (rules/plan.md#stacks).`,
      );
    const baseName = this.field(this.plan, "Base");
    const target =
      this.treeSha(`refs/remotes/origin/${baseName}`) ?? this.treeSha(`refs/heads/${baseName}`);
    let base = "";
    if (target !== undefined) {
      const r = git(["merge-base", target, this.lib.greenOf(this.plan)], { cwd: this.tree });
      base = r.code === 0 ? stripNewlines(r.stdout) : "";
    }
    this.requireReviewedProof(this.plan, base);
    for (const plan of this.lib.descendantPlans(this.plan)) {
      if (plan.startsWith("!"))
        block(
          `${plan.slice(1)} has a 'Stacks On:' line that is misplaced, repeated, malformed, or names no plan, or is a symlink; fix it so create-pr can tell whether it stacks on this plan.`,
        );
      const parent = this.lib.parent(plan) ?? "";
      this.requireStacked(plan, parent);
      const status = this.lib.status(plan);
      if (status !== "reviewed")
        block(
          `Plan ${plan} stacks above this plan and is '${status}'. The stack publishes together: run create-pr on this root once every plan in it is reviewed (rules/plan.md#stacks).`,
        );
      this.requireCurrentReview(plan);
      this.requireNotStopped(plan, `Plan ${plan} stacks above this plan and is stopped`);
      this.requireWorktree(plan);
      this.requirePassed(plan);
      // Reviewed on top of the parent's current reviewed tip, not an older one.
      if (!this.lib.containsParentGreen(plan, parent))
        block(
          `Plan ${plan}'s reviewed SHA ${this.lib.greenOf(plan)} does not contain its parent ${parent}'s, ${this.lib.greenOf(parent)}. Merge the parent forward into ${plan} (rules/plan.md#worktree), return it to review-code, then run create-pr here.`,
        );
      this.requireReviewedProof(plan, this.lib.greenOf(parent));
    }
  }
}

/** A verdict as Claude Code's hook output reads it: one JSON line, or "" to pass. */
export const claudeVerdict = (input: HookInput, result: GateResult): string => {
  if (result === undefined) return "";
  if ("postBlock" in result)
    return `${JSON.stringify({ decision: "block", reason: utf8(result.postBlock) })}\n`;
  const reason = utf8(result.block);
  // hookSpecificOutput must name the event it answers, so only PreToolUse carries the permission
  // deny; UserPromptSubmit reads decision:block.
  const out: Record<string, unknown> = {
    continue: false,
    stopReason: reason,
    decision: "block",
    reason,
  };
  if (input["hook_event_name"] === "PreToolUse")
    out["hookSpecificOutput"] = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    };
  return `${JSON.stringify(out)}\n`;
};
