---
name: run-stack
description: "Drive a stack of plans, or one plan, through the design loop (review-feature and revise until ready), the execute loop (execute-feature, review-code, and repair until reviewed), and create-pr in dependency order, then report the PRs and what needs the user."
model: opus
effort: medium
---

# /run-stack — Drive a Stack to Publication

Take a stack ([plan.md — Stacks](../../rules/plan.md#stacks)), or one plan, through review-feature, execute-feature, review-code, and create-pr, and stop where the user decides. Pass the root, then optionally `--auto-approve`. `node $DEV_LIB/bin/dev-stack.js next <root>` prints each plan's next action; a phase it names runnable has passed its gate. If `next` fails, report its error and stop.

The user invoking or asking for run-stack authorizes create-pr's pushes and pull requests, draft unless the user asks for ready. `--auto-approve`, passed only by [autopilot](../autopilot/SKILL.md), approves for the user: once the options pass, before step 1, run `dev-stack.js autopilot <root>`, and report its error and stop if it fails; at each `wait-user`, run `dev-stack.js approve <plan>` and rerun `next`; if `approve` fails, record its error as the plan's stop. An unknown or repeated option is reported before step 1, and nothing starts.

1. Run `dev-stack.js next <root>`.
2. Start every runnable phase, each in its own subagent except create-pr, and run here each `merge-forward` `next` names; where a named agent is not installed, the general-purpose agent gets its md file as its instructions. This session is the main agent for every plan:
   - **review-feature:** the stack's reviewer under [artifact.md — Review](../../rules/artifact.md#review), with the paths of the plans below it. Record its verdict with `dev-stack.js review <plan> ready|needs-changes`.
   - **revise:** `next` names it after a needs-changes verdict, or on a plan back in `planning` with its ready review still holding, such as after a reopen. The stack's planner, one [planner](../../agents/planner.md) where installed, kept for every revision in the stack the way artifact.md — Review keeps its reviewer, on the model and effort in design-feature's frontmatter, revises the plan under [design-feature.md — Revise](../design-feature/SKILL.md#7-revise-after-review). Give it the review's or stop's findings and the user's answers, labeled as the user's; under `--auto-approve`, also the main agent's choices, labeled as autopilot's, and the statement that it decides for the user under [autopilot.md — Decisions](../autopilot/SKILL.md#decisions). If the findings are lost, run review-feature again to get them. A finding that needs a decision stops the plan, except under `--auto-approve`, where the planner takes it under autopilot.md — Decisions unless that section stops it. For a reshape the planner returns, run its `renumber` or `drop`, resume the planner, then rerun `next`.
   - **execute-feature:** this session first creates the plan's worktree under [plan.md — Worktree](../../rules/plan.md#worktree) when it has none. A subagent, [executor](../../agents/executor.md) where installed, on the model and effort in the skill's frontmatter, then invokes `execute-feature <plan>` in that worktree, with its Branch commits delegated, and returns without starting review-code.
   - **review-code:** the plan's review-code reviewer under artifact.md — Review, with its review-code inputs and round scratch ([plan.md — Review rounds](../../rules/plan.md#review-rounds)). Finalize each round under [review-code.md — Finalize](../review-code/SKILL.md#finalize), which records the verdict. On a pass, end the round; otherwise follow plan.md — Review rounds for the round's scratches, then repair in the plan's worktree, verify the repair under plan.md — Review rounds, and re-review. Code repairs go to an executor chunk, with the plan's worktree's absolute path, the files they touch, each as its absolute path under it, that verification with its `-fix` scratch, and Branch commits delegated; a repair to the plan's tests stays here.
   - **merge-forward:** after a fix to a plan's Branch, and on each plan `next` names `merge-forward`, merge forward here under plan.md — Worktree.
   - **create-pr:** `next` names it on the root once every plan is `reviewed`. Invoke `create-pr <root>` here and follow [create-pr.md](../create-pr/SKILL.md) through cleanup. CI follows [CORE.md — Work](../../rules/CORE.md#work).

   Invoke each phase skill with the Skill tool, `<phase> <plan path>`, so its gate checks the plan. Without a Skill tool, read `../<phase>/SKILL.md` with the file-read tool, never a shell command, in a message that says `Starting <phase> on <plan path>` and names no other plan. Without subagents, run the phases one at a time here, reviewing directly and saying so.
3. As each subagent or merge forward returns, finish its step, rerun `next`, and start what became runnable. Never poll; the run ends when nothing is running and step 2 has nothing to start.
4. Report the tree from `dev-stack.js next <root> --tree` in a text block, or the table from `--md` when the user asks for one, then group the plans as: for the user, blocked with the reason, waiting on a parent, and done. List under "for the user" each approval to give, each decision with options and a recommendation, and each stopped plan with its reason, any round such as `3/3`, its open blocking findings, and how it continues under [Continue after a stop](#continue-after-a-stop), with the exact command and full plan path. After create-pr, also list each PR's URL, draft or ready; under `--auto-approve`, each auto-approved plan.

## Continue after a stop

The user continues a stopped plan in one of three ways, then the main agent reruns run-stack on the root.

- **Answer a decision on an unapproved plan** in the conversation: the main agent runs revise on the plan with the answers, labeled as the user's. Revise is not gated, and the revision changes the spec, which ends an ordinary stop; `next` then names review-feature.
- **Reopen an approved plan:** the user runs `dev-stack.js reopen <plan>` and answers what the revision needs; `next` then names revise.
- **Grant more rounds or fix attempts, or retry with nothing to change:** the user runs `dev-stack.js resume <plan>`.

A held stop ends only through `resume` or `reopen`, so a revision under one also needs the user's `resume`.

## Stops

A plan stops when a needs-changes verdict lands at or past its round limit ([plan.md — Review rounds](../../rules/plan.md#review-rounds)), which `dev-stack.js review` and `code-review` record themselves; when its fixes reach their limit under [CORE.md — Work](../../rules/CORE.md#work); when [plan.md — Changes](../../rules/plan.md#changes) stops its work (a change in the third column of that section's table records no stop on an approved plan); or when a phase or merge forward started on it returns without changing its next action. A revise that returns a reshape is not a stop. Record any stop other than a round limit at once with `dev-stack.js stop <plan> "<reason>"`, including any `Failed fixes: <n>/<limit>`; the record goes to the stack's `log`, not the plan.

`next` then shows the plan `stopped`, and its gates block every gated phase on it. An ordinary stop ends when the plan's status (a review verdict does not count), its spec or a spec below it, or its Branch's tip changes, or with the user's `resume`; reverting the change restores the stop. A held stop — a round limit, or one citing `Failed fixes` at its limit, such as `3/3` — holds through changes and later stops until the user's `resume` or `reopen`. Only the user runs `resume` and `reopen`. The rest of the stack continues.
