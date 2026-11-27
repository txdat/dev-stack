// Reads this install's skills for registration in OpenCode. A skill is `skills/<slug>/SKILL.md`
// with YAML frontmatter; OpenCode names it by its ID, `<prefix><slug>`, and loads the body without
// the frontmatter, resolving the skill's relative paths from the directory holding SKILL.md.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillInfo } from "./api.ts";

/** A skill to register, with the directory its relative resources resolve from. */
export type InstallSkill = {
  readonly slug: string;
  readonly info: SkillInfo;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** A SKILL.md's flat `description` field and the body after its frontmatter. */
const parse = (text: string): { description: string; body: string } => {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { description: "", body: text };
  const description = (/^description:[ \t]*(.*)$/m.exec(match[1] ?? "")?.[1] ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1");
  return { description, body: text.slice(match[0].length) };
};

/**
 * Every skill under `root`, named `<prefix><slug>`, sorted by slug. A directory without a readable
 * SKILL.md is skipped; a failed `readdir` means this install has no skills.
 */
export const readSkills = (root: string, prefix: string): InstallSkill[] => {
  const dir = path.join(root, "skills");
  let slugs: string[];
  try {
    slugs = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: InstallSkill[] = [];
  for (const slug of slugs) {
    const file = path.join(dir, slug, "SKILL.md");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { description, body } = parse(text);
    const id = `${prefix}${slug}`;
    found.push({
      slug,
      info: {
        id,
        name: id,
        description: description === "" ? `Run the dev skill ${slug}` : description,
        path: file,
        content: body.trimStart(),
      },
    });
  }
  return found;
};
