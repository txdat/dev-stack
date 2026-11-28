---
name: design-system
description: "Design cross-cutting architecture changes such as new communication patterns, service boundaries, or integrations, with options, contracts, migration, rollback, and decomposition."
model: opus
effort: medium
---

# /design-system — Architecture Design

Use for changed service boundaries, communication patterns, or cross-system integrations; ordinary features use [design-feature.md](../design-feature/SKILL.md). Assess impact under [CODING.md — Impact](../../rules/CODING.md#impact).

Write `docs/architecture/<issue>_<slug>.html` with the header [documents.md](../../rules/documents.md) gives, in the language [artifact.md — Naming and language](../../rules/artifact.md#naming-and-language) prescribes, with these sections:

- **`Goal and Constraints`:** current pain, affected boundaries, and each measurable success criterion as `SC-n`, with its baseline or the `PH-n` that establishes it.
- **`Options`:** each viable choice as `OP-n`, compared against the same constraints, including a simpler starting system. Cite the recommended one and justify its complexity by current needs. Diagram the current system's components as a `flowchart` before `OP-1`, and the recommended option's under it.
- **`Contracts`:** each changed contract as `CT-n`: owner, data and call flow, compatibility, delivery and failure semantics. Account for actual consumers. Give each contract with calls or messages a `sequenceDiagram`, including its failure paths.
- **`Migration`** (when needed): ordered `PH-n — <outcome>` phases, each with its change, verification gate, rollback and its limits. For each phase that moves data or traffic between systems, cover synchronization, cutover, and reconciliation; mark irreversible steps.
- **`Decomposition`:** `DC-n — <future plan> — CT-n — <obligation> — stacks on DC-k|root` entries assigning every changed contract to a future application plan, with the observable obligation and how its TCs will verify it. Where a contract crosses plans, list the producer plan first; the consumer stacks on it. Diagram exactly those `stacks on` edges as a `flowchart` of `DC-n` nodes, producer `-->` consumer.

## Format

Write the document as a diagram page under [diagrams.md](../../rules/diagrams.md):

```html
<h1>{title}</h1>
<pre>
Status: draft
Spec: -
Issue: #N|none
</pre>
<h2>Contracts</h2>
<h3 id="CT-1">CT-1 — {contract}</h3>
```

- Each section is an `<h2>` named as above.
- `OP-n`, `CT-n`, and `PH-n` start their own `<h3>`; `SC-n` and `DC-n` start their own `<li>`. Each element carries its ID as `id`; cite another artifact's as `<a href="<path>#ID">`.
- The [render check](../../rules/diagrams.md#render-check) uses the document's `<slug>`.

Finish when the recommendation meets the constraints, every contract has an owner, and migration and decomposition can deliver the measured outcome. Hand off to [review-system.md](../review-system/SKILL.md). On `NEEDS CHANGES`, fix each blocking finding in the draft, take a finding that needs a new decision to the user with options and a recommendation, and hand back to review-system; [artifact.md — Review](../../rules/artifact.md#review) owns the round limit. [documents.md](../../rules/documents.md) owns approval and freezing; a needed change to an approved document goes to the user with options and a recommendation.
