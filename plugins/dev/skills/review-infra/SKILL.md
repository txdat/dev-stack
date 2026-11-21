---
name: review-infra
description: "Review an infra/devops runbook against live state with read-only commands: phase ordering, rollback safety, DNS/traffic cutover sequencing, IaC completeness, and CI/CD coverage."
model: haiku
effort: high
---

# /review-infra — Review a Runbook

Review the exact `docs/runbook/<issue>_<slug>/rb.md` independently under [artifact.md — Review](../../rules/artifact.md#review), against [design-infra.md](../design-infra/SKILL.md), using read-only checks only.

## Before execution

Validate each `CL-n` claim and `RS-n` resource against live workloads, images, network and DNS, data, IaC, and CI/CD state. Keep an evidence map:

`Claim / expected state | Live observation | Source, command, time | MATCH, MISMATCH, MISSING, EXTRA, STALE, or UNVERIFIED | Affected PH-n`

Failed collection is `UNVERIFIED`, never proof of absence. Check the phases against design-infra's ordering and gate rules, especially coexistence and duplicate processing, traffic dependencies, and whether rollback resources survive their promised window. Gates need observable pass and stop conditions: a phase's Prerequisites gate its Commands, and its Verification gates the next phase. Missing evidence that affects execution safety blocks.

Return `READY` or `NEEDS CHANGES` with findings ranked by severity and the decisive command evidence; a re-review is a delta review under [artifact.md — Review](../../rules/artifact.md#review). Unless the request is review-only, the main agent records the verdict with `node $DEV_LIB/bin/dev-stack.js doc-review <runbook> ready|needs-changes` under [documents.md](../../rules/documents.md).

## After execution

Run when the user reports what ran, in full or in part; the runbook is not proof of execution. Work in a checkout of the branch that holds the runbook, such as an open PR's branch; its `log` lives there. Run `node $DEV_LIB/bin/dev-stack.js doc-check <runbook>` first; the audit continues on any result. On exit 1 or a Status below `approved`, report the execution of an unapproved or changed runbook as a blocking finding that names the missing condition: the Status, or a Spec that no longer holds.

Check each `SC-n`, remaining `RS-n`, divergence from the plan, and prerequisites of unfinished phases. For irreversible actions, determine whether their gates held beforehand; current health cannot prove that. Mark what you cannot verify `UNVERIFIED`.

Return, in order:

1. **Findings:** each blocking finding, with its evidence.
2. **Done:** `PH-n, SC-n, or RS-n | Outcome and gates | Live evidence: source, command, time | MATCH, MISMATCH, or UNVERIFIED`. A phase row states the outcomes of its Prerequisites and Verification gates.
3. **Open:** `PH-n, SC-n, or RS-n | Blocker or remaining work | User's next action`. Each unfinished phase, phase with a `MISMATCH` or `UNVERIFIED` gate, failed or `UNVERIFIED` criterion, and residue gets a row.
4. **`EX-n` entry**, in plain text for the `log`: phases run, gate outcomes, divergence, residue, remaining work, and whether every criterion holds with no work remaining. Label it `draft` when [documents.md — Runbook](../../rules/documents.md#runbook) bars appending it.

Each `PH-n` appears in at least one table; a partial phase appears in both. When authorized, the main agent appends the entry to the `log` and sets `Status: executed` under [documents.md — Runbook](../../rules/documents.md#runbook), the latter only when every criterion holds and no work remains. This audit never executes or remediates.
