# AGENTS.md

Guidance for AI agents working in this repository.

## What this repository is

The `dev` plugin for Claude Code and Pi: rules, skills, agents, gates, and helper CLIs for plan-backed development. [README.md](README.md) gives the layout and install. [CORE.md](plugins/dev/rules/CORE.md) is the global rules file the plugin injects, so it is already in your context. Don't restate it here or in other files.

Edits to this repository are direct edits, not plan-backed work. See [plan.md — Scope](plugins/dev/rules/plan.md#scope).

## Writing rules

- **Each policy has one owner.** Each file owns the policy it states. Other files link to it as `[file — Section](path#anchor)` instead of paraphrasing it. A copied rule drifts from its source. Before adding a rule, find the file that already owns that topic and edit it there.
- **Links resolve from the source file's directory.** Files under `plugins/dev/` ship alone in the harness cache, so their links must stay inside `plugins/dev/`.
- **Headings and paths are load-bearing.** Before renaming a heading, a file, or a `bin/` CLI, grep for links in `plugins/dev/` (agents cite anchors such as `CORE.md#work`) and for anchors and paths in `core/` block messages (they cite anchors such as `rules/plan.md#schema`).
- **Rules must be harness-neutral.** Claude Code and Pi both read these files. Phrase tool-specific steps the way existing files do: "where installed", "Without a Skill tool, read … with the file-read tool".
- **Style:** terse, declarative, and imperative, without filler or rigid templates. Word choice follows [Wording](#wording).
- **Skill files** start with frontmatter (`name`, `description`, and optional `model` and `effort`), then `# /<name> — <summary>`, and stay short. Agent files carry `name`, `description`, and `tools`.

## Wording

Pick words for what they commit the reader to. The existing rules use this vocabulary consistently; keep to it.

| Intent | Write | Example |
|---|---|---|
| Required action | A bare imperative | "Run the TC tests and affected tests yourself at the final tip." |
| Fact the reader relies on, or a mechanism | Present tense | "A gate blocks each phase until its entry status holds." |
| Required property of a result or artifact | `must` | "Assertions must tell the required result from a plausible wrong one." |
| Prohibition | `never`, followed by the alternative or the consequence | "Never invent authors…; missing identity or auth blocks the operation." |
| Who may act, or how far a rule reaches | `only`, with the actor named | "`approved` — the user only, from `ready`" |
| Permission that is otherwise withheld | `may` | "The reviewer may read, run tests, and inspect Git." |
| Consequence | A defined verb: `blocks`, `stops`, `never blocks`, `report` | "A failure stops that step and everything depending on it under …" |
| Example | `such as` | "Execution decides only details that are not design choices, such as names and internal structure." |

- Avoid soft or hedged words: `should`, `consider`, `try to`, `ideally`, `as needed`, `appropriate`, `if relevant`. Each leaves the reader to guess whether the rule applies. State the condition instead: "when X, do Y". The rule prose uses none of these, and `always` appears only once.
- Don't use emphasis to add force. The rules contain no `MUST`, `IMPORTANT`, or emphatic bold; bold marks list labels only. A rule that needs emphasis needs a clearer condition or consequence.
- Name the actor whenever more than one could act: "the user", "the main agent", "the reviewer", "autopilot". The passive voice hides who owns a step.
- Use one term per concept. Reuse the defined terms exactly: status names, `AC`/`TC`/`ST`/`PC`/`DD`, Base, Branch, PR target, worktree, scratch. Never use a synonym for variety; a reader takes a new word to mean a new thing.
- Be concrete. Give limits as numbers ("after two re-reviews", "three failed fix-and-verify attempts"). Write fields, statuses, paths, and commands in backticks, exactly as a script or gate reads them.
- Scope each rule by its trigger, not by an adjective. Write "before changing security, concurrency, … behavior", not "for important changes".

## Changing rules

Write rules in English only, whatever language the request uses.

1. **Tighten once.** After drafting, the main agent tightens the change once. It cuts hedges, filler, and restated policy without changing what the rule requires.
2. **Review.** A fresh agent that has not seen the conversation reviews the tightened change against this file. It returns findings marked as blocking or as notes.
3. **Fix and re-review.** The main agent fixes each blocking finding and does not tighten again. A fresh agent then re-reviews the fixes. Stop when no blocking finding remains or after the third review, counting the first, and report any blocking findings still open.

## Adding or renaming a skill or agent

1. The file: `plugins/dev/skills/<name>/SKILL.md` or `plugins/dev/agents/<name>.md`, its frontmatter `name` matching the folder or file name.
2. Its row in [README.md](README.md).
3. For a dev phase the gate must recognize, the phase list in `core/gate-check.ts` and its cases in `test/`.

## Code

All code is TypeScript that Node 24, Claude Code, and Pi run directly, without a build:

- Erasable syntax only (no enums, namespaces, or parameter properties), with explicit `.ts` import specifiers.
- `core/` holds the workflow logic and imports no Node module, so the Claude plugin module can run it in-process; its IO comes through an interface that `hooks/` implements over the engine's `$` and `node/` over Node. Biome's `noNodejsModules` and `tsconfig.engine.json` enforce this.
- Core functions never call `process.exit` or `chdir`, take the working directory as an argument, and keep no module-level cache. CLIs write with `process.stdout.write` and set `process.exitCode`.
- Plans are read as bytes (latin1) and matched with ASCII-only classes, never `\s` or locale-aware case folding, so hashes and parsing match the original bash under `LC_ALL=C`.
- The gate fails closed on a phase it gates; the record guard and the serial-test check fail open.

The gate reads plan header fields and IDs, never prose. A change to the plan schema, statuses, or stack rules in [plan.md](plugins/dev/rules/plan.md) needs matching changes in `core/` and `test/`.

Tests that need a repository build scratch Git repos under `/tmp`, whose `docs/plans` hold their plans, ignore those through each repo's `.git/info/exclude` with `GIT_CONFIG_GLOBAL=/dev/null`, and set `AI_WORKTREES_ROOT` so they never touch `~/work/wt`.

## Commands

```
npm run typecheck     # tsc 7 over tsconfig.engine.json and tsconfig.node.json
npm run lint          # biome check
npm run format        # biome check --write
npm test              # node --test, serial
npm run check         # all of the above
node --test --test-isolation=none test/<file>.test.ts   # one test file
```
