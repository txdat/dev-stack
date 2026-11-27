# dev-stack

`dev` is a plan-backed development workflow plugin for Claude Code, Pi, DeepSeek Harness (DSH), OpenCode, and Antigravity (`agy`): skills, subagents, phase gates, shared rules, and the `/dev-stack-*` commands. [plan.md](plugins/dev/rules/plan.md) owns the workflow; a gate blocks each phase until its entry status holds.

## Install

Requires Node 24 or later on `PATH`. Build first: `npm install && npm run build`, which writes `dist/dev/` (Claude Code, Pi, DSH, OpenCode) and `dist/dev-agy/` (Antigravity).

| Harness | Install | Skills |
| ------- | ------- | ------ |
| Claude Code | `claude plugin marketplace add ~/dev-stack`, then `/plugin install dev@dev-stack` | `/dev:<skill>` |
| Pi | `pi install ~/dev-stack` | `/dev:<skill>` or `/skill:<skill>` |
| DSH | `plugin_manager` action `install_bundle` with the checkout's absolute path (a linked bundle) | `dev-<skill>` |
| OpenCode | add `/absolute/path/dev-stack/dist/dev/opencode` to `plugins` in `opencode.json(c)` | `/dev-<skill>` command, or skill ID `dev-<skill>` |
| Antigravity (`agy`) | `agy plugin install ~/dev-stack/dist/dev-agy` | `<skill>` |

`dist/` is not committed: rebuild after each change to `plugins/dev/`. Claude Code and Antigravity copy the plugin on install, so reinstall after a rebuild (Claude Code: `/plugin`, or `CLAUDE_CODE_PLUGIN_DIRS=~/dev-stack/dist/dev claude` and restart; Antigravity: `agy plugin install ~/dev-stack/dist/dev-agy` and restart). Pi and OpenCode load the build in place (`/reload`); DSH does too (restart the session).

The plugin injects [CORE.md](plugins/dev/rules/CORE.md) and [CODING.md](plugins/dev/rules/CODING.md) and defines `$DEV_LIB` as its install root, so no `CLAUDE.md`, `AGENTS.md`, or `GEMINI.md` pointer is needed.

## Harness support

Compared with Claude Code. ✅ same as Claude Code, ⚠️ supported with a difference, ❌ not supported.

| Feature | Claude Code | Pi | DSH | OpenCode | Antigravity |
| ------- | ----------- | -- | --- | -------- | ----------- |
| Rules and `$DEV_LIB` injected | `prompt.context` block, subagents included | ✅ `before_agent_start` | ✅ system-prompt section | ✅ `context` session hook | ✅ `SessionStart` |
| Phase gate on a model's skill load | Skill tool; plan from its argument | ⚠️ read of `SKILL.md`; plan from the message | ⚠️ `skill` tool; plan from the message | ⚠️ `skill` tool; plan from the message | ⚠️ `read_file` of `SKILL.md`; plan from the message |
| Phase gate on a typed skill | `/dev:<skill>` | ✅ `/dev:<skill>`, `/skill:<skill>` | ❌ a typed gated `/dev-<skill>` ends the turn | ✅ `/dev-<skill>`, `@dev-<skill>` | ❌ no prompt gate; gated only at the `SKILL.md` read |
| Record guard and serial-test check | Bash, Edit, Write, MultiEdit | ✅ bash, edit, write | ✅ bash, edit, write | ⚠️ shell, edit, write; `patch` refused under `docs/plans`, `docs/runbook`, `docs/architecture` | ✅ `run_command`, `edit_file`, `write_file` |
| Restored-plan report after a shell call | on the call | ✅ | ✅ | ✅ | ⚠️ at the end of the turn |
| `/dev-stack-*` commands | ✅; writes only from the terminal or Remote Control | ✅ | ✅ | ✅ | ✅ |
| Named agents | `dev:<name>` | ❌ none; without subagents, skills run each step in the main session | ⚠️ `subagent` tool given the agent file | ⚠️ `subagent` tool given the agent file | ⚠️ native subagents, started with `swarm` |
| Skill `model` and `effort` frontmatter | `model` for a typed `/dev:<skill>` only; `effort` for the rest of the turn | ❌ ignored | ❌ ignored | ❌ ignored | ❌ stripped |
| Agent `model` and `effort` frontmatter | the agent's default when a call passes none | ❌ no agents | ❌ not passed to `subagent` | ❌ not passed to `subagent` | ⚠️ stripped from agent frontmatter (`agy` accepts only tiers there); mapped to Gemini 4 models (`opus` to `gemini-4-neon`, `sonnet` and `haiku` to `gemini-4-hydrogen`, suffixed with `-<effort>`) in `swarm` delegation |

Where the plan comes from the message, enter a gated phase by asking the model to run the skill on the plan, so a refusal carries its reason.

## Skills

| Need | Skill |
|---|---|
| Understand existing code | [explore](plugins/dev/skills/explore/SKILL.md) |
| Plan application work | [design-feature](plugins/dev/skills/design-feature/SKILL.md) |
| Review a plan before approval | [review-feature](plugins/dev/skills/review-feature/SKILL.md) |
| Implement an approved or auto-approved plan | [execute-feature](plugins/dev/skills/execute-feature/SKILL.md) |
| Review implemented work | [review-code](plugins/dev/skills/review-code/SKILL.md) |
| Review a direct edit before its PR, or an open PR | [review-change](plugins/dev/skills/review-change/SKILL.md) |
| Publish reviewed PRs | [create-pr](plugins/dev/skills/create-pr/SKILL.md) |
| Split a PR into atomic PRs, on request only | [split-pr-atomic](plugins/dev/skills/split-pr-atomic/SKILL.md) |
| Drive a stack through its phases | [run-stack](plugins/dev/skills/run-stack/SKILL.md) |
| Run the whole flow from an issue or requirement, auto-approving | [autopilot](plugins/dev/skills/autopilot/SKILL.md) |
| Diagnose a bug and route its fix | [fix-bug](plugins/dev/skills/fix-bug/SKILL.md) |
| Design/review system boundaries | [design-system](plugins/dev/skills/design-system/SKILL.md), [review-system](plugins/dev/skills/review-system/SKILL.md) |
| Design/review an infrastructure runbook | [design-infra](plugins/dev/skills/design-infra/SKILL.md), [review-infra](plugins/dev/skills/review-infra/SKILL.md) |
| Capture a standalone issue | [create-issue](plugins/dev/skills/create-issue/SKILL.md) |
| Extract session lessons | [recap](plugins/dev/skills/recap/SKILL.md) |
| Write or read a session handoff | [handoff](plugins/dev/skills/handoff/SKILL.md) |

## Agents

`dev:<name>` in Claude Code. DSH and OpenCode skills hand these files to the `subagent` tool.

| Need | Agent |
|---|---|
| Implement a plan or an assigned chunk | [executor](plugins/dev/agents/executor.md) |
| Diagnose a bug | [inspector](plugins/dev/agents/inspector.md) |
| Design or revise plans and design documents | [planner](plugins/dev/agents/planner.md) |
| Review a plan or design document (review-feature, review-system, review-infra) | [plan-reviewer](plugins/dev/agents/plan-reviewer.md) |
| Review code (review-code, review-change) | [code-reviewer](plugins/dev/agents/code-reviewer.md) |

## Layout

```
plugins/dev/          the plugin's sources; their build ships alone
  skills/, agents/    skills and subagents
  rules/              CORE.md, CODING.md, plan.md, artifact.md, documents.md, frontend-design.md
  core/               workflow logic: plans, stacks, gates
  bin/                CLIs over core; hook.ts and agy-hook.ts are the gates
  hooks/              Claude Code plugin module (no Node)
  pi/, dsh/, opencode/, agy/   the other harness adapters
scripts/build.ts      builds dist/dev and dist/dev-agy
test/                 node --test suites
```

[AGENTS.md](AGENTS.md) owns the conventions and the `npm run` commands; `npm run check` runs them all.
