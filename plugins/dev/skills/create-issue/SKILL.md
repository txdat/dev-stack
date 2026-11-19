---
name: create-issue
description: "Create a GitHub issue with a specific problem, expected outcome, and requested metadata, standalone or for a plan to link."
model: haiku
effort: medium
---

# /create-issue — Capture a Standalone Issue

Write a specific title and body from the supplied problem, context, and expected outcome. Ask only for missing essentials, and apply requested labels and milestone. Create it with `bun --no-env-file --config=/dev/null $DEV_LIB/bin/dev-utils.js issue-create <title> <body-file> [gh options]` under [plan.md — Git identity](../../rules/plan.md#git-identity), then return its URL.
