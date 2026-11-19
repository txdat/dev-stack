# dev-stack

A plan-backed development workflow for Claude Code, Pi, DeepSeek Harness (DSH), and Antigravity (`agy`): skills, subagents, phase gates, shared rules, and the `/dev-stack-*` commands. It ships as one package holding one plugin, `dev`, that each harness installs natively. The sources are TypeScript, type-checked with TypeScript 7 and linted with Biome; `bun run build` compiles them to JavaScript in `dist/dev/` (Claude Code, Pi, DSH) and `dist/dev-agy/` (Antigravity).

## Install

Requires [Bun](https://bun.sh) 1.4 or later on `PATH`: the gates and CLIs run under `bun`. Pre-install `bun install && bun run build`

| Harness | Install | Skills |
| ------- | ------- | ------ |
| Claude Code | `claude plugin marketplace add ~/dev-stack` and `/plugin install dev@dev-stack` | `/dev:<skill>` |
| Pi | `pi install ~/dev-stack` | `/dev:<skill>` (registered, so Pi lists it) or `/skill:<skill>` |
| DSH | install this checkout as a linked bundle: `plugin_manager` action `install_bundle` with the checkout's absolute path | `dev-<skill>`, as the session skill catalog shows |
| Antigravity (`agy`) | `agy plugin install ~/dev-stack/dist/dev-agy` | `<skill>` (from the `dev` plugin) |

The marketplace also lists `typescript-lsp`, a Claude Code-only plugin that runs [vtsls](https://github.com/yioneko/vtsls) as the language server for `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` files. Install `vtsls` on `PATH` (`npm install -g @vtsls/language-server`), then `/plugin install typescript-lsp@dev-stack`. It is plain JSON, so it needs no build.

`dist/` is not committed: rebuild after each change to `plugins/dev/`. Claude Code copies the plugin into its cache, so reinstall it through `/plugin` after a rebuild; Pi loads `dist/dev` in place, so `/reload` picks up a rebuild. For development, `CLAUDE_CODE_PLUGIN_DIRS=~/dev-stack/dist/dev claude` loads the built plugin from the checkout; restart the session after `bun run build`. DSH links the checkout, so it runs `dist/dev/dsh/index.js` in place; rebuild and restart the session after changing the plugin.

The plugin injects [CORE.md](plugins/dev/rules/CORE.md) and [CODING.md](plugins/dev/rules/CODING.md) into the context (Claude: a `prompt.context` block, which subagents also receive; Pi: `before_agent_start`; DSH: a `dev-stack:rules` system-prompt section; Antigravity: `SessionStart` `injectSteps` via `bin/agy-hook.js`) and defines `$DEV_LIB` there as the plugin's absolute install root. No `CLAUDE.md`, `AGENTS.md`, `~/.dsh/AGENTS.md`, or `GEMINI.md` pointer is needed.

DSH has no Skill tool arguments and no prompt-submit hook. A phase's plan is the one named by the assistant message that loaded the skill, else by the latest user message, and a gated phase typed as `/dev-<name>` ends the turn instead of loading ungated: enter a gated phase through the model, asking it to run the skill on the plan, so a refusal carries its reason.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: dev, from dist/dev, and typescript-lsp
package.json                      the Pi package manifest (dist/dev), the DSH bundle manifest, dev tooling
cordis.patch.yml                  the DSH bundle patch: inserts the dev-stack Host plugin
locale/, icon.svg                 DSH display metadata and icon
plugins/typescript-lsp/           the Claude Code vtsls language-server plugin, shipped as is
plugins/dev/                      the plugin's sources; their build ships alone
  skills/<name>/SKILL.md          skills
  agents/<name>.md                subagents (Claude); Pi's main agent reads them directly
  rules/                          CORE.md, CODING.md, plan.md, frontend-design.md
  core/                           the workflow logic: plans, stacks, gates (Node APIs, synchronous)
  bin/                            CLIs over core (`bun --no-env-file --config=/dev/null $DEV_LIB/bin/<name>.js` once built); bin/hook.ts is the gate
  hooks/                          Claude Code plugin module (no Node): rules, and gates and commands
                                  that run bin/ through $.process.run; commands.ts, the rules text
                                  and /dev-stack-* commands the other adapters share
  pi/                             Pi extension: rules, gates, and commands, calling core in-process
  dsh/                            DSH Host plugin: rules, skills, commands, and gates, calling core in-process
scripts/build.ts                  compiles plugins/dev into dist/dev and copies its rules, skills, agents,
                                  and manifests beside the output
dist/dev/                         the built plugin every harness loads (gitignored)
test/                             bun test suites
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

[frontend-design.md](plugins/dev/rules/frontend-design.md) holds UI guidance; [CODING.md](plugins/dev/rules/CODING.md) applies it to all UI work.

## Agents

In Claude Code they are `dev:<name>`. DSH has no named plugin agents, so its skills hand these files' instructions to the `subagent` tool.

| Need | Agent |
|---|---|
| Implement a plan or an assigned chunk | [executor](plugins/dev/agents/executor.md) |
| Diagnose a bug | [inspector](plugins/dev/agents/inspector.md) |
| Design or revise plans and design documents | [planner](plugins/dev/agents/planner.md) |
| Review under [plan.md — Review](plugins/dev/rules/plan.md#review) | [reviewer](plugins/dev/agents/reviewer.md) |
