# dev-stack

A plan-backed development workflow for Claude Code and Pi: skills, subagents, phase gates, shared rules, and the `/dev-stack-*` commands. It ships as one plugin, `dev`, that each harness installs natively. Everything is TypeScript run directly by Node 24 and the harnesses, type-checked with TypeScript 7 and linted with Biome.

## Install

| Harness | Install | Skills |
| ------- | ------- | ------ |
| Claude Code | `claude plugin marketplace add ~/work/dev-stack`, then `/plugin install dev@dev-stack` | `/dev:<skill>` |
| Pi | `pi install ~/work/dev-stack` | `/dev:<skill>` (an alias the extension rewrites) or `/skill:<skill>` |

For development, `CLAUDE_CODE_PLUGIN_DIRS=~/work/dev-stack/plugins/dev claude` loads the plugin from the checkout and reloads it on edit.

The plugin injects [CORE.md](plugins/dev/rules/CORE.md) and [CODING.md](plugins/dev/rules/CODING.md) into the context (Claude: a `prompt.context` block, which subagents also receive; Pi: `before_agent_start`) and defines `$DEV_LIB` there as the plugin's absolute install root. No `CLAUDE.md` or `AGENTS.md` symlink is needed.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one plugin, dev
package.json                      the Pi package manifest, dev tooling
plugins/dev/                      the plugin; self-contained, since Claude copies it into its cache
  skills/<name>/SKILL.md          skills
  agents/<name>.md                subagents (Claude); Pi's main agent reads them directly
  rules/                          CORE.md, CODING.md, plan.md, frontend-design.md
  core/                           the workflow logic: plans, stacks, gates (Node, synchronous)
  bin/                            CLIs over core (`node $DEV_LIB/bin/<name>.ts`); bin/hook.ts is the gate
  hooks/                          Claude Code plugin module (no Node): rules, and gates and commands
                                  that run bin/ through $.process.run
  pi/                             Pi extension: rules, gates, and commands, calling core in-process
test/                             node --test suites
```

## Skills

[plan.md](plugins/dev/rules/plan.md) is the shared contract for plan-backed delivery. Load only the current skill and what it links.

| Need | Skill |
|---|---|
| Understand existing code | [explore](plugins/dev/skills/explore/SKILL.md) |
| Plan application work | [design-feature](plugins/dev/skills/design-feature/SKILL.md) |
| Review a plan before approval | [review-feature](plugins/dev/skills/review-feature/SKILL.md) |
| Implement an approved or auto-approved plan | [execute-feature](plugins/dev/skills/execute-feature/SKILL.md) |
| Review implemented work | [review-code](plugins/dev/skills/review-code/SKILL.md) |
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

[frontend-design.md](plugins/dev/rules/frontend-design.md) holds UI guidance; [CODING.md](plugins/dev/rules/CODING.md) applies it to all UI work.

## Agents

[inspector](plugins/dev/agents/inspector.md) diagnoses bugs, [planner](plugins/dev/agents/planner.md) designs and revises plans, [reviewer](plugins/dev/agents/reviewer.md) reviews under [plan.md — Review](plugins/dev/rules/plan.md#review), and [executor](plugins/dev/agents/executor.md) implements. In Claude Code they are `dev:<name>`.
