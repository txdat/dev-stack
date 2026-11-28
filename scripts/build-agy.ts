// Builds dist/dev-agy, the plugin for Antigravity: the common build plus its native manifest, root
// hooks.json, mapped agent and skill frontmatter, and the agy-swarm rule rendered with each role's
// and each review skill's model.
// Usage: node scripts/build-agy.ts [--out <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { dropHarnessRules, formatRoles, main, SRC, stripClaudeOnly } from "./build-lib.ts";

const AGY_SWARM_RULE = "rules/agy-swarm.md";

/** Renders `agy-swarm.md` with the role and review models and `always_on` trigger for Antigravity. */
const renderAgySwarmRule = (
  rulePath: string,
  models: ReadonlyMap<string, string>,
  reviews: ReadonlyMap<string, string>,
): string =>
  `---\ntrigger: always_on\n---\n\n${fs
    .readFileSync(rulePath, "utf8")
    .replace("{{ROLE_MODELS}}", formatRoles(models))
    .replace("{{REVIEW_MODELS}}", formatRoles(reviews))}`;

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

/** Antigravity's model for each Claude model alias; an agent's `effort` becomes its suffix. */
const AGY_MODELS: Record<string, string> = {
  haiku: "gemini-4-hydrogen",
  sonnet: "gemini-4-hydrogen",
  opus: "gemini-4-neon",
  fable: "gemini-4-carbon",
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

  // A reviewer runs on its review skill's model (rules/artifact.md#review), read before stripping.
  const reviewModels = new Map<string, string>();
  const skillsDir = path.join(work, "skills");
  for (const entry of fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const model = entry.name.startsWith("review-") ? agyModel(text) : undefined;
    if (model !== undefined) reviewModels.set(entry.name, model);
    const next = stripClaudeOnly(text);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const swarmRulePath = path.join(work, AGY_SWARM_RULE);
  fs.writeFileSync(swarmRulePath, renderAgySwarmRule(swarmRulePath, agentModels, reviewModels));

  const rulesDir = path.join(work, "rules");
  for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(rulesDir, entry.name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith("---\n")) fs.writeFileSync(file, `---\ntrigger: manual\n---\n\n${text}`);
  }
};

main("build-agy.ts", "dev-agy", {
  configs: ["tsconfig.build.json"],
  finish: (work) => {
    fs.cpSync(path.join(SRC, "plugin.json"), path.join(work, "plugin.json"));
    fs.cpSync(path.join(SRC, "agy/hooks.json"), path.join(work, "hooks.json"));
    dropHarnessRules(work, "agy-swarm.md");
    adaptForAgy(work);
  },
});
