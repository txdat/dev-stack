---
name: explore
description: "Read-only gathering of facts about a codebase area, for questions such as \"where is X\", \"what touches X\", or context before planning: entry points, key files, data flow, established patterns, and gotchas, each with its file reference, and planning questions, without explaining how the code works."
model: haiku
effort: medium
---

# /explore — Gather Facts About Existing Code

Keep the investigation read-only and scoped to the supplied question or area. Explore gathers facts; explaining how the code works is [explain](../explain/SKILL.md).

Locate entry points, record the relevant data/control flow path as file references, and identify established patterns, contracts, tests, and meaningful gotchas. Use [CODING.md — Impact](../../rules/CODING.md#impact) when the question concerns impact; `node $DEV_LIB/bin/dev-utils.js search-production <symbol> [dir]` lists literal matches outside test files.

Return the findings as facts, each with its decisive file reference, and unresolved planning questions, without narrative or design rationale. Stop when the requested facts are gathered.
