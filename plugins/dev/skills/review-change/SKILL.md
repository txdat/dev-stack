---
name: review-change
description: "Independently review a direct edit's change before its PR, or an open PR, for security, data integrity, correctness, cost, and project rules, verifying each finding, and return every blocking finding ordered by impact, then notes."
model: sonnet
effort: high
---

# /review-change — Review a Change

Review one change independently under [artifact.md — Review](../../rules/artifact.md#review). Pass nothing to review the branch checked out in the worktree the task names, else in the current one, or a PR number to review that open PR. A plan-backed change before publication goes to [review-code](../review-code/SKILL.md) instead. The review is read-only: post nothing to GitHub, and run only commands that leave `git status` unchanged.

## Target

- **Branch:** the diff from `git merge-base <base ref> HEAD` to the working tree, where `<base ref>` is `origin/<Base>` (or local Base without one), Base being the default branch unless the task names one, plus each untracked file `git ls-files --others --exclude-standard` lists, read whole; the changed-file list is `git diff --name-only $(git merge-base <base ref> HEAD)` plus those untracked files. The requirement or issue the task gives, and the commit messages, state the author's intent.
- **PR:** `gh pr diff <PR>`, with the changed-file list from `gh pr diff <PR> --name-only` and intent from `gh pr view <PR>`: its title, body, and linked issue. Read code outside the diff at the PR's head, `headRefOid` from `gh pr view <PR> --json headRefOid`, with `gh api -H 'Accept: application/vnd.github.raw' 'repos/{owner}/{repo}/contents/<path>?ref=<headRefOid>'`.

A re-review covers only what [artifact.md — Review](../../rules/artifact.md#review) lists for a delta review.

## Find

Run three passes over the change. With 10 or fewer changed files, untracked files included, give each pass [CODING.md](../../rules/CODING.md), the diff, the changed-file list, the author's intent, and this file; where you can start subagents, run the three passes in parallel, each in a fresh child subagent under [artifact.md — Review](../../rules/artifact.md#review), otherwise run them here, one after another.

1. **Diff bugs:** read only the diff. Report code that fails to build or parse, and logic that is wrong for every input the changed code can receive.
2. **Context bugs:** read the changed code with its callers, callees, and the contracts it relies on under [CODING.md — Impact](../../rules/CODING.md#impact). Report security, data-integrity, concurrency, and failure-path defects, a wrong result or crash for a concrete input or state the changed code can receive, and unbounded or repeated work on a production path.
3. **Project rules:** read the project's instruction files, such as AGENTS.md and CLAUDE.md, in each changed file's directory and its parents, for a PR at `headRefOid` as in Target; a file applies only to the files under its directory. Report each rule the change breaks, quoting the rule.

When the change has more than 10 changed files, untracked files included, split each pass into groups of at most 10 related files directly instead of starting per-pass subagents, such as an interface with its implementations or a resource with its locale variants. Give each group [CODING.md](../../rules/CODING.md), the author's intent, this file, the list of its files, and only the diff hunks and untracked contents of its files. Where you can start subagents, run each group in its own fresh child subagent under [artifact.md — Review](../../rules/artifact.md#review); otherwise run the groups here, one after another. Each pass, and each group, lists every changed file it was given as `reviewed`, or as `skipped` with its reason when the file has no source of its own to read, such as a binary or a file generated from another changed file; a file `skipped` for any other reason counts as left off the list. Before Verify, rerun each pass or group once on each file it left off its list and add any findings to the candidates; list each file still left off as `unreviewed`.

Never report:

- an issue that exists before the change, or code the change does not touch or affect;
- style, naming, or preferences that no applicable instruction file states;
- lint and format findings the project's linter or formatter reports;
- general advice, such as more tests or general hardening, unless an applicable instruction file requires it;
- a rule the code silences explicitly, such as with a lint-ignore comment;
- code that looks wrong but is correct, once its context is read.

## Verify

Merge candidates that name the same defect at the same `file:line` into one, keeping the evidence of each. Check each candidate before reporting it. Where you can start subagents, give each candidate to a fresh child subagent under [artifact.md — Review](../../rules/artifact.md#review) with the diff, the author's intent, and the candidate alone; otherwise re-check it against the code, not against the reasoning that found it. Confirm that the cited code does what the finding says, that the failure follows for a concrete input or state, and, for a project rule, that the rule applies to the file and the change breaks it. Prove runtime behavior with a run where an existing command, such as an affected test with crafted inputs, shows it without changing a file or shared state; for a PR, only when the current checkout is at `headRefOid`, else the finding is at most `traced`. Label each finding `ran`, `traced`, `located`, or `asserted` as [review-code.md — Behavior](../review-code/SKILL.md#behavior) defines them. Drop a candidate only when it falls under Never report, or when the check cites the `file:line`, instruction file, or run that refutes it; a candidate the check cannot settle is `asserted`.

## Blocking

A finding blocks when it has a location and evidence and is not `asserted`. Order blocking findings by class, then within a class by reach: a production path before others, then the more callers or users affected.

1. **Security:** a broken security boundary, such as missing authorization, injection, or a leaked secret.
2. **Data integrity:** data loss, corruption, or a race that leaves state inconsistent.
3. **Correctness:** a wrong result, a crash, or code that fails to build.
4. **Cost:** unbounded or repeated work on a production path.
5. **Project rule:** a rule from an applicable instruction file, quoted, that the change breaks, including a rule that governs style or wording.

Every other finding is a note.

## Report

Name the target with its base SHA, its head SHA, and, for a branch, whether it has uncommitted or untracked changes; for a PR, `baseRefOid` and `headRefOid` from `gh pr view <PR> --json baseRefOid,headRefOid`. List every blocking finding in the order above, none dropped or capped, each with its class, `file:line`, the defect in one sentence, the failure scenario as the input or state and the wrong result, its evidence, and its label. Then list the notes. List each file a pass skipped, with the pass and its reason; each file left `unreviewed`, with the pass; and the number of changed files each pass reviewed. When nothing blocks, say so and name the passes that ran. Return `PASS` when nothing blocks, else `NEEDS CHANGES`. The main agent counts rounds under artifact.md — Review.
