---
name: design-infra
description: "Design a runnable infrastructure runbook from live-state evidence, verification gates, and rollback requirements."
model: haiku
effort: high
---

# /design-infra — Infrastructure Runbook

Use for migrations, deployments, DNS, IaC, and database operations within established boundaries; architecture changes use [design-system.md](../design-system/SKILL.md). The lane is design → review → the user's approval → the user's execution → after-execution audit. This skill writes a runbook from read-only live-state checks; it never mutates infrastructure.

Write `docs/runbook/<issue>_<slug>/rb.md` with its `# ` title and the header [documents.md](../../rules/documents.md) gives, in the language [artifact.md — Naming and language](../../rules/artifact.md#naming-and-language) prescribes. Declare each ID at the start of a line in its section, outside code fences; write the phase template unfenced.

- **`## Success Criteria`:** each measurable criterion as `SC-n` with its read-only verification command.
- **`## Evidence`:** each material live-state claim as `CL-n`: value, source command, observation time, and status — verified, assumed, or revalidate before execution. An assumed claim needs a verification gate before any phase relies on it.
- **`## Resources`:** each affected workload or resource as `RS-n`: move, already moved, or untouched. Capture exact images or digests, config references, probes, and companion processes. No secret values.
- **`## Phases`:** one block per phase, citing SC, CL, and RS IDs instead of repeating them:

```text
### PH-<n> — <outcome>
Prerequisites: <dependencies, required state and evidence>
Commands: <runnable commands with explicit targets>
Verification / gate: <read-only checks, expected results, stop condition>
Rollback / recovery: <trigger, commands, prerequisites and limits>
Time window: <duration, rollback deadline>
```

- **`## Open Questions`:** each unresolved question as `OQ-n`, citing the `PH-n` it blocks.

Order phases so backups and baselines precede mutation, healthy replacements precede cutover and drain, and gated destruction comes last; keep the rollback target until cutover is verified. Mark irreversible actions; never promise rollback after its prerequisites are gone. Check source and target coexistence and duplicate processing, pinned versions, dependent resources, DNS and traffic mappings, IaC changes, and CI/CD placement. A destruction phase accounts for dependencies, deletion protection, backups, and the user's explicit confirmation.

Finish when the operation is concrete and reviewable; hand off to [review-infra.md](../review-infra/SKILL.md). On `NEEDS CHANGES`, fix each blocking finding in the runbook, take a finding that needs a new decision to the user with options and a recommendation, and hand back to review-infra; [artifact.md — Review](../../rules/artifact.md#review) owns the round limit.
