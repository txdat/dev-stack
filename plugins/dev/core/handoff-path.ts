// Resolves a snapshot destination without writing or deleting a handoff
// (../skills/handoff/SKILL.md).

import { type Command, fail, guard, Output } from "./cli.ts";
import { git } from "./sys.ts";
import { tryMainRoot } from "./utils.ts";

const USAGE = [
  "Usage: handoff-path.ts [session-id]",
  "Prints <main root>/docs/handoff/<session-id>.md; writes nothing.",
  "Defaults to the harness session id, $CLAUDE_CODE_SESSION_ID or else $PI_SESSION_ID; an",
  "argument overrides it. Fails without an id, outside a Git repository, or when Git does not",
  "ignore docs/handoff there.",
].join("\n");

const validId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);

/** The harness session-id variables, in order of preference. */
const ID_VARS = ["CLAUDE_CODE_SESSION_ID", "PI_SESSION_ID"] as const;

export const handoffPath: Command = (ctx) => {
  const o = new Output();
  return guard(o, () => {
    const [first] = ctx.argv;
    if (first === "--help" || first === "-h") {
      o.out(`${USAGE}\n`);
      return o.done();
    }
    if (ctx.argv.length > 1) fail("Expected at most one session id.", 2);
    let id: string;
    if (first !== undefined) {
      id = first;
      if (!validId(id)) fail(`Invalid session id: ${id}`, 2);
    } else {
      const from = ID_VARS.find((name) => (ctx.env[name] ?? "") !== "");
      if (from === undefined)
        return fail(`No session id: supply one as an argument or set ${ID_VARS.join(" or ")}.`, 2);
      id = ctx.env[from] ?? "";
      if (!validId(id)) fail(`Invalid ${from}: ${id}`, 2);
    }
    // The main root, never a linked worktree: create-pr's cleanup removes those.
    const root = tryMainRoot(ctx.cwd, ctx.env);
    if (root === undefined) fail("Not in a Git repository: a handoff lives in its docs/handoff.");
    if (
      git(["check-ignore", "-q", "--no-index", "--", `docs/handoff/${id}.md`], {
        cwd: root,
        env: ctx.env,
      }).code !== 0
    )
      fail(
        `Git does not ignore docs/handoff in ${root}, so a handoff could be committed. Add /docs/handoff/ to the global excludes file (git config core.excludesFile) or to .git/info/exclude.`,
      );
    o.out(`${root}/docs/handoff/${id}.md\n`);
    return o.done();
  });
};
