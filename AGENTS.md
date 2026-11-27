# AGENTS.md

Guidance for AI agents working in this repository.

## What this repository is

The `dev` plugin for Claude Code, Pi, DeepSeek Harness (DSH), OpenCode, and Antigravity: rules, skills, agents, gates, and helper CLIs for plan-backed development. [README.md](README.md) gives the layout and install. [CORE.md](plugins/dev/rules/CORE.md) is the global rules file the plugin injects, so it is already in your context. Don't restate it here or in other files.

Edits to this repository are direct edits, not plan-backed work. See [plan.md — Scope](plugins/dev/rules/plan.md#scope).

## Writing rules

- **Each policy has one owner.** Each file owns the policy it states. Other files link to it as `[file — Section](path#anchor)` instead of paraphrasing it. A copied rule drifts from its source. Before adding a rule, find the file that already owns that topic and edit it there.
- **Links resolve from the source file's directory.** Files under `plugins/dev/` ship as their build, `dist/dev/`, which loads without the rest of the checkout, so their links must resolve inside `dist/dev/`. There, CLIs and modules are `.js`: rules, skills, agents, manifests, and user-facing messages name `bin/<name>.js`, never the `.ts` source.
- **Headings and paths are load-bearing.** Before renaming a heading, a file, or a `bin/` CLI, grep for links in `plugins/dev/` (agents cite anchors such as `CORE.md#work`) and for anchors and paths in `core/` block messages (they cite anchors such as `rules/plan.md#schema`).
- **Rules must be harness-neutral.** Claude Code, Pi, DSH, OpenCode, and Antigravity read these files. Phrase tool-specific steps the way existing files do: "where installed", "Without a Skill tool, read … with the file-read tool", "where the harness has one".
- **Style:** terse, declarative, and imperative, without filler or rigid templates. Word choice follows [Wording](#wording).
- **Skill files** start with frontmatter (`name`, `description`, and optional `model` and `effort`), then `# /<name> — <summary>`, and stay short. Agent files carry `name`, `description`, `tools`, and optional `model` and `effort`.

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
2. **Check consistency.** When the change moves, splits, renames, or removes a section, file, term, or path, or changes a policy that another file links to, applies, or restates, the main agent reads every prose file whole: `README.md`, this file, the Markdown under `plugins/dev/rules/`, `plugins/dev/skills/`, and `plugins/dev/agents/`, and the skill text `scripts/build.ts` injects. Otherwise, when the change alters meaning or a heading, path, or term, it greps those files for each changed file's path, each changed section's anchor, and each term the change touches, and reads each matching file whole. It fixes, in any file, each inconsistency involving what the change touches, whether the change creates it or leaves it, such as a stale owner, path, or anchor, a term used for another concept, or two files stating different policy.
3. **Review.** A fresh agent that has not seen the conversation reviews the change, including step 2's fixes, against this file. It returns findings marked as blocking or as notes.
4. **Fix and re-review.** The main agent fixes each blocking finding, checks consistency again under step 2, and does not tighten again. A fresh agent then re-reviews the fixes. Stop when no blocking finding remains or after the third review, counting the first, and report any blocking findings still open.

## Adding or renaming a skill or agent

1. The file: `plugins/dev/skills/<name>/SKILL.md` or `plugins/dev/agents/<name>.md`, its frontmatter `name` matching the folder or file name.
2. Its row in [README.md](README.md).
3. For a dev phase the gate must recognize, the phase list in `core/gate-check.ts` and its cases in `test/`.

## Adding a harness

A harness is supported when its adapter runs the gates, injects `rules/`, and loads the skills and `/dev-stack-*` commands, and its driver passes all three lanes in [test/autopilot-e2e.test.ts](test/autopilot-e2e.test.ts).

1. The adapter, in `hooks/` for an engine that runs the plugin module itself, `bin/<harness>-hook.ts` for one that pipes hook JSON to a gate CLI, or a directory such as `pi/`, `dsh/`, or `opencode/` for one that imports `core/` directly. An adapter that reaches `core/` directly maps the harness's tool calls and typed prompts onto [hook-input.ts](plugins/dev/core/hook-input.ts); it never restates the gate's policy.
2. Its row in the [README.md](README.md) install table.
3. Its driver in [test/autopilot-e2e.test.ts](test/autopilot-e2e.test.ts): autopilot's direct-edit lane, autopilot's plan-backed lane, and run-stack's plan-backed lane.

## Code

All code is TypeScript; Node 24 runs the CLIs, the gate, the build, and the tests. `npm run build` (`scripts/build.ts`) compiles `plugins/dev/` to JavaScript in `dist/dev/` and copies its rules, skills, agents, and manifests beside it; the marketplace, the Pi package, and the DSH bundle load `dist/dev/`. Tests run the `.ts` sources under Node, and `test/dist.test.ts` checks a fresh build.

- Erasable syntax only (no enums, namespaces, or parameter properties), with explicit `.ts` import specifiers; the build rewrites them to `.js`.
- `core/` holds the workflow logic as synchronous code on Node's APIs (`node:*` modules), which Node and the Pi and DSH hosts provide. Pi's extension and the DSH Host plugin in `dsh/` import core directly. The Claude plugin module in `hooks/` runs in the engine without Node, so it reaches core by running `bin/` CLIs through `$.process.run`. Every caller of a `bin/` CLI, including that module, the Antigravity hooks, the rules, and the skills, runs it as [CODING.md — Tools](plugins/dev/rules/CODING.md#tools) requires; code takes the invocation from `NODE` in `hooks/commands.ts`. Biome's `noNodejsModules` and `tsconfig.engine.json` keep Node out of `hooks/`.
- Core functions never call `process.exit` or `chdir`, take the working directory as an argument, and keep no module-level cache. CLIs write with `process.stdout.write` and set `process.exitCode`.
- Plans are read as bytes (latin1) and matched with ASCII-only classes, never `\s` or locale-aware case folding, so hashes and parsing match the original bash under `LC_ALL=C`.
- The gate fails closed on a phase it gates; the record guard and the serial-test check fail open. `bin/hook.ts` catches every error: on a phase-gate event it denies, on a guard or serial-check event it passes. An adapter that cannot run it at all (node missing, timeout, unreadable output) passes the call with a visible warning, as a failed Claude Code hook does.
- Core writes byte strings (`core/bytes.ts`): files are read and written as latin1, and `git hash-object` gets bytes, never a UTF-8 re-encoding of them.

The gate reads plan header fields and IDs, never prose. A change to the plan schema, statuses, or stack rules in [plan.md](plugins/dev/rules/plan.md) needs matching changes in `core/` and `test/`.

Tests that need a repository build scratch Git repos under `/tmp`, whose `docs/plans` hold their plans, ignore those through each repo's `.git/info/exclude` with `GIT_CONFIG_GLOBAL=/dev/null`, and set `AI_WORKTREES_ROOT` so they never touch `~/wt`.

## Commands

```
npm install           # dev dependencies, from package-lock.json
npm run build         # compile plugins/dev into dist/dev
npm run typecheck     # tsc 7 over tsconfig.engine.json and tsconfig.node.json
npm run lint          # biome check
npm run format        # biome check --write
npm test              # node --test, serial
npm run test:engine   # plugins/dev/hooks/*.test.ts under `claude plugin test`, on a scratch build
npm run check         # typecheck, lint, test, test:engine, then build
node --test --test-isolation=none test/<file>.test.ts   # one test file
```
