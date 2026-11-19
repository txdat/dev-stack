---
name: review-infra
description: "Review an infra/devops runbook against live state with read-only commands: phase ordering, rollback safety, DNS/traffic cutover sequencing, IaC completeness, and CI/CD coverage."
model: haiku
effort: high
---

# /review-infra — Review a Runbook

Review the exact `docs/runbook/<issue>_<slug>/rb.md` independently under [plan.md — Review](../../rules/plan.md#review), against [design-infra.md](../design-infra/SKILL.md), using read-only checks only.

## Before execution

Validate each `CL-n` claim and `RS-n` resource against live workloads, images, network and DNS, data, IaC, and CI/CD state. Keep an evidence map:

`Claim / expected state | Live observation | Source, command, time | MATCH, MISMATCH, MISSING, EXTRA, STALE, or UNVERIFIED | Affected PH-n`

Failed collection is `UNVERIFIED`, never proof of absence. Check the phases against design-infra's ordering and gate rules, especially coexistence and duplicate processing, traffic dependencies, and whether rollback resources survive their promised window. Gates need observable pass and stop conditions: a phase's Prerequisites gate its Commands, and its Verification gates the next phase. Missing evidence that affects execution safety blocks.

Return `READY` or `NEEDS CHANGES` with findings ranked by severity and the decisive command evidence; a re-review is a delta review under [plan.md — Review](../../rules/plan.md#review). Unless the request is review-only, the main agent records the verdict with `bun --no-env-file --config=/dev/null $DEV_LIB/bin/dev-stack.js doc-review <runbook> ready|needs-changes` under [plan.md — Documents](../../rules/plan.md#documents).

## After execution

Run only when the human confirms what ran on an approved runbook that passes the check under [plan.md — Documents](../../rules/plan.md#documents); the runbook is not proof of execution. Check each `SC-n`, remaining `RS-n`, divergence from the plan, and prerequisites of unfinished phases. For irreversible actions, determine whether their gates held beforehand; current health cannot prove that. Report what you cannot verify.

Return the content of an `EX-n` entry: phases run, gate outcomes, divergence, residue, remaining work, and whether every criterion holds with no work remaining. When authorized, the main agent appends it to the runbook's `log` under [plan.md — Documents](../../rules/plan.md#documents), and sets `Status: executed` only when every criterion holds and no work remains. Report the human's next action; this audit never executes or remediates.
