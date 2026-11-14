# dev-stack

A plan-backed development workflow for Claude Code, Pi, and DeepSeek Harness (DSH): skills, subagents, phase gates, shared rules, and the `/dev-stack-*` commands. It ships as one package holding one plugin, `dev`, that each harness installs natively. The sources are TypeScript, type-checked with TypeScript 7 and linted with Biome; `npm run build` compiles them to JavaScript in `dist/dev/`, the plugin every harness loads.

## Install

| Harness | Install | Skills |
| ------- | ------- | ------ |
| Claude Code | `npm install && npm run build`, then `claude plugin marketplace add ~/work/dev-stack` and `/plugin install dev@dev-stack` | `/dev:<skill>` |
| Pi | `npm install && npm run build`, then `pi install ~/work/dev-stack` | `/dev:<skill>` (registered, so Pi lists it) or `/skill:<skill>` |
| DSH | `npm install && npm run build`, then install this checkout as a linked bundle: `plugin_manager` action `install_bundle` with the checkout's absolute path | `dev-<skill>`, as the session skill catalog shows |

`dist/` is not committed: rebuild after each change to `plugins/dev/`. Claude Code copies the plugin into its cache, so reinstall it through `/plugin` after a rebuild; Pi loads `dist/dev` in place, so `/reload` picks up a rebuild. For development, `CLAUDE_CODE_PLUGIN_DIRS=~/work/dev-stack/dist/dev claude` loads the built plugin from the checkout; restart the session after `npm run build`. DSH links the checkout, so it runs `dist/dev/dsh/index.js` in place; rebuild and restart the session after changing the plugin.

The plugin injects [CORE.md](plugins/dev/rules/CORE.md) and [CODING.md](plugins/dev/rules/CODING.md) into the context (Claude: a `prompt.context` block, which subagents also receive; Pi: `before_agent_start`; DSH: a `dev-stack:rules` system-prompt section) and defines `$DEV_LIB` there as the plugin's absolute install root. No `CLAUDE.md`, `AGENTS.md`, or `~/.dsh/AGENTS.md` pointer is needed.

DSH has no Skill tool arguments and no prompt-submit hook. A phase's plan is the one named by the assistant message that loaded the skill, else by the latest user message, and a gated phase typed as `/dev-<name>` ends the turn instead of loading ungated: enter a gated phase through the model, asking it to run the skill on the plan, so a refusal carries its reason.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one plugin, dev, from dist/dev
package.json                      the Pi package manifest (dist/dev), the DSH bundle manifest, dev tooling
cordis.patch.yml                  the DSH bundle patch: inserts the dev-stack Host plugin
locale/, icon.svg                 DSH display metadata and icon
plugins/dev/                      the plugin's sources; their build ships alone
  skills/<name>/SKILL.md          skills
  agents/<name>.md                subagents (Claude); Pi's main agent reads them directly
  rules/                          CORE.md, CODING.md, plan.md, frontend-design.md
  core/                           the workflow logic: plans, stacks, gates (Node, synchronous)
  bin/                            CLIs over core (`node $DEV_LIB/bin/<name>.js` once built); bin/hook.ts is the gate
  hooks/                          Claude Code plugin module (no Node): rules, and gates and commands
                                  that run bin/ through $.process.run; commands.ts, the rules text
                                  and /dev-stack-* commands the other adapters share
  pi/                             Pi extension: rules, gates, and commands, calling core in-process
  dsh/                            DSH Host plugin: rules, skills, commands, and gates, calling core in-process
scripts/build.ts                  compiles plugins/dev into dist/dev and copies its rules, skills, agents,
                                  and manifests beside the output
dist/dev/                         the built plugin every harness loads (gitignored)
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

[inspector](plugins/dev/agents/inspector.md) diagnoses bugs, [planner](plugins/dev/agents/planner.md) designs and revises plans, [reviewer](plugins/dev/agents/reviewer.md) reviews under [plan.md — Review](plugins/dev/rules/plan.md#review), and [executor](plugins/dev/agents/executor.md) implements. In Claude Code they are `dev:<name>`. DSH has no named plugin agents, so its skills hand these files' instructions to the `subagent` tool.
