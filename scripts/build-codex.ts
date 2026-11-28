// Builds dist/dev-codex, the plugin for Codex: the common build plus its manifest
// (.codex-plugin/plugin.json), hooks/hooks.json, skill and agent frontmatter without the Claude-only
// lines, the codex-agents rule rendered with each role's and each review skill's Codex model and
// effort, and codex/agents/dev-<role>.toml, a Codex agent role per agent, which the user installs
// into Codex's agents directory, since a Codex plugin cannot ship agents.
// Usage: node scripts/build-codex.ts [--out <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { dropHarnessRules, formatRoles, main, SRC, stripClaudeOnly } from "./build-lib.ts";

const CODEX_RULE = "codex-agents.md";

/** The Codex model each Claude model tier maps to. */
const MODELS: Record<string, string> = {
  haiku: "gpt-6-luna",
  sonnet: "gpt-6.1-terra",
  opus: "gpt-6.2-sol",
  fable: "gpt-6.2-astra",
};

/** A frontmatter field's value; undefined when the file has none. */
const field = (text: string, name: string): string | undefined => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  if (end === -1) return undefined;
  return new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(text.slice(0, end))?.[1];
};

/** The frontmatter's `description`, unquoted; "" when it has none. */
const description = (text: string): string => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  const raw = end === -1 ? "" : (/^description:[ \t]*(.*)$/m.exec(text.slice(0, end))?.[1] ?? "");
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
};

/** A file's Codex model and effort from its frontmatter; the build fails on an unmapped model. */
const settings = (file: string): { model?: string; effort?: string } => {
  const text = fs.readFileSync(file, "utf8");
  const tier = field(text, "model");
  const model = tier === undefined ? undefined : MODELS[tier];
  if (tier !== undefined && model === undefined)
    throw new Error(`${file}: model ${tier} has no Codex model in build-codex.ts`);
  const effort = field(text, "effort");
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
};

/** `model` at `effort`, as the rule lists it. */
const label = (s: { model?: string; effort?: string }): string =>
  [s.model, s.effort].filter((v) => v !== undefined).join("` at `");

/**
 * A Codex agent role for `role`: its description, model, and effort, and instructions that load the
 * agent file, which stays the one source of the role's rules.
 */
const roleToml = (role: string, desc: string, s: { model?: string; effort?: string }): string =>
  [
    `name = ${JSON.stringify(`dev-${role}`)}`,
    `description = ${JSON.stringify(desc)}`,
    ...(s.model ? [`model = ${JSON.stringify(s.model)}`] : []),
    ...(s.effort ? [`model_reasoning_effort = ${JSON.stringify(s.effort)}`] : []),
    `developer_instructions = ${JSON.stringify(`You are the dev plugin's ${role}. Before anything else, read $DEV_LIB/agents/${role}.md with the shell tool and follow it; $DEV_LIB is given with the rules injected at your start.`)}`,
    "",
  ].join("\n");

/** Rewrites each of `files` through `adapt`. */
const rewrite = (files: string[], adapt: (text: string) => string): void => {
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const next = adapt(text);
    if (next !== text) fs.writeFileSync(file, next);
  }
};

const adaptForCodex = (work: string): void => {
  const agentsDir = path.join(work, "agents");
  const agents = fs
    .readdirSync(agentsDir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => path.join(agentsDir, n));
  const roles = new Map<string, string>();
  const roleDir = path.join(work, "codex/agents");
  fs.mkdirSync(roleDir, { recursive: true });
  for (const file of agents) {
    const role = path.basename(file, ".md");
    const s = settings(file);
    roles.set(role, label(s));
    const desc = description(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(path.join(roleDir, `dev-${role}.toml`), roleToml(role, desc, s));
  }
  rewrite(agents, stripClaudeOnly);

  const skillsDir = path.join(work, "skills");
  const skills = fs
    .readdirSync(skillsDir)
    .sort()
    .filter((n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md")));
  const reviews = new Map<string, string>();
  for (const name of skills.filter((n) => n.startsWith("review-")))
    reviews.set(name, label(settings(path.join(skillsDir, name, "SKILL.md"))));
  rewrite(
    skills.map((n) => path.join(skillsDir, n, "SKILL.md")),
    stripClaudeOnly,
  );

  const rule = path.join(work, "rules", CODEX_RULE);
  rewrite([rule], (text) =>
    text
      .replace("{{ROLE_SETTINGS}}", formatRoles(roles))
      .replace("{{REVIEW_SETTINGS}}", formatRoles(reviews)),
  );
};

main("build-codex.ts", "dev-codex", {
  configs: ["tsconfig.build.json"],
  finish: (work) => {
    fs.mkdirSync(path.join(work, ".codex-plugin"));
    fs.cpSync(path.join(SRC, "codex/plugin.json"), path.join(work, ".codex-plugin/plugin.json"));
    fs.mkdirSync(path.join(work, "hooks"), { recursive: true });
    fs.cpSync(path.join(SRC, "codex/hooks.json"), path.join(work, "hooks/hooks.json"));
    dropHarnessRules(work, CODEX_RULE);
    adaptForCodex(work);
  },
});
