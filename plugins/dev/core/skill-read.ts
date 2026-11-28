// The phase gate on a model's read of a skill's SKILL.md, for harnesses with no Skill tool whose
// adapter maps that read to a Skill call (bin/agy-hook.ts, bin/codex-hook.ts). The call's text is
// the model's latest message, which may name no plan: an orchestrator such as run-stack names the
// plan in a message of its own, so a read that names no plan passes while some plan can run the
// phase, and a read naming a blocked plan gets a hint of how to name the runnable one.

import * as fs from "node:fs";
import * as path from "node:path";
import { gateCheck, gateIndexed, isPhaseCall } from "./gate-check.ts";
import { type GateCtx, type HookInput, member, str } from "./hook-input.ts";
import { PlanLib, planMentions } from "./plan-lib.ts";
import { tryMainRoot } from "./utils.ts";

/** The skill slug if `filePath` names a skill's SKILL.md (`…/skills/<slug>/SKILL.md`); "" for none. */
export const skillFromPath = (filePath: string): string => {
  const m = /(?:^|\/)skills\/([a-z0-9-]+)\/SKILL\.md$/i.exec(filePath.replace(/\\/g, "/"));
  return m?.[1] ?? "";
};

/** Whether `text` invokes an orchestrator (`autopilot` or `run-stack`). */
const isOrchestratorInput = (text: string): boolean =>
  /^[ \t\n\v\f\r]*\/?(?:skill:(?:dev[:-])?|dev[:-])?(?:autopilot|run-stack)(?:[^a-z0-9_-]|$)/i.test(
    text.replace(/_/g, "-"),
  );

const PHASE_ENTRY_STATUSES: Record<string, readonly string[]> = {
  "review-feature": ["planning", "needs-changes", "ready"],
  "execute-feature": ["approved", "auto-approved"],
  "review-code": ["implemented"],
  "create-pr": ["reviewed"],
};

/**
 * Whether any plan in the main root's `docs/plans/` passes `gateIndexed` for `skill`. A
 * `Status: ready` plan counts for `review-feature` only when its review is stale (not current
 * `ready`), so a plan awaiting the user's approval does not permanently unlock the gate.
 */
const hasRunnablePlan = (skill: string, ctx: GateCtx): boolean => {
  const slug = skill.startsWith("dev:") ? skill.slice(4) : skill;
  const allowedStatuses = PHASE_ENTRY_STATUSES[slug];
  if (!allowedStatuses) return false;
  const root = tryMainRoot(ctx.cwd, ctx.env);
  if (!root) return false;
  const plansDir = path.join(root, "docs", "plans");
  let stacks: fs.Dirent[];
  try {
    stacks = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const lib = new PlanLib(root, ctx);
  const indexed = new Set<string>();
  for (const stack of stacks) {
    if (!stack.isDirectory()) continue;
    const stackDir = path.join(plansDir, stack.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(stackDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^pr[1-9][0-9]*\.spec\.md$/.test(entry.name)) continue;
      const planPath = path.join(stackDir, entry.name);
      const status = lib.status(planPath);
      if (!allowedStatuses.includes(status)) continue;
      if (!indexed.has(stackDir)) {
        lib.indexStack(planPath);
        indexed.add(stackDir);
      }
      if (slug === "review-feature" && status === "ready" && lib.reviewState(planPath) === "ready")
        continue;
      if (gateIndexed(slug, planPath, lib) === undefined) return true;
    }
  }
  return false;
};

/**
 * The gate's refusal of `mapped`, a Skill call an adapter mapped from a SKILL.md read, or of any
 * other mapped call; undefined to pass. Throws as gateCheck does.
 */
export const skillReadBlock = (mapped: HookInput, ctx: GateCtx): string | undefined => {
  const verdict = gateCheck(mapped, ctx);
  if (!verdict || !("block" in verdict)) return undefined;
  const skill = str(member(mapped["tool_input"], "skill")) ?? "";
  const args = str(member(mapped["tool_input"], "arguments")) ?? "";
  const runnable = isPhaseCall(mapped) && hasRunnablePlan(skill, ctx);
  if (runnable && (isOrchestratorInput(args) || planMentions(args).length === 0)) return undefined;
  // A plan the message names blocked the call while another plan can run this phase.
  const slug = skill.startsWith("dev:") ? skill.slice(4) : skill;
  const hint = runnable
    ? ` To run ${slug} on a runnable plan, read its SKILL.md in a message that says \`Starting ${slug} on <plan path>\` and names no other plan (skills/run-stack/SKILL.md, step 2).`
    : "";
  return verdict.block + hint;
};
