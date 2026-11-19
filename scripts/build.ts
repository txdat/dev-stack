// Builds the installable plugins: plugins/dev compiled to JavaScript, with its rules, skills,
// agents, and manifests copied beside the output. dist/dev serves Claude Code, Pi, and DSH;
// dist/dev-agy serves Antigravity with its native manifest, root hooks.json, and mapped frontmatter.
// It builds into a sibling directory and swaps it in only when every step succeeded, so a failed
// or running build never leaves a partial plugin at the output.
// Usage: bun scripts/build.ts [--agy] [--out <dir>]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const SRC = path.join(ROOT, "plugins/dev");
const COMMON_COPY = [".gitignore", "agents", "package.json", "rules", "skills"];
const CLAUDE_COPY = [".claude-plugin/plugin.json", "hooks/hooks.json"];
// The build writes this into its output; only a directory holding it is replaced.
const MARK = ".dev-stack-build";

const AGY_MODELS: Record<string, string> = {
  haiku: "gemini-4-hydrogen",
  sonnet: "gemini-4-hydrogen",
  opus: "gemini-4-neon",
};

const ORCHESTRATOR_SKILLS = new Set(["autopilot", "run-stack"]);

const AGY_SWARM_DELEGATION = `## Antigravity Delegation (\`swarm\` default)

Use \`swarm\` by default whenever this skill delegates to a subagent (\`planner\`, \`executor\`, \`reviewer\`, \`inspector\`); fall back to \`invoke_subagent\` only when \`swarm\` is unavailable or the user asks not to use it.

- Spawn each delegated role with \`swarm(action="add", name=<role-or-step>, model=<phase skill model>, workspace="inherit", brief=<...>)\`:
  - Pass the exact \`model:\` from the delegated phase skill's \`SKILL.md\` frontmatter (such as \`gemini-4-neon-medium\` for \`design-feature\`/\`review-feature\`, \`gemini-4-hydrogen-high\` for \`execute-feature\`/\`review-code\`/\`review-change\`).
  - Use \`workspace: "inherit"\` for all workers, since \`dev-worktree.js\` already isolates each plan or direct-edit branch in its own worktree under \`~/wt/\`; \`executor\` works directly in the worktree path the main agent passes.
  - A \`reviewer\` worker may start at most one level of child subagents (three levels in total from the main agent: main agent → \`reviewer\` → child); use \`invoke_subagent\` (not \`swarm\`) for those child passes and candidate verifiers so they stay isolated from the main swarm board, and tell each child subagent it must not start further subagents ([plan.md — Review](../../rules/plan.md#review)).
- Because \`swarm\` workers start fresh without conversation history, put the full handoff in \`brief\`: the agent file (\`$DEV_LIB/agents/<role>.md\`), the phase skill path (\`$DEV_LIB/skills/<phase>/SKILL.md\`), [CODING.md](../../rules/CODING.md) (\`$DEV_LIB/rules/CODING.md\`), inputs, exclusive files, delegated commits, off-limits actions, and expected return.
- Keep \`planner\` and \`reviewer\` workers alive across rounds (message them on the board instead of killing and re-adding them); \`kill\` workers only after their work lands or the run ends.`;

// Antigravity's native tool for each Claude Code grant, as its plugin import maps them. A grant with
// no native tool, such as Skill, is dropped: agy surfaces a skill as a read of its SKILL.md.
const AGY_TOOLS: Record<string, readonly string[]> = {
  Read: ["read_file"],
  Glob: ["read_file"],
  Grep: ["read_file"],
  Edit: ["edit_file"],
  MultiEdit: ["edit_file"],
  Write: ["write_file"],
  Bash: ["run_command", "manage_task"],
  Agent: ["invoke_subagent", "send_message", "manage_subagents", "swarm"],
  WebSearch: ["search_web"],
  WebFetch: ["search_web"],
};

/** The distinct native tools for a Claude Code `tools:` list, in AGY_TOOLS order. */
const agyTools = (list: string): string[] => {
  const tools: string[] = [];
  const grants = list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const grant of grants)
    for (const tool of AGY_TOOLS[grant] ?? []) if (!tools.includes(tool)) tools.push(tool);
  return tools;
};

/**
 * An agent file's frontmatter as Antigravity reads it: the `tools` grant list as native names, and
 * the flags that keep it a subagent.
 */
const adaptAgent = (text: string): string => {
  const mapped = text.replace(/^tools:\s*(.+)$/m, (_line, list: string) => {
    const tools = agyTools(list);
    return `tools:\n${tools.map((t) => `  - ${t}`).join("\n")}`;
  });
  if (/^subagent:/m.test(mapped)) return mapped;
  const end = mapped.indexOf("\n---", 4);
  return end === -1
    ? mapped
    : `${mapped.slice(0, end)}\nsubagent: true\nmainAgent: false${mapped.slice(end)}`;
};

/** Whether `p` is strictly inside `dir`. */
const inside = (p: string, dir: string) => {
  const r = path.relative(dir, p);
  return r !== "" && r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
};

/** `p` with its nearest existing ancestor resolved to its real path; the rest is joined back. */
const realish = (p: string): string => {
  const rest: string[] = [];
  let at = p;
  while (!fs.existsSync(at)) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(fs.realpathSync(at), ...rest);
};

/** The output's real path, or why the build refuses to replace it. */
const target = (arg: string): { out: string } | { refuse: string } => {
  const real = realish(path.resolve(arg));
  const dist = path.join(ROOT, "dist");
  if (real === ROOT || inside(ROOT, real) || (inside(real, ROOT) && !inside(real, dist)))
    return { refuse: `${real} is the checkout, above it, or in it outside dist/` };
  if (fs.existsSync(real)) {
    if (!fs.statSync(real).isDirectory()) return { refuse: `${real} is not a directory` };
    if (!fs.existsSync(path.join(real, MARK)) && fs.readdirSync(real).length > 0)
      return { refuse: `${real} is not empty and holds no earlier build` };
  }
  return { out: real };
};

/** Rewrites frontmatter in `work` for Antigravity: skill models, agent tool lists, rule triggers. */
const adaptSkill = (name: string, text: string): string => {
  const effort = text.match(/^effort:\s*(\S+)\s*$/m)?.[1];
  let next = text.replace(/^model:\s*(\S+)\s*$/m, (line, m: string) => {
    const base = AGY_MODELS[m];
    if (!base) return line;
    return `model: ${effort ? `${base}-${effort}` : base}`;
  });
  if (ORCHESTRATOR_SKILLS.has(name)) {
    next = next.replace(/^(# \/[^\n]+\n)/m, `$1\n${AGY_SWARM_DELEGATION}\n`);
  }
  return next;
};

const adaptForAgy = (work: string): void => {
  const skillsDir = path.join(work, "skills");
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const next = adaptSkill(entry.name, text);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const agentsDir = path.join(work, "agents");
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(agentsDir, entry.name);
    const text = fs.readFileSync(file, "utf8");
    const next = adaptAgent(text);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const rulesDir = path.join(work, "rules");
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(rulesDir, entry.name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith("---\n")) fs.writeFileSync(file, `---\ntrigger: manual\n---\n\n${text}`);
  }
};

const buildOne = (outArg: string, agy: boolean): number => {
  const t = target(outArg);
  if ("refuse" in t) {
    process.stderr.write(`build: refusing to replace ${t.refuse}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  const work = fs.mkdtempSync(`${t.out}.build-`);
  try {
    // tsc's own script under this runtime: node_modules/.bin/tsc names node in its shebang.
    const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
    const configs = agy
      ? ["tsconfig.build.json"]
      : ["tsconfig.build.json", "tsconfig.build-engine.json"];
    for (const config of configs) {
      const args = [tsc, "-p", path.join(ROOT, config), "--outDir", work];
      const ran = spawnSync(process.execPath, args, { stdio: "inherit" });
      if (ran.status !== 0) {
        process.stderr.write(
          `build: tsc -p ${config} failed${ran.error ? `: ${ran.error.message}` : ""}\n`,
        );
        return ran.status ?? 1;
      }
    }
    for (const rel of COMMON_COPY)
      fs.cpSync(path.join(SRC, rel), path.join(work, rel), { recursive: true });
    if (agy) {
      fs.cpSync(path.join(SRC, "plugin.json"), path.join(work, "plugin.json"));
      fs.cpSync(path.join(SRC, "agy/hooks.json"), path.join(work, "hooks.json"));
      adaptForAgy(work);
    } else {
      for (const rel of CLAUDE_COPY)
        fs.cpSync(path.join(SRC, rel), path.join(work, rel), { recursive: true });
    }
    fs.writeFileSync(path.join(work, MARK), "");
    // mkdtemp creates the directory 0700.
    fs.chmodSync(work, 0o755);
    fs.rmSync(t.out, { recursive: true, force: true });
    fs.renameSync(work, t.out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`built ${path.relative(process.cwd(), t.out) || "."}\n`);
  return 0;
};

const main = (args: string[]): number => {
  let agy = false;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agy") {
      agy = true;
    } else if (args[i] === "--out" && i + 1 < args.length) {
      out = args[++i];
    } else {
      process.stderr.write("usage: bun scripts/build.ts [--agy] [--out <dir>]\n");
      return 2;
    }
  }
  if (out !== undefined) return buildOne(out, agy);
  if (agy) return buildOne(path.join(ROOT, "dist/dev-agy"), true);
  const rc = buildOne(path.join(ROOT, "dist/dev"), false);
  return rc !== 0 ? rc : buildOne(path.join(ROOT, "dist/dev-agy"), true);
};

process.exitCode = main(process.argv.slice(2));
