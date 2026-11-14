// Reads this install's skills for registration in DSH. A skill is `skills/<slug>/SKILL.md` with
// YAML frontmatter; DSH names it `<prefix><slug>`, as the user's old `~/.dsh/skills` wrappers were
// named, so `/dev-autopilot` keeps working and the names cannot collide with another source's.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillRegistration } from "./api.ts";

/** A skill to register, with the directory its relative resources resolve from. */
export type InstallSkill = {
  readonly slug: string;
  readonly registration: SkillRegistration;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** The frontmatter's flat `key: value` fields and the body after it. */
export const splitFrontmatter = (text: string): { fields: Map<string, string>; body: string } => {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { fields: new Map(), body: text };
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (field === null) continue;
    const value = (field[2] ?? "").trim();
    fields.set(
      field[1] as string,
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
    );
  }
  return { fields, body: text.slice(match[0].length) };
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
    const { fields, body } = splitFrontmatter(text);
    const description = fields.get("description") ?? `Run the dev skill ${slug}`;
    const whenToUse = fields.get("whenToUse");
    found.push({
      slug,
      registration: {
        name: `${prefix}${slug}`,
        description,
        content: body.trimStart(),
        ...(whenToUse === undefined ? {} : { whenToUse }),
        path: file,
        resourceBase: { kind: "directory", path: path.dirname(file) },
      },
    });
  }
  return found;
};
