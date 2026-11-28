# Codex Delegation (`spawn_agent`)

Delegate each role (`planner`, `executor`, `plan-reviewer`, `code-reviewer`, `inspector`) to a subagent started with `spawn_agent`, which gets the agent file as its instructions.

- Spawn each role with `spawn_agent(task_name=<role-or-step>, agent_type="dev-<role>", fork_turns="none", model=<model>, reasoning_effort=<effort>, message=<...>)`:
  - Pass `agent_type` only when `spawn_agent` offers `dev-<role>`, a role the user links into Codex's agents directory from the build's `codex/agents/`; without it, the agent file in `message` carries the role.
  - Pass the role's model and effort ({{ROLE_SETTINGS}}) unless the user asks for others; a `plan-reviewer` or `code-reviewer` gets its review skill's instead ({{REVIEW_SETTINGS}}), as [artifact.md — Review](artifact.md#review) requires.
  - When `spawn_agent` refuses the model or the agent type, such as on an account without that model, spawn again without `model` and `agent_type`, and report the model the subagent ran on instead.
  - `fork_turns: "none"` starts the subagent without the conversation, as [artifact.md — Review](artifact.md#review) requires of a reviewer. The plugin injects `$DEV_LIB`, [CORE.md](CORE.md), and [CODING.md](CODING.md) into it at its start.
- Put the full handoff in `message`: the agent file (`$DEV_LIB/agents/<role>.md`) to read and follow, the phase skill path (`$DEV_LIB/skills/<phase>/SKILL.md`), inputs, exclusive files, delegated commits, off-limits actions, expected return, and, for a `plan-reviewer` or `code-reviewer`, the child-subagent permission below.
- A `plan-reviewer` or `code-reviewer` may start the child subagents artifact.md — Review allows with `spawn_agent`. The main agent never messages or interrupts a subagent a `plan-reviewer` or `code-reviewer` started; that reviewer manages it.
- Keep `planner`, `plan-reviewer`, and `code-reviewer` subagents across rounds: send each later round with `followup_task` instead of spawning a new one.
