// The dev plugin's Claude Code module: the rules as a context block, the phase gates, record guard,
// and serial-test check on tool calls and typed skill commands, and the /dev-stack-* commands.
// The module has no Node, so it runs the core through bin/ CLIs under node: bin/hook.ts reads a
// Claude-shaped hook JSON on stdin and prints the verdict, as the old settings hooks did.

import type { EngineInterface as Engine, Register } from "claude-code";

type Sub = "next" | "stack" | "check" | "review" | "stop" | "resume" | "reopen";

type Parsed = { argv: [sub: Sub, plan: string, ...rest: string[]] } | { usage: true };

type Command = {
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

/** hook.ts's verdict: a refusal, a post-check report, or a pass; `error` when it could not run. */
type Verdict = { deny: string } | { report: string } | { error: string } | Record<string, never>;

// The person at the terminal or through Remote Control; plugins, the SDK, and agents are refused,
// since run-stack lets only the user resume or reopen a plan.
const USER_ORIGINS = new Set(["composer", "bridge"]);

const GUARDED = new Set(["Skill", "Bash", "Edit", "Write", "MultiEdit"]);

// The plugin shows plan paths relative to the repository's docs/plans (`short` below), so one
// without a leading / or ~ is read back from there. A leading @ is the prompt's file mention, not part of the path.
const absolute = (text: string, root: string) => {
  const path = text.replace(/^@/, "");
  return /^[/~]/.test(path) ? path : `${root}/${path}`;
};

// Every plan path ends in .spec.md, so anything else, such as an unknown trailing flag, is a usage
// error; matching up to it keeps a path with spaces whole.
const isPlan = (text: string) => /\.spec\.md$/.test(text);
const PLAN_THEN_REST = /^(.*?\.spec\.md)(?:\s+(.*))?$/s;

// The engine shows a plugin command's output after the plugin's name, so multi-line output starts
// on the next line: a table's header and the first row or tree root then align with the rest.
const ownLines = (text: string) => (text.includes("\n") ? `\n${text}` : text);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const planOnly =
  (sub: Sub) =>
  (text: string): Parsed =>
    isPlan(text) ? { argv: [sub, text] } : { usage: true };

const COMMANDS: Command[] = [
  {
    name: "dev-stack-next",
    description: "Show each plan's next action in a stack (dev-stack.ts next)",
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
    description: "List a stack's plans, parents first (dev-stack.ts stack)",
    argumentHint: "<root spec file>",
    parse: planOnly("stack"),
  },
  {
    name: "dev-stack-check",
    description:
      "Run the review-feature gate on every plan in a stack, minus the parent-approval and stop checks (dev-stack.ts check)",
    argumentHint: "<root spec file>",
    parse: planOnly("check"),
  },
  {
    name: "dev-stack-review",
    description: "Record a review-feature verdict on a plan (dev-stack.ts review)",
    argumentHint: "<spec file> ready|needs-changes",
    parse: (text) => {
      const [, plan, verdict] = text.match(/^(.*\S)\s+(ready|needs-changes)$/s) ?? [];
      return plan && verdict && isPlan(plan)
        ? { argv: ["review", plan, verdict] }
        : { usage: true };
    },
    write: {
      note: ([, plan, verdict]) =>
        `The user recorded the review-feature verdict ${verdict} on ${plan} with dev-stack.ts review.`,
    },
  },
  {
    name: "dev-stack-stop",
    description: "Record why a plan stopped in its stack's log (dev-stack.ts stop)",
    argumentHint: "<spec file> <reason>",
    parse: (text) => {
      const [, plan, reason] = text.match(PLAN_THEN_REST) ?? [];
      return plan && reason?.trim() ? { argv: ["stop", plan, reason.trim()] } : { usage: true };
    },
    write: {
      note: ([, plan, reason]) => `The user stopped ${plan} with dev-stack.ts stop: ${reason}`,
    },
  },
  {
    name: "dev-stack-resume",
    description:
      "Clear a plan's stop so run-stack continues it (dev-stack.ts resume; only the user runs it)",
    argumentHint: "<spec file>",
    parse: planOnly("resume"),
    write: {
      note: ([, plan]) =>
        `The user cleared the stop on ${plan} with dev-stack.ts resume; for a "Failed fixes" stop at its limit this raises the limit by three attempts, and for a review round limit three more rounds.`,
    },
  },
  {
    name: "dev-stack-reopen",
    description:
      "Return an approved plan, and every plan above it that is approved or later, to planning (dev-stack.ts reopen; only the user runs it)",
    argumentHint: "<spec file>",
    parse: planOnly("reopen"),
    write: {
      note: ([, plan]) =>
        `The user reopened ${plan} with dev-stack.ts reopen: it and every plan above it that was approved or later are back in planning, to revise and review again.`,
    },
  },
];

/**
 * Runs bin/hook.ts on one Claude-shaped hook input in the session's directory, a subagent's own in
 * its hooks, since the gate resolves the worktree and plans from there.
 */
const hook = async ($: Engine, input: Record<string, unknown>): Promise<Verdict> => {
  let out: string;
  try {
    const ran = await $.process.run(["node", `${$.plugin.root}/bin/hook.ts`], {
      cwd: await $.session.cwd(),
      stdin: JSON.stringify(input),
    });
    if (ran.exitCode !== 0) return { error: ran.stderr.trim() || `hook.ts exited ${ran.exitCode}` };
    out = ran.stdout.trim();
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) };
  }
  if (out === "") return {};
  try {
    const v = JSON.parse(out) as {
      continue?: boolean;
      decision?: string;
      reason?: string;
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    const denied = v.hookSpecificOutput?.permissionDecision === "deny";
    if (denied || v.continue === false)
      return {
        deny: v.hookSpecificOutput?.permissionDecisionReason ?? v.reason ?? "hook.ts blocked",
      };
    if (v.decision === "block") return { report: v.reason ?? "hook.ts restored a plan change" };
    return {};
  } catch {
    return { error: `unreadable output: ${out.slice(0, 200)}` };
  }
};

// hook.ts that cannot run passes the call with a visible warning, as a failed Claude Code hook does.
const warn = ($: Engine, what: string, error: string) =>
  $.ui.toast(`dev: hook.ts failed, ${what} ran unchecked: ${error}`, { timeoutMs: 8000 });

export const register: Register = (on) => {
  // The rules, with $DEV_LIB, the plugin's install root, which they and the skills cite. A context
  // block reaches subagents too.
  on("prompt.context", async ($, e, next) => {
    const ctx = await next(e);
    const root = $.plugin.root;
    let text = `$DEV_LIB is ${root}: the dev plugin's install root. Run its CLIs as node $DEV_LIB/bin/<name>.ts.`;
    for (const name of ["CORE.md", "CODING.md"]) {
      try {
        text += `\n\nContents of ${root}/rules/${name}:\n\n${await $.fs.read(`${root}/rules/${name}`)}`;
      } catch (error) {
        text += `\n\n${root}/rules/${name} could not be read (${String(error)}); read it with the file-read tool.`;
      }
    }
    return { ...ctx, blocks: [...ctx.blocks, { name: "devRules", text }] };
  });

  // Before a Skill, Bash, Edit, Write, or MultiEdit call: the phase gate, the record guard, and for
  // Bash the serial-test check. After a Bash call, run or not, the post check compares the plans
  // with the snapshot its pre check took and reports what it restored.
  on("tool.call", async ($, e, next) => {
    if (!GUARDED.has(e.tool)) return next(e);
    const {
      tool,
      tool_use_id,
      agentId: _agent,
      requestMeta: _meta,
      ...args
    } = e as typeof e & {
      agentId?: string;
      requestMeta?: unknown;
    };
    const pre = await hook($, {
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_use_id,
      tool_input: args,
    });
    if ("deny" in pre) return { deny: pre.deny };
    if ("error" in pre) warn($, tool, pre.error);
    if (tool !== "Bash") return next(e);
    let failed = true;
    let ran: Awaited<ReturnType<typeof next>> | undefined;
    try {
      ran = await next(e);
      failed = "deny" in ran && ran.deny !== undefined ? true : ran.isError === true;
    } finally {
      const post = await hook($, {
        hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
        tool_name: tool,
        tool_use_id,
        tool_input: args,
      });
      if ("report" in post) {
        if (ran !== undefined && ran.deny === undefined)
          ran = { ...ran, context: [...(ran.context ?? []), post.report] };
        else $.ui.toast(`dev: ${post.report}`, { timeoutMs: 8000 });
      } else if ("error" in post) warn($, "the Bash post check", post.error);
    }
    return ran;
  }).catch(($, e, next) => {
    warn($, e.tool, "the tool.call hook threw");
    return next(e);
  });

  // A typed /dev:<phase> loads its skill without the Skill tool, so the gate decides on the prompt.
  on("prompt.submit", async ($, e, next) => {
    const prompt = e.command ? `/${e.command.name} ${e.command.args}` : e.text;
    if (!/^\s*\//.test(prompt)) return next(e);
    const v = await hook($, { hook_event_name: "UserPromptSubmit", prompt });
    if ("deny" in v) return { drop: v.deny };
    if ("error" in v) warn($, prompt.trim().split(/\s/)[0] ?? "the prompt", v.error);
    return next(e);
  }).catch(($, e, next) => {
    warn($, "the prompt", "the prompt.submit hook threw");
    return next(e);
  });

  on("session.start", async ($, e, next) => {
    for (const c of COMMANDS) {
      await $.command.register({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        ...(c.write ? {} : { immediate: true as const }),
      });
    }
    return next(e);
  });

  // dev-stack.ts runs in the session's directory, which must be in the plan's repository.
  for (const c of COMMANDS) {
    on("command.run", { command: c.name }, async ($, e) => {
      const usage = `Usage: /${c.name} ${c.argumentHint}`;
      const parsed = c.parse(e.args.trim());
      if ("usage" in parsed) return { text: usage };
      if (c.write && !USER_ORIGINS.has(e.origin.kind)) {
        return {
          text: `/${c.name} changes the plan stack and runs only from the user's own input.`,
        };
      }

      const home = (await $.env.get("HOME")) ?? "";
      const bin = `${$.plugin.root}/bin`;
      const cwd = await $.session.cwd();
      // Plan paths show relative to the main root's docs/plans, as plan-lib.ts resolves it,
      // written absolute or under ~. The format hint in "Plan must be <root>/<issue>_..." keeps
      // its prefix: it names the repository's plans, never a plan, so a path followed by <issue>
      // is left whole. Outside a repository nothing is shortened, and dev-stack.ts says why.
      let root = "";
      try {
        const main = await $.process.run(["node", `${bin}/dev-utils.ts`, "main-root"], { cwd });
        if (main.exitCode === 0 && main.stdout.trim()) root = `${main.stdout.trim()}/docs/plans`;
      } catch {
        // Outside a repository: plan paths pass through as typed.
      }
      const forms = [
        root,
        home && root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : "",
      ];
      const prefix = new RegExp(
        `(?:${forms.filter(Boolean).map(escapeRegExp).join("|") || "(?!)"})/(?![^\\s]*<issue>)`,
        "g",
      );
      const short = (text: string) => text.replace(prefix, "");
      try {
        const [sub, plan, ...rest] = parsed.argv;
        const argv = [sub, root ? absolute(plan, root) : plan, ...rest];
        const ran = await $.process.run(["node", `${bin}/dev-stack.ts`, ...argv], {
          cwd,
          timeoutMs: 120_000,
        });
        const out = ran.stdout.trimEnd();
        if (ran.exitCode === 0) {
          return {
            text: ownLines(short(out) || "(no output)"),
            ...(c.write ? { context: [c.write.note(argv)] } : {}),
          };
        }
        if (ran.exitCode === 2) return { text: usage };

        // check prints its PASS/BLOCK report on stdout and exits 1; other failures use stderr.
        const err = [out, ran.stderr.trimEnd()].filter(Boolean).join("\n");
        // dev-stack.ts names only the plan format or the missing repository; say what it needs from the caller.
        const hint = /Plan must be|main working-tree root|pass the stack's root/.test(err)
          ? "\nRun it from the plan's repository; next, list, and check take the root plan (lowest pr<N>)."
          : "";
        return { text: ownLines(short(err || `dev-stack.ts exited ${ran.exitCode}`) + hint) };
      } catch (error) {
        return { text: `dev-stack.ts failed: ${String((error as Error)?.message ?? error)}` };
      }
    });
  }
};
