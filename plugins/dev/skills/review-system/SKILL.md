---
name: review-system
description: "Review an architecture design for measurable outcomes, viable alternatives, boundary contracts, failure modes, migration and rollback safety, and dependency-ordered decomposition."
model: opus
effort: medium
---

# /review-system — Review an Architecture Design

Review a `draft` or `ready` HTML architecture document independently under [artifact.md — Review](../../rules/artifact.md#review), against [design-system.md](../design-system/SKILL.md).

Check the recommendation against the Goal and constraints, simpler viable alternatives, the actual boundary contracts, and failure and compatibility risks. Check that migration gates and rollbacks are executable. Trace every changed `CT-n` to a `DC-n` entry with an owning future plan, an observable obligation, and a verification route; producer and consumer responsibilities must agree, without dependency cycles or speculative work. Missing ownership or unverifiable obligations block; application plans need not exist yet. Run the render step yourself. A document that breaks [design-system.md — Format](../design-system/SKILL.md#format), lacks a required diagram, or omits a contract's failure paths blocks.

Report located findings with consequences, and `READY` or `NEEDS CHANGES`; a re-review is a delta review under [artifact.md — Review](../../rules/artifact.md#review). Unless the request is review-only, the main agent records the verdict with `node $DEV_LIB/bin/dev-stack.js doc-review <document> ready|needs-changes` under [documents.md](../../rules/documents.md).
