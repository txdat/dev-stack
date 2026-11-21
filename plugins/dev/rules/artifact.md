# Artifacts and Review

What plans ([plan.md](plan.md)), runbooks, and architecture documents ([documents.md](documents.md)) share: naming, prose language, and how every review skill runs.

## Naming and language

A plan's stack directory, a runbook's directory, and an architecture document's file stem are named `<issue>_<slug>`: `<issue>` is the issue number or `0`, and `<slug>` lowercase words joined by hyphens.

Write plan, document, PR, and review prose in the linked issue's primary language, or English without one. Keep headings, field names, statuses, IDs, code, and paths as the artifact's owner writes them.

## Review

These rules apply to every review skill. When this session wrote the artifact, run the review in a subagent that has not seen the conversation: the [reviewer](../agents/reviewer.md) agent where installed, on the model and effort in the review skill's frontmatter. Give it only [CODING.md](CODING.md), the review skill and the files that skill links directly, the artifact path, the user's request, the worktree and refs it needs, for review-code execute-feature's per-TC report and, outside a review-only request, its round's scratch path ([plan.md — Review rounds](plan.md#review-rounds)), and, for a re-review, the prior findings and the diff of the repair. A stacked plan's reviewer also reads the plans below it. If no subagent is available, review directly and say so.

The main agent keeps one reviewer for a stack's review-feature rounds, plans in dependency order, one per plan for its review-code rounds, and one per review-change target for its rounds, and sends each next plan or round to it through the harness's message or resume tool. It starts a fresh reviewer, given the same inputs, where the harness has no such tool, the reviewer's context is full, or another review is still running in it.

Preferences and style never block, except that in review-change and review-code a rule quoted from an applicable instruction file blocks ([review-change.md — Blocking](../skills/review-change/SKILL.md#blocking)). The reviewer may read, run tests, and inspect Git. It edits files only in its review-code round's scratch and under `/tmp`, never inside a linked dependency, and never commits, touches refs, the stash, or status, or installs dependencies. The main agent repairs. A review-only request gets no scratch, returns findings, and changes nothing. The reviewer may start at most one level of child subagents (at most three levels in total from the main agent); it tells each child subagent it never starts further subagents.

Round 1 covers the whole artifact. A re-review is a delta review: it checks the prior findings, the changed text, what cites or depends on it, and the PC Checks of changed PCs, and, in review-code, the repair diff with the TC and affected tests at the new tip, and nothing else.

A review has 3 rounds: round 1 and two re-reviews. For a plan, dev-stack.js counts them under [plan.md — Review rounds](plan.md#review-rounds). For an architecture document, a runbook, or a review-change target, the main agent counts them, and a NEEDS CHANGES verdict on the round at its limit goes to the user, who decides whether to grant three more rounds.
