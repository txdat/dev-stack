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
import { byteEnv } from "../core/cli.ts";
import { type GateResult, gateCheck, isPhaseCall } from "../core/gate-check.ts";
import type { GateCtx, HookInput } from "../core/hook-input.ts";
import { serialCheck } from "../core/serial-check.ts";
import { stackCommand } from "../core/stack-command.ts";
import { COMMANDS, RULE_FILES, RULES_MARK, rulesText } from "../hooks/commands.ts";

type Message = { role?: string; content?: unknown };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = process.env["HOME"] ?? "";
const PLAN_MENTION = /pr\d+\.spec\.md/;
// A plan as `<issue>_<slug>/pr<N>.spec.md`, the same plan however its path is written.
const PLAN_REF = /[^\s/]+\/pr\d+\.spec\.md/g;
// The custom session entry recording each skill the agent entered.
const PHASE_ENTRY = "dev-phase";

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const SKILLS = realpath(path.join(ROOT, "skills"));

/** The rules, read from this install. */
const rules = (): string =>
  rulesText(
    ROOT,
    RULE_FILES.map((name) => {
      try {
        return fs.readFileSync(path.join(ROOT, "rules", name), "utf8");
      } catch (error) {
        return { error: String(error) };
      }
    }),
    "the read tool",
  );

const gateCtx = (cwd: string): GateCtx => ({ cwd: b(cwd), env: byteEnv(process.env) });

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

type PhaseEntry = { skill: string; plans: string[] };

const plansIn = (text: string): string[] => [...new Set(text.match(PLAN_REF) ?? [])].sort();

/** The latest skill entered on the active branch, as `phaseEntered` recorded it. */
const latestPhase = (ctx: ExtensionContext): PhaseEntry | undefined => {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e?.type === "custom" && e.customType === PHASE_ENTRY) return e.data as PhaseEntry;
  }
  return undefined;
};

/**
 * Whether reading `skill` continues the phase entered last rather than entering one: the latest
 * skill entered is `skill`, and `args` names no plan or the same plans. Pi reads a SKILL.md again
 * mid-phase, such as after compaction, when the plan's status has already moved on.
 */
const continuesPhase = (ctx: ExtensionContext, skill: string, args: string): boolean => {
  const last = latestPhase(ctx);
  if (last?.skill !== skill) return false;
  const plans = plansIn(args);
  return plans.length === 0 || plans.join("\n") === last.plans.join("\n");
};

/**
 * The text Pi's edit tool writes: each oldText matched once in the original file, and all of them
 * applied together, never one on another's output. Undefined where this does not model Pi
 * exactly: a file Pi cannot read or holding a BOM or a CR, or an oldText that is empty, missing,
 * repeated, or overlapping another, which Pi refuses or matches fuzzily.
 */
const piEdited = (file: string, edits: readonly { oldText: string; newText: string }[]) => {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (content.startsWith("\uFEFF") || content.includes("\r")) return undefined;
  const lf = (text: string) => text.replace(/\r\n?/g, "\n");
  const found: { at: number; end: number; text: string }[] = [];
  for (const e of edits) {
    const old = lf(e.oldText);
    const at = old === "" ? -1 : content.indexOf(old);
    if (at < 0 || content.split(old).length > 2) return undefined;
    found.push({ at, end: at + old.length, text: lf(e.newText) });
  }
  found.sort((x, y) => x.at - y.at);
  let out = "";
  let pos = 0;
  for (const f of found) {
    if (f.at < pos) return undefined;
    out += content.slice(pos, f.at) + f.text;
    pos = f.end;
  }
  return out + content.slice(pos);
};

/**
 * The Claude-shaped PreToolUse input for a bash, edit, or write call, or undefined for every other
 * tool. An edit is judged as the Write of the text Pi writes (piEdited); where that is not
 * modelled, as a MultiEdit of its edits, which the guard applies one after another.
 */
const guardInput = (event: ToolCallEvent, cwd: string): HookInput | undefined => {
  const base = { hook_event_name: "PreToolUse", tool_use_id: event.toolCallId };
  if (isToolCallEventType("bash", event))
    return { ...base, tool_name: "Bash", tool_input: { command: event.input.command } };
  if (isToolCallEventType("edit", event)) {
    const file = resolveToCwd(event.input.path, cwd);
    const content = piEdited(file, event.input.edits);
    if (content !== undefined)
      return { ...base, tool_name: "Write", tool_input: { file_path: file, content } };
    return {
      ...base,
      tool_name: "Edit",
      tool_input: {
        file_path: file,
        edits: event.input.edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })),
      },
    };
  }
  if (isToolCallEventType("write", event))
    return {
      ...base,
      tool_name: "Write",
      tool_input: { file_path: resolveToCwd(event.input.path, cwd), content: event.input.content },
    };
  return undefined;
};

// ── extension ──────────────────────────────────────────────────────────

export default function devExtension(pi: ExtensionAPI) {
  // Read once; a failed read is retried on the next prompt.
  let rulesCache: string | undefined;
  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes(RULES_MARK + ROOT)) return;
    const text = rulesCache ?? rules();
    if (!text.includes("could not be read (")) rulesCache = text;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });

  /** Records that the agent entered `skill`, unless it is already the latest entry. */
  const phaseEntered = (ctx: ExtensionContext, skill: string, args: string): void => {
    const entry: PhaseEntry = { skill, plans: plansIn(args) };
    const last = latestPhase(ctx);
    if (last?.skill === entry.skill && last.plans.join("\n") === entry.plans.join("\n")) return;
    pi.appendEntry(PHASE_ENTRY, entry);
  };

  // Pi persists an assistant message at message_end; keep it in case a call runs before the
  // session lists it.
  let lastAssistant: Message | undefined;
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistant = event.message as Message;
  });

  // A typed /skill:<name> loads a phase without a read: the gate decides on the prompt, and a
  // blocked prompt never reaches the agent.
  // `/dev:<name>`, as Claude Code types a plugin skill, is rewritten to Pi's `/skill:<name>` for
  // this plugin's own skills; Pi skill names cannot hold a colon.
  pi.on("input", async (event, ctx) => {
    const alias = /^(\s*)\/dev:([a-z0-9-]+)(?=\s|$)/i.exec(event.text);
    const name = alias?.[2]?.toLowerCase();
    const text =
      alias !== null && name !== undefined && fs.existsSync(path.join(SKILLS, name, "SKILL.md"))
        ? `${alias[1]}/skill:${name}${event.text.slice(alias[0].length)}`
        : event.text;
    // Another package's skill of the same name as a phase is not this plugin's, so not gated.
    const typed = /^\s*\/skill:([a-z0-9-]+)/i.exec(text)?.[1]?.toLowerCase();
    if (typed === undefined || !fs.existsSync(path.join(SKILLS, typed, "SKILL.md"))) return;
    const v = check({ hook_event_name: "UserPromptSubmit", prompt: text }, ctx.cwd);
    if (v !== undefined && "block" in v) {
      ctx.ui.notify(`[dev] ${utf8(v.block)}`, "error");
      return { action: "handled" };
    }
    if (v !== undefined && "error" in v)
      ctx.ui.notify(`[dev] the gate failed, ${text} loaded ungated: ${v.error}`, "warning");
    phaseEntered(ctx, typed, text);
    return text === event.text ? undefined : { action: "transform", text };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("read", event)) {
      const slug = skillOf(resolveToCwd(event.input.path ?? "", ctx.cwd));
      if (slug === undefined) return;
      // A call another tool made has id "<parent id>/<n>"; the root is the model-issued call
      // recorded in the transcript.
      const callId = event.toolCallId.split("/")[0] ?? event.toolCallId;
      const args = skillArguments(ctx, callId, lastAssistant);
      // Reading the skill of the phase in progress again is not an entry, so it is not gated.
      if (continuesPhase(ctx, slug, args)) return;
      const v = check(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Skill",
          // The read resolved to this plugin's skill, so it is named as Claude Code names one.
          tool_input: { skill: `dev:${slug}`, arguments: args },
        },
        ctx.cwd,
      );
      if (v !== undefined && "block" in v) return { block: true, reason: `[dev] ${utf8(v.block)}` };
      phaseEntered(ctx, slug, args);
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
    if (v !== undefined && "error" in v)
      ctx.ui.notify(
        `[dev] the plan check after bash failed, its changes went unchecked: ${v.error}`,
        "warning",
      );
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
    else if (v !== undefined && "error" in v)
      ctx.ui.notify(
        `[dev] the plan check after bash failed, its changes went unchecked: ${v.error}`,
        "warning",
      );
  });

  // `next`, `list`, and `check` only read. `review`, `stop`, `resume`, and `reopen` record a
  // decision of the user's, so each waits for the turn to end: a running turn reads the plan and
  // the stack's log. Pi treats a submitted command as the user's own.
  for (const command of COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, ctx) => {
        if (command.write) await ctx.waitForIdle();
        const { text, note } = stackCommand(command.name, args, ctx.cwd, process.env) ?? {
          text: `no command ${command.name}`,
        };
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
