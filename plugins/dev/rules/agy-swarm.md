# Antigravity Delegation (`swarm` default)

Use `swarm` by default whenever delegating to a subagent (`planner`, `executor`, `plan-reviewer`, `code-reviewer`, `inspector`); fall back to `invoke_subagent` only when `swarm` is unavailable or the user asks not to use it.

- Spawn each delegated role with `swarm(action="add", name=<role-or-step>, model=<model>, workspace="inherit", brief=<...>)`:
  - Pass the role's model ({{ROLE_MODELS}}) unless the user asks for another; a `plan-reviewer` or `code-reviewer` gets its review skill's instead ({{REVIEW_MODELS}}), as [artifact.md — Review](artifact.md#review) requires.
  - Use `workspace: "inherit"` for all workers, since `dev-worktree.js` already isolates each plan or direct-edit branch in its own worktree under `~/wt/`; `executor` works directly in the worktree path the main agent passes.
  - A `plan-reviewer` or `code-reviewer` worker may start the child subagents [artifact.md — Review](artifact.md#review) allows with `swarm` (on its own model) or `invoke_subagent`. The main agent never messages or kills a worker a `plan-reviewer` or `code-reviewer` started; that worker manages it.
- Because `swarm` workers start fresh without conversation history, put the full handoff in `brief`: the agent file (`$DEV_LIB/agents/<role>.md`), the phase skill path (`$DEV_LIB/skills/<phase>/SKILL.md`), [CODING.md](CODING.md) (`$DEV_LIB/rules/CODING.md`), inputs, exclusive files, delegated commits, off-limits actions, expected return, and, for a `plan-reviewer` or `code-reviewer`, the child-subagent permission above.
- Keep `planner`, `plan-reviewer`, and `code-reviewer` workers alive across rounds (message them on the board instead of killing and re-adding them); `kill` workers only after their work lands or the run ends.
