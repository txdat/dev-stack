---
name: execute-feature
description: "Implement an approved or auto-approved plan with test-first commits and verification at its branch tip."
model: haiku
effort: high
---

# /execute-feature — Implement an Approved or Auto-Approved Plan

Implement an `approved` or `auto-approved` plan test-first under [plan.md](../../rules/plan.md).

1. Without the plan's worktree, create it under [plan.md — Worktree](../../rules/plan.md#worktree). With one, resume in it on the plan's Branch: finish the RED then implementation commits, or for `Type: config` the change, and rerun the checks. When the Branch already holds commits of an earlier revision of the plan, update its tests under the revised-plan rule in [plan.md — Verification](../../rules/plan.md#verification) before implementing.
2. Before each step, run its PC Checks; a failure stops that step and everything depending on it under [plan.md — Changes](../../rules/plan.md#changes).
3. Follow [plan.md — Verification](../../rules/plan.md#verification) and [plan.md — Rationale](../../rules/plan.md#rationale): RED commit, then implementation, or for `Type: config`, the change and its TC checks.

To delegate chunks, use [executor](../../agents/executor.md) where installed. Whoever runs this skill owns the RED tests, their commit, and the plan; chunk workers never edit them. Give each chunk worker the DD invariants its files enforce.

For a change to a rendered UI, run [frontend-design.md — Verification](../../rules/frontend-design.md#verification) at the tip before setting `Status: implemented`.

When the plan passes its checks, set `Status: implemented`, report each TC's test with its result where [plan.md — Verification](../../rules/plan.md#verification) requires it, or for `Type: config` its check result. Then hand off to [review-code.md](../review-code/SKILL.md).
