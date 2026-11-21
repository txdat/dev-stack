---
name: explore
description: "Read-only exploration of a codebase area to identify entry points, key files, data flow, established patterns, gotchas, and planning questions."
model: haiku
effort: medium
---

# /explore — Understand Existing Code

Keep the investigation read-only and scoped to the supplied question or area.

Locate entry points, follow the relevant data/control flow, and identify established patterns, contracts, tests, and meaningful gotchas. Use [CODING.md — Impact](../../rules/CODING.md#impact) when the question concerns impact; `node $DEV_LIB/bin/dev-utils.js search-production <symbol> [dir]` lists literal matches outside test files.

Return the direct answer with decisive file references and unresolved planning questions. Stop when the requested question is answered.
