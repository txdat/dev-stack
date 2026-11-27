// Builds the installable plugins: plugins/dev compiled to JavaScript, with its rules, skills,
// agents, and manifests copied beside the output. dist/dev serves Claude Code, Pi, and DSH;
// dist/dev-agy serves Antigravity with its native manifest, root hooks.json, and mapped frontmatter.
// It builds into a sibling directory and swaps it in only when every step succeeded, so a failed
// or running build never leaves a partial plugin at the output.
// Usage: node scripts/build.ts [--agy] [--out <dir>]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const SRC = path.join(ROOT, "plugins/dev");
const COMMON_COPY = [
  ".gitignore",
  "agents",
  "package.json",
  "opencode/package.json",
  "rules",
  "skills",
];
const CLAUDE_COPY = [".claude-plugin/plugin.json", "hooks/hooks.json"];
// The build writes this into its output; only a directory holding it is replaced.
const MARK = ".dev-stack-build";

const AGY_SWARM_RULE = "rules/agy-swarm.md";

/** Formats `role -> model` pairs grouped by model for `agy-swarm.md`. */
const formatRoleModels = (models: ReadonlyMap<string, string>): string => {
  const byModel = new Map<string, string[]>();
  for (const [role, model] of models) {
    const list = byModel.get(model);
    if (list) list.push(role);
    else byModel.set(model, [role]);
  }
  return [...byModel.entries()]
    .map(([model, roles]) => `${roles.map((r) => `\`${r}\``).join(", ")}: \`${model}\``)
    .join("; ");
};

/** Renders `agy-swarm.md` with resolved role models and `always_on` trigger for Antigravity. */
const renderAgySwarmRule = (rulePath: string, models: ReadonlyMap<string, string>): string =>
  `---\ntrigger: always_on\n---\n\n${fs
    .readFileSync(rulePath, "utf8")
    .replace("{{ROLE_MODELS}}", formatRoleModels(models))}`;

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
  Agent: ["invoke_subagent", "send_message", "manage_subagents"],
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

/** `text` without the Claude-only `model` and `effort` lines of its frontmatter. */
const stripClaudeOnly = (text: string): string => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  return end === -1
    ? text
    : text.slice(0, end + 1).replace(/^(?:model|effort):[^\n]*\n/gm, "") + text.slice(end + 1);
};

/** Antigravity's model for each Claude model alias; an agent's `effort` becomes its suffix. */
const AGY_MODELS: Record<string, string> = {
  haiku: "gemini-4-hydrogen",
  sonnet: "gemini-4-hydrogen",
  opus: "gemini-4-neon",
};

/** The Antigravity `model` for a frontmatter's Claude `model` and `effort`; undefined when unmapped. */
const agyModel = (text: string): string | undefined => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  const head = end === -1 ? "" : text.slice(0, end);
  const alias = head.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? "";
  const base = Object.hasOwn(AGY_MODELS, alias) ? AGY_MODELS[alias] : undefined;
  const effort = head.match(/^effort:\s*(\S+)\s*$/m)?.[1];
  return base && (effort ? `${base}-${effort}` : base);
};

/**
 * An agent file's frontmatter as Antigravity reads it: the `tools` grant list as native names,
 * Claude-only `model`/`effort` stripped (agy agent frontmatter accepts only tiers, not model IDs),
 * and the flags that keep it a subagent.
 */
const adaptAgent = (text: string): string => {
  const mapped = stripClaudeOnly(text).replace(/^tools:\s*(.+)$/m, (_line, list: string) => {
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

const adaptForAgy = (work: string): void => {
  const agentModels = new Map<string, string>();
  const agentsDir = path.join(work, "agents");
  for (const entry of fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(agentsDir, entry.name);
    const text = fs.readFileSync(file, "utf8");
    const model = agyModel(text);
    if (model !== undefined) agentModels.set(entry.name.slice(0, -".md".length), model);
    const next = adaptAgent(text);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const swarmRulePath = path.join(work, AGY_SWARM_RULE);
  fs.writeFileSync(swarmRulePath, renderAgySwarmRule(swarmRulePath, agentModels));

  const skillsDir = path.join(work, "skills");
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const next = stripClaudeOnly(text);
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
      fs.rmSync(path.join(work, AGY_SWARM_RULE), { force: true });
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
      process.stderr.write("usage: node scripts/build.ts [--agy] [--out <dir>]\n");
      return 2;
    }
  }
  if (out !== undefined) return buildOne(out, agy);
  if (agy) return buildOne(path.join(ROOT, "dist/dev-agy"), true);
  const rc = buildOne(path.join(ROOT, "dist/dev"), false);
  return rc !== 0 ? rc : buildOne(path.join(ROOT, "dist/dev-agy"), true);
};

process.exitCode = main(process.argv.slice(2));
