/**
 * The dev plugin's Pi extension: the rules in the system prompt, the phase gates, record guard,
 * and serial-test check, and the /dev-stack-* commands, calling core in-process.
 *
 * Pi has no Skill tool: it loads a skill by reading its SKILL.md, or expands a typed
 * `/skill:<name>` itself. So `tool_call` on `read` of `<root>/skills/<slug>/SKILL.md` and the
 * `input` event run the phase gate, which alone decides which slugs are gated. The plan path the
 * gate reads is the text of the assistant message that issued the read when it names a plan
 * (run-stack names each plan as it starts its phase), else the latest user message.
 *
 * Before a bash, edit, or write call the record guard runs, and for bash the serial-test check
 * first; after a bash call the post check compares the plans with the snapshot the guard took and
 * reports what it restored beside the call's output. A bash call that another handler blocked or
 * that was aborted skips `tool_result`, so `tool_execution_end` compares and clears its snapshot.
 *
 * Core works on byte strings (core/bytes.ts): the cwd, env, and argv go in through b(), and every
 * reason and output comes back through utf8(). A gated phase fails closed; the guard and the
 * serial-test check fail open with a warning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isBashToolResult,
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { b, utf8 } from "../core/bytes.ts";
import type { Env } from "../core/cli.ts";
import { type GateResult, gateCheck, isPhaseCall } from "../core/gate-check.ts";
import type { GateCtx, HookInput } from "../core/hook-input.ts";
import { serialCheck } from "../core/serial-check.ts";
import { devStack } from "../core/stack.ts";
import { tryMainRoot } from "../core/utils.ts";

type Message = { role?: string; content?: unknown };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = process.env["HOME"] ?? "";
const PLAN_MENTION = /pr\d+\.spec\.md/;
const RULES_MARK = "$DEV_LIB is ";

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const SKILLS = realpath(path.join(ROOT, "skills"));

/** The rules with $DEV_LIB, the plugin's install root, which they and the skills cite. */
const rules = (): string => {
  let text = `${RULES_MARK}${ROOT}: the dev plugin's install root. Run its CLIs as node $DEV_LIB/bin/<name>.ts.`;
  for (const name of ["CORE.md", "CODING.md"]) {
    const file = path.join(ROOT, "rules", name);
    try {
      text += `\n\nContents of ${file}:\n\n${fs.readFileSync(file, "utf8")}`;
    } catch (error) {
      text += `\n\n${file} could not be read (${String(error)}); read it with the read tool.`;
    }
  }
  return text;
};

const gateCtx = (cwd: string): GateCtx => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = v === undefined ? undefined : b(v);
  return { cwd: b(cwd), env: env as Env };
};

/** gateCheck with an error turned into a block on a phase call and a pass elsewhere. */
const check = (input: HookInput, cwd: string): GateResult | { error: string } => {
  try {
    return gateCheck(input, gateCtx(cwd));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (isPhaseCall(input))
      return {
        block: b(
          `gate-check failed (${why}) before reaching a verdict; this blocks rather than passing.`,
        ),
      };
    return { error: why };
  }
};

/** Mirror Pi's path resolution (`resolveToCwd`) for read, edit, and write, which it does not export. */
const resolveToCwd = (p: string, cwd: string): string => {
  let f = p.startsWith("@") ? p.slice(1) : p;
  if (f === "~") f = HOME;
  else if (f.startsWith("~/")) f = path.join(HOME, f.slice(2));
  else if (f.startsWith("file://")) {
    try {
      f = fileURLToPath(f);
    } catch {
      // Pi rejects this URL too, so the call fails ungated either way.
    }
  }
  return path.resolve(cwd, f);
};

/** The skill a read loads: `<slug>` for `<root>/skills/<slug>/SKILL.md`, else undefined. */
const skillOf = (file: string): string | undefined => {
  for (const form of new Set([file, realpath(file)])) {
    const rel = path.relative(SKILLS, form);
    const parts = rel.split(path.sep);
    if (!path.isAbsolute(rel) && parts.length === 2 && parts[0] !== ".." && parts[1] === "SKILL.md")
      return parts[0];
  }
  return undefined;
};

const textOf = (message: Message): string => {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
};

const issued = (message: Message, callId: string): boolean =>
  message.role === "assistant" &&
  Array.isArray(message.content) &&
  message.content.some((c) => c?.type === "toolCall" && c.id === callId);

/**
 * The proxy for the Skill tool's arguments: the text of the assistant message that issued call
 * `callId` when it names a plan, else the latest user message on the active branch.
 */
const skillArguments = (ctx: ExtensionContext, callId: string, last?: Message): string => {
  let issuer = last && issued(last, callId) ? last : undefined;
  let prompt = "";
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0 && !prompt; i--) {
    const e = branch[i];
    if (e?.type !== "message") continue;
    if (!issuer && issued(e.message, callId)) issuer = e.message;
    if (e.message.role === "user") prompt = textOf(e.message);
  }
  const said = issuer ? textOf(issuer) : "";
  return PLAN_MENTION.test(said) ? said : prompt;
};

/**
 * The Claude-shaped PreToolUse input for a bash, edit, or write call, or undefined for every other
 * tool. Pi's edit tool applies all of a call's edits, so it is the MultiEdit shape: the guard
 * judges the whole call.
 */
const guardInput = (event: ToolCallEvent, cwd: string): HookInput | undefined => {
  const base = { hook_event_name: "PreToolUse", tool_use_id: event.toolCallId };
  if (isToolCallEventType("bash", event))
    return { ...base, tool_name: "Bash", tool_input: { command: event.input.command } };
  if (isToolCallEventType("edit", event))
    return {
      ...base,
      tool_name: "Edit",
      tool_input: {
        file_path: resolveToCwd(event.input.path, cwd),
        edits: event.input.edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })),
      },
    };
  if (isToolCallEventType("write", event))
    return {
      ...base,
      tool_name: "Write",
      tool_input: { file_path: resolveToCwd(event.input.path, cwd), content: event.input.content },
    };
  return undefined;
};

// ── /dev-stack-* commands ──────────────────────────────────────────────

type Sub = "next" | "stack" | "check" | "review" | "stop" | "resume" | "reopen";
type Parsed = { argv: [sub: Sub, plan: string, ...rest: string[]] } | { usage: true };
type Command = {
  name: string;
  description: string;
  argumentHint: string;
  parse: (text: string) => Parsed;
  // Set for a write: what the model reads after it succeeds, so a later run-stack turn knows of
  // the user's decision.
  write?: { note: (argv: string[]) => string };
};

// Every plan path ends in .spec.md, so anything else, such as an unknown trailing flag, is a
// usage error. A plan path with spaces stays whole.
const isPlan = (text: string) => /\.spec\.md$/.test(text);
const PLAN_THEN_REST = /^(.*?\.spec\.md)(?:\s+(.*))?$/s;
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
 * Plan paths show relative to the main root's docs/plans, written absolute or under ~. The format
 * hint in "Plan must be <root>/<issue>_..." keeps its prefix: it names the repository's plans,
 * never a plan, so a path followed by <issue> is left whole. Outside a repository nothing is
 * shortened.
 */
const shorten = (text: string, root: string): string => {
  if (!root) return text;
  const forms = [root];
  if (HOME && root.startsWith(`${HOME}/`)) forms.push(`~${root.slice(HOME.length)}`);
  const prefix = new RegExp(`(?:${forms.map(escapeRegExp).join("|")})/(?![^\\s]*<issue>)`, "g");
  return text.replace(prefix, "");
};

// A plan typed as the output shows it is read back from the repository's docs/plans. A leading @
// is the prompt's file mention, not part of the path.
const absolute = (text: string, root: string) => {
  const file = text.replace(/^@/, "");
  return /^[/~]/.test(file) ? file : `${root}/${file}`;
};

const runCommand = (
  command: Command,
  args: string,
  cwd: string,
): { text: string; note?: string } => {
  const usage = `Usage: /${command.name} ${command.argumentHint}`;
  const parsed = command.parse(args);
  if ("usage" in parsed) return { text: usage };
  const main = tryMainRoot(b(cwd));
  const root = main === undefined ? "" : `${utf8(main)}/docs/plans`;
  const [sub, plan, ...rest] = parsed.argv;
  const argv = [sub, root ? absolute(plan, root) : plan, ...rest];
  try {
    const { env } = gateCtx(cwd);
    const ran = devStack({ argv: argv.map(b), env, cwd: b(cwd) });
    const out = utf8(ran.stdout).trimEnd();
    if (ran.code === 0) {
      const note = command.write?.note(argv);
      return { text: shorten(out, root) || "(no output)", ...(note ? { note } : {}) };
    }
    if (ran.code === 2) return { text: usage };
    // check prints its PASS/BLOCK report on stdout and exits 1; other failures use stderr.
    const err = [out, utf8(ran.stderr).trimEnd()].filter(Boolean).join("\n");
    const hint = /Plan must be|main working-tree root|pass the stack's root/.test(err)
      ? "\nRun it from the plan's repository; next, list, and check take the root plan (lowest pr<N>)."
      : "";
    return { text: shorten(err || `dev-stack.ts exited ${ran.code}`, root) + hint };
  } catch (error) {
    return { text: `dev-stack.ts failed: ${String((error as Error)?.message ?? error)}` };
  }
};

// ── extension ──────────────────────────────────────────────────────────

export default function devExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes(RULES_MARK + ROOT)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${rules()}` };
  });

  // Pi persists an assistant message at message_end; keep it in case a call runs before the
  // session lists it.
  let lastAssistant: Message | undefined;
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistant = event.message as Message;
  });

  // A typed /skill:<name> loads a phase without a read: the gate decides on the prompt, and a
  // blocked prompt never reaches the agent.
  pi.on("input", async (event, ctx) => {
    if (!/^\s*\/skill:/i.test(event.text)) return;
    const v = check({ hook_event_name: "UserPromptSubmit", prompt: event.text }, ctx.cwd);
    if (v !== undefined && "block" in v) {
      ctx.ui.notify(`[dev] ${utf8(v.block)}`, "error");
      return { action: "handled" };
    }
    if (v !== undefined && "error" in v)
      ctx.ui.notify(`[dev] the gate failed, ${event.text} loaded ungated: ${v.error}`, "warning");
    return;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("read", event)) {
      const slug = skillOf(resolveToCwd(event.input.path ?? "", ctx.cwd));
      if (slug === undefined) return;
      // A call another tool made has id "<parent id>/<n>"; the root is the model-issued call
      // recorded in the transcript.
      const callId = event.toolCallId.split("/")[0] ?? event.toolCallId;
      const v = check(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Skill",
          tool_input: { skill: slug, arguments: skillArguments(ctx, callId, lastAssistant) },
        },
        ctx.cwd,
      );
      if (v !== undefined && "block" in v) return { block: true, reason: `[dev] ${utf8(v.block)}` };
      return;
    }
    const input = guardInput(event, ctx.cwd);
    if (input === undefined) return;
    try {
      const serial = serialCheck(input);
      if (serial !== undefined) return { block: true, reason: `[dev] ${utf8(serial)}` };
    } catch (e) {
      ctx.ui.notify(
        `[dev] the serial-test check failed, bash ran unchecked: ${String(e)}`,
        "warning",
      );
    }
    const v = check(input, ctx.cwd);
    if (v !== undefined && "block" in v) return { block: true, reason: `[dev] ${utf8(v.block)}` };
    if (v !== undefined && "error" in v)
      ctx.ui.notify(
        `[dev] the record guard failed, ${event.toolName} ran unguarded: ${v.error}`,
        "warning",
      );
    return;
  });

  // Bash calls whose post check already ran at tool_result.
  const postChecked = new Set<string>();

  // After a bash call: the plans it changed are compared with the snapshot its tool_call took,
  // and anything only dev-stack.ts or the user may change is put back. The report joins the
  // call's own output, so the model learns what was restored.
  pi.on("tool_result", async (event, ctx) => {
    if (!isBashToolResult(event)) return;
    postChecked.add(event.toolCallId);
    const v = check(
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: event.toolCallId },
      ctx.cwd,
    );
    if (v !== undefined && "postBlock" in v) {
      const reason = `[dev] ${utf8(v.postBlock)}`;
      ctx.ui.notify(reason, "warning");
      return { content: [...event.content, { type: "text" as const, text: reason }] };
    }
    return;
  });

  // A call blocked by another tool_call handler, or aborted before it starts, skips tool_result,
  // and its snapshot still needs comparing and clearing: the report has no result to join, so it
  // goes to the user.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "bash" || postChecked.delete(event.toolCallId)) return;
    const v = check(
      { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: event.toolCallId },
      ctx.cwd,
    );
    if (v !== undefined && "postBlock" in v) ctx.ui.notify(`[dev] ${utf8(v.postBlock)}`, "warning");
  });

  // `next`, `list`, and `check` only read. `review`, `stop`, `resume`, and `reopen` record a
  // decision of the user's, so each waits for the turn to end: a running turn reads the plan and
  // the stack's log. Pi treats a submitted command as the user's own.
  for (const command of COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, ctx) => {
        if (command.write) await ctx.waitForIdle();
        const { text, note } = runCommand(command, args.trim(), ctx.cwd);
        // The output is shown in the transcript; the note only reaches the model.
        pi.sendMessage(
          { customType: "dev-stack", content: text, display: true },
          { triggerTurn: false },
        );
        if (note)
          pi.sendMessage(
            { customType: "dev-stack-note", content: note, display: false },
            { triggerTurn: false },
          );
      },
    });
  }
}
