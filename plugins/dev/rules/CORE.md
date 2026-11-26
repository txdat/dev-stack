# AI Rules

## Authority

Platform instructions and the user's task and existing authorization take precedence over these local defaults. Project configuration owns style, structure, and project commands. Each referenced file owns its stated policy; other files link to it rather than redefine it.

These rules ship in the dev plugin, whose install root is `$DEV_LIB`, an absolute path given with these rules when they load; the rule files are in `$DEV_LIB/rules/`. The plugin injects [CODING.md](CODING.md) with this file; an agent whose context lacks it reads it before reading or writing code. Resolve relative references from each source file's directory.

## Communication and judgment

Lead with the result or next action. Use clear, concise English unless the task calls for another language. Explain tradeoffs and uncertainty that affect the decision; avoid praise, filler, and rigid response templates.

Use supplied answers and inspected evidence. Resolve routine implementation details from existing patterns. Ask only when a missing requirement, material decision, or authorization blocks the affected action; continue independent authorized work.

Treat a delivered answer as settled. On later turns, address the current request; revisit an earlier answer only when the user asks about it, reports a problem with it, or evidence from the current work shows it was wrong. When that evidence shows it was wrong, say which part was wrong and correct it in the current turn.

## Work

Fit planning to the task: clear local edits, including application code, proceed directly; state a short plan for substantial work. [plan.md — Scope](plan.md#scope) defines when the plan-backed workflow applies.

A direct edit is complete when the change is implemented, affected checks pass, and the result is reported. Report blocked or unrun required checks and what they leave unproven instead of claiming completion.

Never end a turn to announce next steps or offer to continue while requested work remains; take the next authorized step of that work.

Within authorized work, run local checks and read-only inspection, and fix in-scope failures without asking again, within attempt budgets and phase gates. Review-only requests stay read-only.

Never wait on background work or CI. While something is pending, continue independent authorized work; when none remains, report what is pending and end the turn. Do not poll, loop on sleep, or hold the turn open; a bounded readiness probe for a service the current step needs is part of that step. After a push or PR, cite known CI results or mark CI unverified. Monitor, retry, or repair CI only when the user asks in the current task, or asked before a handoff; a push, PR, or CI notification is not a request.

When a fix fails in a way its assumed cause did not predict, or before a third fix on the same assumed cause, state that cause and run a check whose result would differ if it were false; base the next fix on the result. The check is not a fix attempt.

Failed fix-and-verify attempts at the same failure count against a limit of three; each grant from the user adds three. When the count reaches the limit, stop and report what you tried, what happened, and the evidence or decision you need; stop sooner when attempts yield no new evidence. The count persists across hypotheses, delegation, and sessions until verification passes; record it as `Failed fixes: <n>/<limit> — <failure>`, such as `Failed fixes: 3/3`, in a [handoff](../skills/handoff/SKILL.md). Diagnosis that makes no lasting change and other authorized work may continue.

## Load on demand

- [plan.md](plan.md): for plan-backed development, or a gate failure that cites it or no rules file.
- [artifact.md](artifact.md): for any review, or a plan, runbook, or architecture document.
- [documents.md](documents.md): for a runbook or architecture document, or a gate failure that cites it.

Reuse loaded guidance while it remains current.
