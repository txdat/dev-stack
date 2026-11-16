---
name: review-change
description: "Independently review a direct edit's change before its PR, or an open PR, for security, data integrity, correctness, cost, and project rules, verifying each finding, and return every blocking finding ordered by impact, then notes."
model: haiku
effort: high
---

# /review-change — Review a Change

Review one change independently under [plan.md — Review](../../rules/plan.md#review). Pass nothing to review the branch checked out in the worktree the task names, else in the current one, or a PR number to review that open PR. A plan-backed change before publication goes to [review-code](../review-code/SKILL.md) instead. The review is read-only: post nothing to GitHub, and run only commands that leave `git status` unchanged.

## Target

- **Branch:** the diff from `git merge-base origin/<Base> HEAD` to the working tree, Base being the default branch unless the task names one, plus each untracked file `git ls-files --others --exclude-standard` lists, read whole. The requirement or issue the task gives, and the commit messages, state the author's intent.
- **PR:** `gh pr diff <PR>`, with intent from `gh pr view <PR>`: its title, body, and linked issue. Read code outside the diff at the PR's head, `headRefOid` from `gh pr view <PR> --json headRefOid`, with `gh api -H 'Accept: application/vnd.github.raw' 'repos/{owner}/{repo}/contents/<path>?ref=<headRefOid>'`.

A re-review covers only what [plan.md — Review](../../rules/plan.md#review) lists for a delta review.

## Find

Run three passes over the change, each given [CODING.md](../../rules/CODING.md), the diff, the author's intent, and this file. Where you can start subagents, run them in parallel, each in a fresh subagent; otherwise run them here, one after another.

1. **Diff bugs:** read only the diff. Report code that fails to build or parse, and logic that is wrong for every input the changed code can receive.
2. **Context bugs:** read the changed code with its callers, callees, and the contracts it relies on under [CODING.md — Impact](../../rules/CODING.md#impact). Report security, data-integrity, concurrency, and failure-path defects, a wrong result or crash for a concrete input or state the changed code can receive, and unbounded or repeated work on a production path.
3. **Project rules:** read the project's instruction files, such as AGENTS.md and CLAUDE.md, in each changed file's directory and its parents, for a PR at `headRefOid` as in Target; a file applies only to the files under its directory. Report each rule the change breaks, quoting the rule.

Never report:

- an issue that exists before the change, or code the change does not touch or affect;
- style, naming, or preferences that no applicable instruction file states;
- lint and format findings the project's linter or formatter reports;
- general advice, such as more tests or general hardening, unless an applicable instruction file requires it;
- a rule the code silences explicitly, such as with a lint-ignore comment;
- code that looks wrong but is correct, once its context is read.

## Verify

Check each candidate before reporting it. Where you can start subagents, give each candidate to a fresh subagent with the diff, the author's intent, and the candidate alone; otherwise re-check it against the code, not against the reasoning that found it. Confirm that the cited code does what the finding says, that the failure follows for a concrete input or state, and, for a project rule, that the rule applies to the file and the change breaks it. Prove runtime behavior with a run where an existing command, such as an affected test with crafted inputs, shows it without changing a file or shared state; for a PR, only when the current checkout is at `headRefOid`, else the finding is at most `traced`. Label each finding `ran`, `traced`, `located`, or `asserted` as [review-code.md — Behavior](../review-code/SKILL.md#behavior) defines them. Drop a candidate the check refutes; one it cannot settle is `asserted`.

## Blocking

A finding blocks when it has a location and evidence and is not `asserted`. Order blocking findings by class, then within a class by reach: a production path before others, then the more callers or users affected.

1. **Security:** a broken security boundary, such as missing authorization, injection, or a leaked secret.
2. **Data integrity:** data loss, corruption, or a race that leaves state inconsistent.
3. **Correctness:** a wrong result, a crash, or code that fails to build.
4. **Cost:** unbounded or repeated work on a production path.
5. **Project rule:** a rule from an applicable instruction file, quoted, that the change breaks, including a rule that governs style or wording.

Every other finding is a note.

## Report

Name the target with its base SHA, its head SHA, and, for a branch, whether it has uncommitted or untracked changes; for a PR, `baseRefOid` and `headRefOid` from `gh pr view <PR> --json baseRefOid,headRefOid`. List every blocking finding in the order above, none dropped or capped, each with its class, `file:line`, the defect in one sentence, the failure scenario as the input or state and the wrong result, its evidence, and its label. Then list the notes. When nothing blocks, say so and name the passes that ran. Return `PASS` when nothing blocks, else `NEEDS CHANGES`. The main agent counts rounds under plan.md — Review.
