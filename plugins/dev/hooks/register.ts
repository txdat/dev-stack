// The dev plugin's Claude Code module: the rules as a context block, the phase gates, record guard,
// and serial-test check on tool calls and typed skill commands, and the /dev-stack-* commands.
// The module has no Node, so it runs the core through bin/ CLIs under node: bin/hook.ts reads a
// Claude-shaped hook JSON on stdin and prints the verdict, as the old settings hooks did, and
// bin/dev-stack-command.ts runs a command. commands.ts holds what the Pi extension shares.

import type { EngineInterface as Engine, Register } from "claude-code";
import { COMMANDS, mayNamePhase, RULE_FILES, rulesText, usage } from "./commands.ts";

/** hook.ts's verdict: a refusal, a post-check report, or a pass; `error` when it could not run. */
type Verdict = { deny: string } | { report: string } | { error: string } | Record<string, never>;

// The person at the terminal or through Remote Control; plugins, the SDK, and agents are refused,
// since run-stack lets only the user resume or reopen a plan.
const USER_ORIGINS = new Set(["composer", "bridge"]);

const HOOK_TIMEOUT_MS = 30_000;

const GUARDED = new Set(["Skill", "Bash", "Edit", "Write", "MultiEdit"]);

// The engine shows a plugin command's output after the plugin's name, so multi-line output starts
// on the next line: a table's header and the first row or tree root then align with the rest.
const ownLines = (text: string) => (text.includes("\n") ? `\n${text}` : text);

/**
 * Runs bin/hook.ts on one Claude-shaped hook input in the session's directory, a subagent's own in
 * its hooks, since the gate resolves the worktree and plans from there.
 */
const hook = async ($: Engine, input: Record<string, unknown>): Promise<Verdict> => {
  let out: string;
  try {
    // A run past the timeout rejects, so a hung gate passes the call with a warning.
    const ran = await $.process.run(["node", `${$.plugin.root}/bin/hook.ts`], {
      cwd: await $.session.cwd(),
      stdin: JSON.stringify(input),
      timeoutMs: HOOK_TIMEOUT_MS,
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
  // block reaches subagents too. The text is read once per install root; a failed read is retried.
  let rules: { root: string; text: string } | undefined;
  on("prompt.context", async ($, e, next) => {
    const ctx = await next(e);
    const root = $.plugin.root;
    if (rules?.root !== root) {
      let complete = true;
      const contents = await Promise.all(
        RULE_FILES.map((name) =>
          $.fs.read(`${root}/rules/${name}`).catch((error: unknown) => {
            complete = false;
            return { error: String(error) };
          }),
        ),
      );
      const text = rulesText(root, contents, "the file-read tool");
      if (!complete) return { ...ctx, blocks: [...ctx.blocks, { name: "devRules", text }] };
      rules = { root, text };
    }
    return { ...ctx, blocks: [...ctx.blocks, { name: "devRules", text: rules.text }] };
  });

  // A Bash call's pre and post checks share a snapshot keyed by its tool_use_id; a call without
  // one gets a key of its own, so its post check still compares.
  let untracked = 0;

  // Before a Skill, Bash, Edit, Write, or MultiEdit call: the phase gate, the record guard, and for
  // Bash the serial-test check. After a Bash call, run or not, the post check compares the plans
  // with the snapshot its pre check took and reports what it restored.
  on("tool.call", async ($, e, next) => {
    if (!GUARDED.has(e.tool)) return next(e);
    const {
      tool,
      tool_use_id: id,
      agentId: _agent,
      requestMeta: _meta,
      ...args
    } = e as typeof e & {
      agentId?: string;
      requestMeta?: unknown;
    };
    // Only a gated phase needs the gate; any other skill runs without starting node.
    if (tool === "Skill" && !mayNamePhase(args)) return next(e);
    const tool_use_id = id ?? `dev-${Date.now()}-${++untracked}`;
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
      if ("usage" in c.parse(e.args.trim())) return { text: usage(c) };
      if (c.write && !USER_ORIGINS.has(e.origin.kind)) {
        return {
          text: `/${c.name} changes the plan stack and runs only from the user's own input.`,
        };
      }
      try {
        const ran = await $.process.run(
          ["node", `${$.plugin.root}/bin/dev-stack-command.ts`, c.name, e.args],
          { cwd: await $.session.cwd(), timeoutMs: 120_000 },
        );
        if (ran.exitCode !== 0)
          return { text: `dev-stack.ts failed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
        const { text, note } = JSON.parse(ran.stdout) as { text: string; note?: string };
        return { text: ownLines(text), ...(note === undefined ? {} : { context: [note] }) };
      } catch (error) {
        return { text: `dev-stack.ts failed: ${String((error as Error)?.message ?? error)}` };
      }
    });
  }
};
