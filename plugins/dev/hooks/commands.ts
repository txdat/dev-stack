// What the Claude Code module and the Pi extension share: the gated phases, the rules text, and the
// /dev-stack-* commands' table, parsing, and output shaping. No Node and no engine API: each adapter supplies
// its own IO, so the engine module, the Pi extension, and bin/dev-stack-command.ts import it alike.

type Sub = "next" | "stack" | "check" | "review" | "stop" | "resume" | "reopen";

export type Parsed = { argv: [sub: Sub, plan: string, ...rest: string[]] } | { usage: true };

export type Command = {
  name: string;
  description: string;
  argumentHint: string;
  parse: (text: string) => Parsed;
  // A write changes the plan or the stack's log. It runs only from the user's own input, and
  // tells the model with `note`, so a later run-stack turn knows of it. It waits for the turn to end,
  // since a running turn reads those files; a read runs mid-turn, to show progress while run-stack
  // works.
  write?: { note: (argv: string[]) => string };
};

/** What a command prints, and for a write the note the model reads. */
export type CommandResult = { text: string; note?: string };

/** dev-stack.ts's exit code and output, as UTF-8 text. */
export type StackRun = { code: number; stdout: string; stderr: string };

/** The phases the gate checks before they load (core/gate-check.ts). */
export const GATED_PHASES: readonly string[] = [
  "review-feature",
  "execute-feature",
  "review-code",
  "create-pr",
];

/**
 * Whether a Skill call's input could name a gated phase: it holds a phase's name, in any case and
 * with `_` for `-`. A call that cannot is passed without running the gate.
 */
export const mayNamePhase = (input: unknown): boolean => {
  const text = JSON.stringify(input ?? null).replace(/_/g, "-");
  return GATED_PHASES.some((p) => new RegExp(p, "i").test(text));
};

// ── rules ──────────────────────────────────────────────────────────────

/** How the rules text starts; an adapter that sees it already in the prompt adds nothing. */
export const RULES_MARK = "$DEV_LIB is ";
export const RULE_FILES = ["CORE.md", "CODING.md"] as const;

/**
 * The rules with $DEV_LIB, the plugin's install root, which they and the skills cite. `contents`
 * holds each of RULE_FILES' text, or the error that kept it from being read; `readTool` names the
 * harness's file-read tool.
 */
export const rulesText = (
  root: string,
  contents: readonly (string | { error: string })[],
  readTool: string,
): string => {
  let text = `${RULES_MARK}${root}: the dev plugin's install root. Run its CLIs as node $DEV_LIB/bin/<name>.js.`;
  RULE_FILES.forEach((name, i) => {
    const file = `${root}/rules/${name}`;
    const c = contents[i] ?? { error: "not read" };
    text +=
      typeof c === "string"
        ? `\n\nContents of ${file}:\n\n${c}`
        : `\n\n${file} could not be read (${c.error}); read it with ${readTool}.`;
  });
  return text;
};

// ── /dev-stack-* commands ──────────────────────────────────────────────

// Every plan path ends in .spec.md, so anything else, such as an unknown trailing flag, is a usage
// error; matching up to it keeps a path with spaces whole.
const isPlan = (text: string) => /\.spec\.md$/.test(text);
const PLAN_THEN_REST = /^(.*?\.spec\.md)(?:\s+(.*))?$/s;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const planOnly =
  (sub: Sub) =>
  (text: string): Parsed =>
    isPlan(text) ? { argv: [sub, text] } : { usage: true };

export const COMMANDS: readonly Command[] = [
  {
    name: "dev-stack-next",
    description: "Show each plan's next action in a stack (dev-stack.js next)",
    argumentHint: "<root spec file> [--tab|--tree|--md]",
    parse: (text) => {
      // A trailing view flag; dev-stack.ts defaults to --tab, its tab-separated rows.
      const VIEW = /(?:^|\s)(--tab|--tree|--md)$/;
      const view = text.match(VIEW)?.[1];
      const spec = text.replace(VIEW, "").trim();
      if (!isPlan(spec)) return { usage: true };
      return { argv: view ? ["next", spec, view] : ["next", spec] };
    },
  },
  {
    name: "dev-stack-list",
    description: "List a stack's plans, parents first (dev-stack.js stack)",
    argumentHint: "<root spec file>",
    parse: planOnly("stack"),
  },
  {
    name: "dev-stack-check",
    description:
      "Run the review-feature gate on every plan in a stack, minus the parent-approval and stop checks (dev-stack.js check)",
    argumentHint: "<root spec file>",
    parse: planOnly("check"),
  },
  {
    name: "dev-stack-review",
    description: "Record a review-feature verdict on a plan (dev-stack.js review)",
    argumentHint: "<spec file> ready|needs-changes",
    parse: (text) => {
      const [, plan, verdict] = text.match(/^(.*\S)\s+(ready|needs-changes)$/s) ?? [];
      return plan && verdict && isPlan(plan)
        ? { argv: ["review", plan, verdict] }
        : { usage: true };
    },
    write: {
      note: ([, plan, verdict]) =>
        `The user recorded the review-feature verdict ${verdict} on ${plan} with dev-stack.js review.`,
    },
  },
  {
    name: "dev-stack-stop",
    description: "Record why a plan stopped in its stack's log (dev-stack.js stop)",
    argumentHint: "<spec file> <reason>",
    parse: (text) => {
      const [, plan, reason] = text.match(PLAN_THEN_REST) ?? [];
      return plan && reason?.trim() ? { argv: ["stop", plan, reason.trim()] } : { usage: true };
    },
    write: {
      note: ([, plan, reason]) => `The user stopped ${plan} with dev-stack.js stop: ${reason}`,
    },
  },
  {
    name: "dev-stack-resume",
    description:
      "Clear a plan's stop so run-stack continues it (dev-stack.js resume; only the user runs it)",
    argumentHint: "<spec file>",
    parse: planOnly("resume"),
    write: {
      note: ([, plan]) =>
        `The user cleared the stop on ${plan} with dev-stack.js resume; for a "Failed fixes" stop at its limit this raises the limit by three attempts, and for a review round limit three more rounds.`,
    },
  },
  {
    name: "dev-stack-reopen",
    description:
      "Return an approved plan, and every plan above it that is approved or later, to planning (dev-stack.js reopen; only the user runs it)",
    argumentHint: "<spec file>",
    parse: planOnly("reopen"),
    write: {
      note: ([, plan]) =>
        `The user reopened ${plan} with dev-stack.js reopen: it and every plan above it that was approved or later are back in planning, to revise and review again.`,
    },
  },
];

export const usage = (command: Command): string =>
  `Usage: /${command.name} ${command.argumentHint}`;

// The output shows plan paths relative to the repository's docs/plans (`shorten`), so a bare
// relative path is read back from there. One under docs/plans/ is relative to the repository's root,
// and one under ./ or ../ to the caller's directory. A leading @ is the prompt's file mention, not
// part of the path.
const absolute = (text: string, plansRoot: string, cwd: string) => {
  const file = text.replace(/^@/, "");
  if (/^[/~]/.test(file)) return file;
  if (/^\.\.?\//.test(file)) return `${cwd}/${file}`;
  if (file.startsWith("docs/plans/")) return `${plansRoot.slice(0, -"docs/plans".length)}${file}`;
  return `${plansRoot}/${file}`;
};

/**
 * Plan paths show relative to the main root's docs/plans, written absolute or under ~. The format
 * hint in "Plan must be <root>/<issue>_..." keeps its prefix: it names the repository's plans,
 * never a plan, so a path followed by <issue> is left whole. Outside a repository nothing is
 * shortened.
 */
const shorten = (text: string, plansRoot: string, home: string): string => {
  if (!plansRoot) return text;
  const forms = [plansRoot];
  if (home && plansRoot.startsWith(`${home}/`)) forms.push(`~${plansRoot.slice(home.length)}`);
  const prefix = new RegExp(`(?:${forms.map(escapeRegExp).join("|")})/(?![^\\s]*<issue>)`, "g");
  return text.replace(prefix, "");
};

/**
 * Runs one command on its argument text. `plansRoot` gives the main root's docs/plans, or "" outside
 * a repository; `devStack` runs dev-stack.ts on an argv in `cwd`, the caller's directory.
 */
export const runCommand = (
  command: Command,
  args: string,
  io: {
    cwd: string;
    plansRoot: () => string;
    home: string;
    devStack: (argv: string[]) => StackRun;
  },
): CommandResult => {
  const parsed = command.parse(args.trim());
  if ("usage" in parsed) return { text: usage(command) };
  const root = io.plansRoot();
  const [sub, plan, ...rest] = parsed.argv;
  const argv = [sub, root ? absolute(plan, root, io.cwd) : plan, ...rest];
  try {
    const ran = io.devStack(argv);
    const out = ran.stdout.trimEnd();
    if (ran.code === 0) {
      const note = command.write?.note(argv);
      return {
        text: shorten(out, root, io.home) || "(no output)",
        ...(note === undefined ? {} : { note }),
      };
    }
    if (ran.code === 2) return { text: usage(command) };
    // check prints its PASS/BLOCK report on stdout and exits 1; other failures use stderr.
    const err = [out, ran.stderr.trimEnd()].filter(Boolean).join("\n");
    // dev-stack.ts names only the plan format or the missing repository; say what it needs from the caller.
    const hint = /Plan must be|main working-tree root|pass the stack's root/.test(err)
      ? "\nRun it from the plan's repository; next, list, and check take the root plan (lowest pr<N>)."
      : "";
    return { text: shorten(err || `dev-stack.js exited ${ran.code}`, root, io.home) + hint };
  } catch (error) {
    return { text: `dev-stack.js failed: ${String((error as Error)?.message ?? error)}` };
  }
};
