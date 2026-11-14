// The stack tree of plans (../rules/plan.md#stacks), for design-feature, create-pr, and run-stack.
// `review` sets a planning plan's Status and Spec; `approve` sets a ready one auto-approved;
// `reopen` returns approved plans to planning, and `auto-reopen` auto-approved ones once each;
// `renumber` and `drop` reshape a stack before approval. Each write appends to the stack's log
// (plan-lib.ts stackLog), as do `code-review`, `stop`, and `resume`, and `next` and `check` when
// they record an approval the user set by hand; the rest only read.

import * as fs from "node:fs";
import { b, byteCompare, utf8 } from "./bytes.ts";
import { type Command, type Ctx, Exit, fail, guard, Output } from "./cli.ts";
import { gateCheck, gateDesign } from "./gate-check.ts";
import type { GateCtx } from "./hook-input.ts";
import { heldStop, PlanLib, planNumber, stackLog, statusRank } from "./plan-lib.ts";
import { dirname, git, globNames, isFile, isLink, readBytes } from "./sys.ts";
import { mainRoot } from "./utils.ts";

const P = (p: string): Buffer => Buffer.from(p, "latin1");

const USAGE = [
  "Usage: dev-stack.ts stack <root plan>",
  "       dev-stack.ts next <root plan> [--tab|--tree|--md]",
  "       dev-stack.ts review <plan> ready|needs-changes",
  "       dev-stack.ts approve <plan>",
  "       dev-stack.ts code-review <plan> pass|needs-changes",
  "       dev-stack.ts stop <plan> <reason>",
  "       dev-stack.ts resume <plan>",
  "       dev-stack.ts reopen <plan>",
  "       dev-stack.ts auto-reopen <plan>",
  "       dev-stack.ts renumber <root plan> <old>=<new> ...",
  "       dev-stack.ts drop <plan>",
  "       dev-stack.ts check <root plan>",
  "stack lists the unpublished plans, or every plan once the root is",
  "published, parents before children. next prints, per listed plan,",
  '"<plan> <status> <parent> <action> <reason>" tab-separated, with "-" for none',
  "(--tab, the default);",
  "action is a runnable phase (review-feature, execute-feature, review-code,",
  "create-pr), revise after a needs-changes review or a reopen, or stopped, wait-parent,",
  "wait-user, blocked, or done. --tree prints the stack as a tree instead, and",
  "--md as a Markdown table, both with a colored dot per status and a mark per",
  "action.",
  "review sets Status to the review-feature verdict, ready or needs-changes,",
  "and Spec to its hash of the current spec, and logs the round <k>/<limit>;",
  "code-review logs a review-code verdict the same way. A needs-changes verdict",
  "at or past the limit stops the plan. The limit starts at 3; resume at or past the limit sets it to the current round plus 3.",
  "approve sets a ready plan, whose review recorded by review holds and whose parent is approved or later,",
  "to auto-approved, the agent's approval; only the user sets approved. An",
  "approved plan is frozen: its Status never returns to planning and its spec",
  "never changes, until the user runs reopen, which returns it and every plan",
  "above it that is approved or later to planning and clears their stops. stop records in the",
  "stack's log why run-stack stopped a plan; it holds until the plan changes",
  'or resume clears it, and a round limit or one citing "Failed fixes: <n>/<limit>"',
  "with n at or past the limit holds until resume. Only the user runs resume and reopen.",
  "auto-reopen, dev-autopilot's reopen, returns plans to planning as reopen does when",
  "the approval of each is auto-approved, once per plan; it clears no stop: the",
  "Status change ends ordinary stops, and it refuses a held stop.",
  "renumber renames unapproved plans never executed, with the Stacks On lines",
  "and log lines naming them; drop deletes one and restacks its children.",
  "check runs the review-feature gate, without its parent-approval and stop checks, on each plan",
  "in the stack still in planning, printing PASS or BLOCK and the reason, and",
  "SKIP for a plan approved or later whose review still holds (BLOCK when it",
  "does not); it exits 1 on a block.",
  "<plan> is <main root>/docs/plans/<issue>_<slug>/pr<N>.spec.md, run from the repository.",
  "Exit: 0 ok, 1 failure, 2 usage.",
].join("\n");

const usage = (): never => {
  throw new Exit(2, `${USAGE}\n`);
};

const REOPEN_HINT =
  "The user reverts the change, or reopens it with dev-stack.ts reopen (rules/plan.md#changes)";

class Stack {
  readonly lib: PlanLib;
  readonly o: Output;
  readonly gate: GateCtx;
  plan = "";

  constructor(root: string, ctx: Ctx, o: Output) {
    this.o = o;
    this.lib = new PlanLib(root, {
      home: ctx.env["HOME"] ?? "",
      worktreesRoot: ctx.env["AI_WORKTREES_ROOT"],
    });
    this.gate = { cwd: root, env: ctx.env };
  }

  // ── plans ────────────────────────────────────────────────────────────

  /** A plan of this repository, a regular file. */
  requirePlan(arg: string): string {
    const plan = this.lib.canonicalPlan(arg);
    if (plan === undefined) fail(`Plan must be ${this.lib.planFormat}: ${arg}`);
    if (!isFile(plan) || isLink(plan)) fail(`Plan not found: ${plan}`);
    this.lib.indexStack(plan);
    return plan;
  }

  /** An unpublished plan of this repository, a regular file. */
  requireLive(arg: string): string {
    const plan = this.requirePlan(arg);
    if (this.lib.isPublished(plan)) fail(`${plan} is published; no phase resumes it.`);
    return plan;
  }

  stacksOn(plan: string): string {
    const parent = this.lib.parent(plan);
    if (parent === undefined) fail(`${plan} has an unreadable 'Stacks On:' line.`);
    return parent;
  }

  rank(plan: string): number | undefined {
    return statusRank(this.lib.status(plan));
  }

  /** Before approval and never approved since the last reopen. */
  unapproved(plan: string): boolean {
    return this.rank(plan) === 0 && this.lib.approvedHash(plan) === "";
  }

  /** Approved or later, or approved at some point since the last reopen. */
  reopenable(plan: string): boolean {
    const rank = this.rank(plan);
    return rank !== undefined && (rank >= 1 || this.lib.approvedHash(plan) !== "");
  }

  requireReadable(plans: readonly string[]): void {
    const bad = plans.filter((p) => p.startsWith("!"));
    if (bad.length > 0)
      fail(
        `Unreadable 'Stacks On:' lines in: ${bad.map((p) => `${p.replace(/!/g, "")} `).join("")}`,
      );
  }

  /** Root plan and every plan stacked above it, parents before children. */
  stackPlans(root: string): string[] {
    const parent = this.stacksOn(root);
    if (parent !== "") fail(`${root} stacks on ${parent}; pass the stack's root.`);
    if (this.lib.rootPlans(root).length !== 1)
      fail(
        `${dirname(root)} holds more than one plan without a 'Stacks On:' line; a directory holds one stack.`,
      );
    const plans = this.lib.descendantPlans(root);
    this.requireReadable(plans);
    return [root, ...plans];
  }

  /** stackPlans for stack and next: cleanup publishes the root last, so a published root means a published stack, listed whole. */
  listedPlans(root: string): string[] {
    if (!this.lib.isPublished(root)) return this.stackPlans(root);
    this.lib.includePublished = true;
    try {
      return this.stackPlans(root);
    } finally {
      this.lib.includePublished = false;
    }
  }

  /** Appends event to plan's lines in the stack log. */
  logEvent(plan: string, event: string): void {
    try {
      fs.appendFileSync(P(stackLog(plan)), P(`pr${planNumber(plan)}: ${event}\n`));
    } catch (e) {
      fail(`Cannot write ${stackLog(plan)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  keyOf(plan: string): string {
    const key = this.lib.stopKey(plan);
    if (key === undefined) fail(`Cannot hash ${plan}: a plan below it is missing or unreadable.`);
    return key;
  }

  stoppedWhy(plan: string): string {
    const reason = this.lib.stopReason(plan);
    if (reason === undefined)
      fail(`Cannot hash ${plan}: a plan below it is missing or unreadable.`);
    return reason;
  }

  setHeader(plan: string, pairs: readonly (readonly [string, string])[]): void {
    if (!this.lib.setHeader(plan, pairs)) fail(`Cannot write the header of ${plan}.`);
  }

  /** Fails unless plan may take a verdict now: not frozen and not stopped. */
  requireOpen(plan: string): void {
    const frozen = this.lib.freezeReason(plan);
    if (frozen !== "") fail(`${plan} is frozen: ${frozen}.`);
    const reason = this.stoppedWhy(plan);
    if (reason !== "")
      fail(`${plan} is stopped: ${reason}. Only the user clears it, with dev-stack.ts resume.`);
  }

  /**
   * Records an approval the user set by hand, which writes no log line, at the spec its review
   * passed, so the approval ratchet (freezeReason) binds it too. A user's approved over an
   * auto-approved one is recorded as well, so auto-reopen never takes it for dev-autopilot's.
   */
  noteApproval(plan: string): void {
    const status = this.lib.status(plan);
    const rank = statusRank(status);
    if (rank === undefined || rank < 1 || rank > 3) return;
    if (this.lib.reviewState(plan) !== "ready") return;
    if (
      this.lib.approvedHash(plan) !== "" &&
      !(status === "approved" && this.lib.approvalKind(plan) === "auto-approved")
    )
      return;
    const hash = this.lib.planHash(plan);
    if (hash === undefined) return;
    this.logEvent(plan, `approve approved at ${hash}`);
  }

  // ── verdicts and stops ───────────────────────────────────────────────

  stop(plan: string, reason: string): void {
    if (reason === "" || /[\t\n]/.test(reason))
      fail("A stop reason is one nonempty line without tabs.");
    const key = this.keyOf(plan);
    this.logEvent(plan, `stop ${reason} at ${key}`);
    this.o.out(`Stop recorded in ${stackLog(plan)}\n`);
  }

  resume(plan: string): void {
    this.logEvent(plan, "cleared");
    this.o.out(`Stop cleared in ${stackLog(plan)}\n`);
  }

  /**
   * Sets Status to the verdict and Spec to its hash of the current spec, in place, and logs the
   * round; a needs-changes verdict at or past the limit stops the plan until the user's resume or
   * reopen.
   */
  review(plan: string, verdict: string): void {
    if (verdict !== "ready" && verdict !== "needs-changes") usage();
    if (this.rank(plan) !== 0)
      fail(`${plan} is '${this.lib.status(plan)}'; a verdict records only before approval.`);
    this.requireOpen(plan);
    const spec = this.lib.planHash(plan);
    if (spec === undefined)
      fail(
        `Cannot hash ${plan}: a plan below it is missing, has an unreadable 'Stacks On:' line, or forms a cycle.`,
      );
    const hash = this.lib.verdictHash(spec, verdict);
    const key = this.keyOf(plan);
    const { round, limit } = this.lib.roundBudget(plan, "review");
    const k = round + 1;
    this.setHeader(plan, [
      ["Status", verdict],
      ["Spec", hash],
    ]);
    this.logEvent(plan, `review ${verdict} (${k}/${limit}) at ${spec}`);
    this.o.out(
      `Status: ${verdict}, Spec: ${hash} recorded in ${plan}, review-feature round ${k}/${limit}\n`,
    );
    if (verdict === "needs-changes" && k >= limit) {
      this.logEvent(plan, `stop review-feature round limit (${k}/${limit}) at ${key}`);
      this.o.out(
        `Stopped: review-feature round limit (${k}/${limit}); only the user grants more rounds, with dev-stack.ts resume.\n`,
      );
    }
  }

  /**
   * Logs review-code's verdict on an implemented plan; a needs-changes verdict at or past the limit
   * stops the plan until the user's resume or reopen. Status and Tip stay with review-code
   * (../skills/review-code/SKILL.md#finalize).
   */
  codeReview(plan: string, verdict: string): void {
    if (verdict !== "pass" && verdict !== "needs-changes") usage();
    if (this.lib.status(plan) !== "implemented")
      fail(
        `${plan} is '${this.lib.status(plan)}'; review-code verdicts record on an implemented plan.`,
      );
    this.requireOpen(plan);
    const key = this.keyOf(plan);
    const r = git(
      ["rev-parse", "--verify", "-q", `refs/heads/${this.lib.fieldOr(plan, "Branch")}^{commit}`],
      { cwd: this.lib.repoRoot },
    );
    const tip = r.code === 0 ? r.stdout.replace(/\n+$/, "") : "-";
    const { round, limit } = this.lib.roundBudget(plan, "code-review");
    const k = round + 1;
    this.logEvent(plan, `code-review ${verdict} (${k}/${limit}) at ${tip}`);
    this.o.out(`review-code ${verdict} recorded in ${stackLog(plan)}, round ${k}/${limit}\n`);
    if (verdict === "needs-changes" && k >= limit) {
      this.logEvent(plan, `stop review-code round limit (${k}/${limit}) at ${key}`);
      this.o.out(
        `Stopped: review-code round limit (${k}/${limit}); only the user grants more rounds, with dev-stack.ts resume.\n`,
      );
    }
  }

  /** Returns plan and every plan stacked above it that is approved or later to planning. */
  private toPlanning(plans: readonly string[], event: string): string[] {
    const done: string[] = [];
    for (const plan of plans) {
      if (!this.reopenable(plan)) continue;
      if (this.rank(plan) !== 0)
        this.setHeader(plan, [
          ["Status", "planning"],
          ["Tip", "-"],
        ]);
      this.logEvent(plan, event);
      done.push(plan);
    }
    return done;
  }

  /**
   * Returns an approved plan, and every plan stacked above it that is approved or later, to
   * planning: the user's way past the approval ratchet. Their Spec values stay, so each needs
   * review-feature again once revised.
   */
  reopen(plan: string): void {
    if (!this.reopenable(plan))
      fail(`${plan} is '${this.lib.status(plan)}'; reopen takes a plan approved or later.`);
    const plans = [plan, ...this.lib.descendantPlans(plan)];
    this.requireReadable(plans);
    this.o.out(`Reopened to planning: ${this.toPlanning(plans, "reopened").join(" ")}\n`);
  }

  /**
   * dev-autopilot's reopen of its own approval (../skills/autopilot/SKILL.md#decisions): reopen,
   * for a plan approved or later whose approval, and that of every plan above it that it returns
   * to planning, is dev-stack approve's; once per plan, counting a reopen it caused above; never
   * past a held stop.
   */
  autoReopen(plan: string): void {
    const rank = this.rank(plan);
    if (rank === undefined || rank < 1)
      fail(`${plan} is '${this.lib.status(plan)}'; auto-reopen takes a plan approved or later.`);
    const plans = [plan, ...this.lib.descendantPlans(plan)];
    this.requireReadable(plans);
    for (const p of plans) {
      if (!this.reopenable(p)) continue;
      if (this.lib.status(p) === "approved" || this.lib.approvalKind(p) !== "auto-approved")
        fail(
          `${p} carries the user's approval, or none recorded; only the user reopens it, with dev-stack.ts reopen.`,
        );
      if (this.lib.autoReopens(p) !== 0)
        fail(
          `${p} was auto-reopened once; only the user reopens it now, with dev-stack.ts reopen.`,
        );
      const reason = this.stoppedWhy(p);
      if (reason !== "" && heldStop(reason))
        fail(`${p} is stopped: ${reason}. Only the user clears it, with dev-stack.ts resume.`);
    }
    this.o.out(`Auto-reopened to planning: ${this.toPlanning(plans, "auto-reopened").join(" ")}\n`);
  }

  // ── reshaping ────────────────────────────────────────────────────────

  /**
   * Fails unless plan may be renumbered or dropped: before approval, never approved, never
   * executed, and not stopped, since a stopped plan dropped and rewritten as a new plan would
   * start its round count afresh.
   */
  requireMovable(plan: string): void {
    if (!this.unapproved(plan))
      fail(
        `${plan} is '${this.lib.status(plan)}' and approved since its last reopen; only an unapproved plan is renumbered or dropped.`,
      );
    // Rewritten at its number, an auto-reopened plan would regain its one auto-reopen.
    if (this.lib.autoReopens(plan) !== 0)
      fail(`${plan} was auto-reopened; it is revised, never renumbered or dropped.`);
    const reason = this.stoppedWhy(plan);
    if (reason !== "")
      fail(
        `${plan} is stopped: ${reason}. It is renumbered or dropped only after its stop ends (skills/run-stack/SKILL.md#stops).`,
      );
    const branch = this.lib.fieldOr(plan, "Branch");
    if (branch !== "" && this.lib.branchExists(branch))
      fail(`${plan}'s Branch ${branch} exists; a plan executed once is revised instead.`);
    if (this.lib.isWorktree(this.lib.worktreePath(this.lib.worktreeName(plan))))
      fail(`${plan} has a worktree; a plan executed once is revised instead.`);
  }

  /** Rewrites the "pr<N>: " prefixes of the stack log through map; a new number of "-" drops. */
  remapLog(dir: string, map: ReadonlyMap<string, string>): void {
    const log = `${dir}/log`;
    if (!isFile(log)) return;
    const text = readBytes(log);
    if (text === undefined) fail(`Cannot write the log of ${dir}.`);
    const rows = text.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    const out = rows
      .map((row) => {
        const m = /^pr([0-9]+): /.exec(row);
        const to = m?.[1] === undefined ? undefined : map.get(m[1]);
        if (m?.[1] === undefined || to === undefined) return `${row}\n`;
        const rest = row.slice(m[0].length - 2);
        return `${to === "-" ? `dropped pr${m[1]}` : `pr${to}`}${rest}\n`;
      })
      .join("");
    const tmp = `${log}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(P(tmp), P(out), { mode: 0o600 });
      fs.renameSync(P(tmp), P(log));
    } catch {
      fs.rmSync(P(tmp), { force: true });
      fail(`Cannot write the log of ${dir}.`);
    }
  }

  dirPlans(dir: string): string[] {
    return globNames(dir, "pr", ".spec.md")
      .sort(byteCompare)
      .filter((p) => isFile(p));
  }

  /**
   * Renumbers plans in the root plan's stack by "<old>=<new>" pairs, at once: renames each file,
   * rewrites each Stacks On line naming it, and remaps the log, so the user or autopilot can
   * split, merge, or insert plans before approval (../rules/plan.md#stacks).
   */
  renumber(root: string, pairs: readonly string[]): void {
    const dir = dirname(root);
    if (pairs.length === 0) usage();
    this.stackPlans(root);
    const to = new Map<string, string>();
    const taken = new Set<string>();
    const moves: [string, string][] = [];
    for (const pair of pairs) {
      const m = /^([1-9][0-9]*)=([1-9][0-9]*)$/.exec(pair);
      if (!m?.[1] || !m[2]) usage();
      const [, oldN, newN] = m as unknown as [string, string, string];
      if (!isFile(`${dir}/pr${oldN}.spec.md`)) fail(`No plan pr${oldN} in ${dir}.`);
      if (to.has(oldN)) fail(`pr${oldN} is renumbered twice.`);
      if (taken.has(newN)) fail(`Two plans would become pr${newN}.`);
      this.requireMovable(`${dir}/pr${oldN}.spec.md`);
      to.set(oldN, newN);
      taken.add(newN);
      moves.push([oldN, newN]);
    }
    // The plans that keep their numbers, and every plan's new parent.
    for (const plan of this.dirPlans(dir)) {
      const n = planNumber(plan);
      if (to.has(n)) continue;
      if (taken.has(n))
        fail(`pr${n} exists and is not renumbered; it cannot become another plan's number.`);
      to.set(n, n);
    }
    for (const plan of this.dirPlans(dir)) {
      const n = planNumber(plan);
      const parent = this.stacksOn(plan);
      if (parent === "") continue;
      const k = planNumber(parent);
      const tk = to.get(k) ?? "";
      const tn = to.get(n) ?? "";
      if (!(BigInt(tk || "0") < BigInt(tn || "0")))
        fail(`pr${tn} would stack on pr${tk}; a parent's number is below its children's.`);
      if (tk !== k && !this.unapproved(plan))
        fail(
          `${plan} is '${this.lib.status(plan)}' and stacks on pr${k}; renumbering its parent would change its frozen spec.`,
        );
    }
    for (const plan of this.dirPlans(dir)) {
      const parent = this.lib.parent(plan);
      if (!parent) continue;
      const k = planNumber(parent);
      if (to.get(k) !== k) this.setHeader(plan, [["Stacks On", `pr${to.get(k)}`]]);
    }
    for (const [o] of moves)
      fs.renameSync(P(`${dir}/pr${o}.spec.md`), P(`${dir}/.renumber-pr${o}.spec.md`));
    for (const [o, n] of moves)
      fs.renameSync(P(`${dir}/.renumber-pr${o}.spec.md`), P(`${dir}/pr${n}.spec.md`));
    this.remapLog(dir, new Map(moves));
    this.o.out(`Renumbered in ${dir}:\n`);
    for (const [o, n] of moves) this.o.out(`  pr${o} -> pr${n}\n`);
  }

  /**
   * Deletes plan, which is unapproved and never executed, and restacks its children on its parent;
   * when it is the root, its lowest-numbered child becomes the root and the others stack on it
   * (../rules/plan.md#stacks).
   */
  drop(plan: string): void {
    const dir = dirname(plan);
    this.requireMovable(plan);
    const parent = this.stacksOn(plan);
    const children = this.lib.childPlans(plan);
    this.requireReadable(children);
    for (const child of children)
      if (!this.unapproved(child))
        fail(
          `${child} is '${this.lib.status(child)}'; dropping its parent would change its frozen spec.`,
        );
    let first = "";
    for (const child of children) {
      if (parent !== "") this.setHeader(child, [["Stacks On", `pr${planNumber(parent)}`]]);
      else if (first === "") {
        first = child;
        this.unstack(child);
      } else this.setHeader(child, [["Stacks On", `pr${planNumber(first)}`]]);
    }
    fs.rmSync(P(plan));
    this.remapLog(dir, new Map([[planNumber(plan), "-"]]));
    this.o.out(`Dropped ${plan}${first !== "" ? `; ${first} is the root` : ""}\n`);
  }

  /** Removes the Stacks On header lines of plan, making it a root. */
  unstack(plan: string): void {
    const text = readBytes(plan);
    if (text === undefined) fail(`Cannot write the header of ${plan}.`);
    const rows = text.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    let body = false;
    let out = "";
    for (const row of rows) {
      if (!body && row.startsWith("## ")) body = true;
      if (body || !row.startsWith("Stacks On:")) out += `${row}\n`;
    }
    const tmp = `${plan}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      const mode = fs.statSync(P(plan)).mode & 0o7777;
      fs.writeFileSync(P(tmp), P(out), { mode });
      fs.chmodSync(P(tmp), mode);
      fs.renameSync(P(tmp), P(plan));
    } catch {
      fs.rmSync(P(tmp), { force: true });
      fail(`Cannot write the header of ${plan}.`);
    }
  }

  /**
   * Sets a ready plan auto-approved: the approval an agent records under dev-autopilot (run-stack
   * --auto-approve), kept apart from the user's approved. Spec stays, so the gates still bind the
   * approval to the reviewed spec.
   */
  approve(plan: string): void {
    if (this.lib.status(plan) !== "ready" || this.lib.reviewState(plan) !== "ready")
      fail(
        `${plan} is '${this.lib.status(plan)}'; approve needs a ready plan whose review still holds.`,
      );
    if (!this.lib.reviewLogged(plan))
      fail(
        `${plan} has no ready verdict from dev-stack.ts review at its current spec since its last reopen; approve needs one.`,
      );
    const parent = this.stacksOn(plan);
    if (parent !== "" && (this.rank(parent) ?? 0) < 1)
      fail(`${parent} must be approved or auto-approved first.`);
    this.requireOpen(plan);
    const hash = this.lib.planHash(plan);
    if (hash === undefined) fail(`Cannot hash ${plan}: a plan below it is missing or unreadable.`);
    this.setHeader(plan, [["Status", "auto-approved"]]);
    this.logEvent(plan, `approve auto-approved at ${hash}`);
    this.o.out(`Status: auto-approved recorded in ${plan}\n`);
  }

  // ── check and next ───────────────────────────────────────────────────

  /**
   * The review-feature gate, without its parent-approval and stop checks, on each plan in the stack
   * still in planning, as design-feature hands it over; false when any plan blocks. An approved
   * plan whose review still holds is past design and frozen (../rules/plan.md#changes), so a
   * revision above it still checks; one that breaks the approval ratchet blocks, as in next.
   */
  check(root: string): boolean {
    let failed = false;
    for (const plan of this.stackPlans(root)) {
      this.noteApproval(plan);
      const status = this.lib.status(plan);
      const rank = statusRank(status);
      const frozen = this.lib.freezeReason(plan);
      if (frozen !== "") {
        failed = true;
        this.o.out(`BLOCK ${plan}\nIt is frozen: ${frozen}.\n`);
        continue;
      }
      if (rank !== undefined && rank >= 1 && rank <= 3) {
        if (this.lib.reviewState(plan) === "ready") {
          this.o.out(`SKIP ${plan} (${status})\n`);
          continue;
        }
        failed = true;
        this.o.out(
          `BLOCK ${plan}\nIt is ${status}, but its spec or a plan below it changed since its review; an approved plan is frozen. ${REOPEN_HINT}.\n`,
        );
        continue;
      }
      const res = gateDesign(plan, this.gate);
      if (res === undefined) {
        this.o.out(`PASS ${plan}\n`);
        continue;
      }
      failed = true;
      this.o.out(`BLOCK ${plan}\n${"block" in res ? res.block : res.postBlock}\n`);
    }
    return !failed;
  }

  /** The gate's reason for running skill on plan; "" when it passes. */
  gateReason(skill: string, plan: string): string {
    const res = gateCheck(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: `dev:${skill}`, args: utf8(plan) },
      },
      this.gate,
    );
    return res === undefined ? "" : "block" in res ? res.block : res.postBlock;
  }

  /**
   * The next action for each plan in the stack, as "<plan> TAB <status> TAB <parent> TAB <action>
   * TAB <reason>" rows. A runnable phase is one its gate passes now, so next and the gates never
   * disagree. It also records an approval the user set by hand (noteApproval).
   */
  next(root: string, emit: (row: string) => void): void {
    const plans = this.listedPlans(root);
    const all = plans.every((p) => this.lib.status(p) === "reviewed");
    const rows = { push: emit };
    for (const plan of plans) {
      const status = this.lib.status(plan);
      const parent = this.lib.parent(plan) ?? "";
      if (status === "published") {
        rows.push(`${plan}\tpublished\t${parent || "-"}\tdone\t-`);
        continue;
      }
      let pstatus = "";
      let prank: number | undefined = 3;
      if (parent !== "") {
        pstatus = this.lib.status(parent);
        prank = statusRank(pstatus);
      }
      const pr = prank ?? 0;
      const state = this.lib.reviewState(plan);
      if (state === undefined)
        fail(`Cannot hash ${plan}: a plan below it is missing or unreadable.`);
      let action = "";
      let skill = "";
      this.noteApproval(plan);
      const frozen = this.lib.freezeReason(plan);
      let reason = this.stoppedWhy(plan);
      const { round, limit } = this.lib.roundBudget(plan, "review");
      const rounds = `${round}/${limit}`;
      let kind: string;
      if (frozen !== "") {
        kind = "frozen";
        reason = frozen;
      } else if (reason !== "") kind = "stopped";
      else if (statusRank(status) !== 0 && state === "stale") kind = "stale";
      else kind = status;
      const revise = "skills/design-feature/SKILL.md#7-revise-after-review";
      switch (kind) {
        case "frozen":
          action = "blocked";
          break;
        case "stopped":
          action = "stopped";
          break;
        case "stale":
          action = "blocked";
          reason = `its spec or a plan below it changed since its review; an approved plan is frozen. ${REOPEN_HINT}`;
          break;
        case "planning":
        case "needs-changes":
        case "ready":
          if (pr < 1) {
            action = "wait-parent";
            reason = `${parent} must be approved or auto-approved first`;
          } else if (state === "ready" && status === "ready") {
            action = "wait-user";
            reason = `review-feature ready (${rounds}); the user approves it, or dev-autopilot auto-approves it`;
          } else if (state === "needs-changes") {
            action = "revise";
            reason = `review-feature needs-changes (${rounds}); revise it (${revise}), then review it again`;
          } else if (state === "ready" && status === "planning") {
            action = "revise";
            reason = `back in planning with its ready review still holding; revise it with the user's answers (${revise}), then review it again`;
          } else skill = "review-feature";
          break;
        case "approved":
        case "auto-approved":
        case "implemented":
          if (pr < 3) {
            action = "wait-parent";
            reason = `${parent} must be reviewed first`;
          } else skill = status !== "implemented" ? "execute-feature" : "review-code";
          break;
        case "reviewed":
          if (pr < 3) {
            action = "blocked";
            reason = `${parent} is '${pstatus}'; once it is reviewed, merge it forward into this plan (rules/plan.md#worktree), set Status: implemented, and review-code`;
          } else if (parent !== "" && !this.lib.containsParentGreen(plan, parent)) {
            action = "blocked";
            reason = `its reviewed SHA does not contain ${parent}'s; merge it forward (rules/plan.md#worktree), set Status: implemented, and review-code`;
          } else if (plan === root && all) skill = "create-pr";
          else {
            action = "done";
            if (plan === root) reason = "the stack publishes once every plan is reviewed";
          }
          break;
        default:
          action = "blocked";
          reason = `unknown status '${status}'`;
      }
      if (skill !== "") {
        reason = this.gateReason(skill, plan);
        if (reason === "") action = skill;
        else {
          action = "blocked";
          reason = `${skill}: ${reason}`;
        }
        // The round this review-feature would be, once one was recorded.
        if (action === "review-feature" && round !== 0) reason = `round ${round + 1}/${limit}`;
      }
      // One line per plan: a gate reason may span lines.
      reason = reason.replace(/[\n\t]/g, " ");
      rows.push(`${plan}\t${status || "-"}\t${parent || "-"}\t${action}\t${reason || "-"}`);
    }
  }
}

// ── views ──────────────────────────────────────────────────────────────

const DOT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    planning: "⚪",
    "needs-changes": "🟠",
    ready: "🟤",
    approved: "🔵",
    "auto-approved": "🔷",
    implemented: "🟡",
    reviewed: "🟢",
    published: "🟣",
  }).map(([k, v]) => [k, b(v)]),
);
const MARK: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    "review-feature": "▶",
    "execute-feature": "▶",
    "review-code": "▶",
    "create-pr": "▶",
    revise: "✏️",
    "wait-user": "👤",
    "wait-parent": "⏳",
    blocked: "⛔",
    stopped: "🛑",
    done: "✅",
  }).map(([k, v]) => [k, b(v)]),
);

const marked = (v: string, map: Readonly<Record<string, string>>): string =>
  `${Object.hasOwn(map, v) ? map[v] : b("❔")} ${v}`;

/** Cuts the plan paths in s, all under pre, to their pr<N>. */
const short = (text: string, pre: string): string => {
  let s = text;
  let out = "";
  for (let at = s.indexOf(pre); at >= 0; at = s.indexOf(pre)) {
    out += s.slice(0, at);
    s = s.slice(at + pre.length).replace(/^[^/]*\//, "");
    const m = /^pr[0-9]+\.spec\.md/.exec(s);
    if (m) s = s.slice(0, m[0].length - 8) + s.slice(m[0].length);
  }
  return out + s;
};

/** TSV rows from next as a Markdown table, with "|" escaped and plans shortened to pr<N>. */
const mdView = (rows: readonly string[], pre: string): string => {
  let out = "| plan | status | parent | action | reason |\n|---|---|---|---|---|\n";
  for (const row of rows) {
    const f = row.split("\t").map((x) => short(x, pre).replace(/\|/g, "\\|"));
    out += `| ${f[0] ?? ""} | ${marked(f[1] ?? "", DOT)} | ${f[2] ?? ""} | ${marked(f[3] ?? "", MARK)} | ${f[4] ?? ""} |\n`;
  }
  return out;
};

/** TSV rows from next, root first and parents before children, as a tree. */
const treeView = (rows: readonly string[], pre: string): string => {
  const at = new Map<string, number>();
  const kids = new Map<number | undefined, number[]>();
  const line: string[] = [];
  rows.forEach((row, i) => {
    const f = row.split("\t").map((x) => short(x, pre));
    const [plan = "", status = "", parent = "", action = "", reason = ""] = f;
    at.set(plan, i);
    if (i > 0) {
      const p = at.get(parent);
      kids.set(p, [...(kids.get(p) ?? []), i]);
    }
    line[i] =
      `${plan} ${marked(status, DOT)}  ${marked(action, MARK)}${reason === "-" ? "" : ` ${b("—")} ${reason}`}`;
  });
  let out = "";
  const show = (i: number, lead: string, branch: string, below: string): void => {
    out += `${lead}${branch}${line[i]}\n`;
    const ks = kids.get(i) ?? [];
    ks.forEach((k, j) => {
      const last = j === ks.length - 1;
      show(k, below, last ? b("└─ ") : b("├─ "), below + (last ? "   " : b("│  ")));
    });
  };
  if (rows.length > 0) show(0, "", "", "");
  return out;
};

export const devStack: Command = (ctx) => {
  const o = new Output();
  return guard(o, () => {
    const argv = ctx.argv;
    const [cmd, arg = "", third] = argv;
    if (cmd === "--help" || cmd === "-h") {
      o.out(`${USAGE}\n`);
      return o.done();
    }
    const n = argv.length;
    const ok =
      n === 2 ||
      (n === 3 &&
        (cmd === "review" ||
          cmd === "code-review" ||
          cmd === "stop" ||
          (cmd === "next" && (third === "--tab" || third === "--tree" || third === "--md")))) ||
      (n >= 3 && cmd === "renumber");
    if (!ok) usage();
    const root = mainRoot(ctx.cwd, o);
    const s = new Stack(root, ctx, o);
    const need3 = (): string => (n === 3 ? (third as string) : usage());
    switch (cmd) {
      case "stack":
        for (const p of s.listedPlans(s.requirePlan(arg))) o.out(`${p}\n`);
        break;
      case "next": {
        const plan = s.requirePlan(arg);
        const view = third ?? "--tab";
        if (view === "--tab") {
          s.next(plan, (r) => o.out(`${r}\n`));
          break;
        }
        const rows: string[] = [];
        s.next(plan, (r) => rows.push(r));
        const pre = `${s.lib.repoPlans}/`;
        o.out(view === "--md" ? mdView(rows, pre) : treeView(rows, pre));
        break;
      }
      case "review": {
        const v = need3();
        s.review(s.requireLive(arg), v);
        break;
      }
      case "approve":
        s.approve(s.requireLive(arg));
        break;
      case "code-review": {
        const v = need3();
        s.codeReview(s.requireLive(arg), v);
        break;
      }
      case "stop": {
        const v = need3();
        s.stop(s.requireLive(arg), v);
        break;
      }
      case "resume":
        s.resume(s.requireLive(arg));
        break;
      case "reopen":
        s.reopen(s.requireLive(arg));
        break;
      case "auto-reopen":
        s.autoReopen(s.requireLive(arg));
        break;
      case "renumber":
        s.renumber(s.requireLive(arg), argv.slice(2));
        break;
      case "drop":
        s.drop(s.requireLive(arg));
        break;
      case "check": {
        const plan = s.requireLive(arg);
        if (!s.lib.plansIgnored())
          fail(
            `Git does not ignore docs/plans in ${root}, so a plan could be committed. Add /docs/plans/ to the global excludes file (git config core.excludesFile) or to .git/info/exclude.`,
          );
        return o.done(s.check(plan) ? 0 : 1);
      }
      default:
        usage();
    }
    return o.done();
  });
};
