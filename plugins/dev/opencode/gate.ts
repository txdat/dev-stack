// The gate, wire-level: OpenCode's tool names and arguments mapped onto the hook calls the core
// gate reads (core/gate-check.ts), and the plan or phase a call names. The core works on
// Claude-shaped hook JSON, so the adapter supplies that shape; nothing here decides policy.

import { b } from "../core/bytes.ts";
import { byteEnv } from "../core/cli.ts";
import { type GateResult, gateCheck, skillSlug } from "../core/gate-check.ts";
import type { GateCtx, HookInput } from "../core/hook-input.ts";
import { GUARDED_PATH } from "../core/record-guard.ts";
import { serialCheck } from "../core/serial-check.ts";
import { GATED_PHASES } from "../hooks/commands.ts";
import type { SessionMessage } from "./api.ts";

/** A plan as `<issue>_<slug>/pr<N>.spec.md`, however its path is written. */
const PLAN_REF = /[^\s/]+\/pr\d+\.spec\.md/;

/** Where a check runs: the session's directory and this process's environment, as bytes. */
export const gateCtx = (cwd: string): GateCtx => ({ cwd: b(cwd), env: byteEnv(process.env) });

/**
 * `gateCheck` with an error kept apart from a verdict: a phase call fails closed, an unreadable
 * guard input passes with a warning, as the other adapters do.
 */
export const check = (input: HookInput, cwd: string): GateResult | { error: string } => {
  try {
    return gateCheck(input, gateCtx(cwd));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");
const objectOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The plan text a call named, for the plan a gated phase must resolve. */
export const planText = (assistant: string, user: string): string =>
  PLAN_REF.test(assistant) ? assistant : user;

/** The plan references a phase was entered on, in a stable order. */
export const plansIn = (text: string): string[] =>
  [...new Set(text.match(new RegExp(PLAN_REF.source, "g")) ?? [])].sort();

/** The gated phase a skill ID invokes; "" for every other skill. */
export const gatedPhase = (id: string): string => {
  const slug = skillSlug(id);
  return GATED_PHASES.includes(slug) ? slug : "";
};

/** The hook call for a gated phase's `skill` tool call, `plan` being the plan text. */
export const skillCall = (phase: string, plan: string, callId: string): HookInput => ({
  hook_event_name: "PreToolUse",
  tool_name: "Skill",
  tool_use_id: callId,
  tool_input: { skill: `dev:${phase}`, arguments: plan },
});

/** The OpenCode tools the record guard reads, with their input shape. */
export type GuardedTool = "shell" | "write" | "edit";

/**
 * The hook call for one guarded OpenCode tool. `shell` matches Bash, `write` matches Write, and
 * `edit` matches Edit; OpenCode writes `path`, `oldString`, `newString`, and `replaceAll`.
 */
export const toolCall = (tool: GuardedTool, args: unknown, callId: string): HookInput => {
  const input = objectOf(args);
  const base = { hook_event_name: "PreToolUse", tool_use_id: callId };
  if (tool === "shell")
    return { ...base, tool_name: "Bash", tool_input: { command: stringOf(input["command"]) } };
  if (tool === "write")
    return {
      ...base,
      tool_name: "Write",
      tool_input: {
        file_path: stringOf(input["path"]),
        content: stringOf(input["content"]),
      },
    };
  return {
    ...base,
    tool_name: "Edit",
    tool_input: {
      file_path: stringOf(input["path"]),
      old_string: stringOf(input["oldString"]),
      new_string: stringOf(input["newString"]),
      ...(input["replaceAll"] === true ? { replace_all: true } : {}),
    },
  };
};

/** The Bash call after it ran or failed, whose post check compares the plans with its snapshot. */
export const bashPostCall = (callId: string, failed: boolean): HookInput => ({
  hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse",
  tool_name: "Bash",
  tool_use_id: callId,
});

/** Why a shell command may not run, from the serial-test check; undefined to pass. */
export const serialDeny = (args: unknown): string | undefined =>
  serialCheck(toolCall("shell", args, ""));

/** The files a `patch` call names, from its patch text; `Move to:` names a moved file's target. */
const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/**
 * Whether a `patch` call changes a plan, runbook, or architecture document. OpenCode's `patch`
 * tool writes several files at once, which the record guard cannot simulate; the adapter refuses
 * those changes rather than let them bypass the guard.
 */
export const patchTouchesGuarded = (args: unknown): boolean => {
  const text = stringOf(objectOf(args)["patchText"]);
  for (const match of text.matchAll(PATCH_TARGET))
    if (GUARDED_PATH.test(match[1] ?? "")) return true;
  return false;
};

/** A message's text, for the plan resolution a gated phase needs. */
export const messageText = (message: SessionMessage | undefined): string => {
  if (message === undefined) return "";
  if (message.type === "assistant") {
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
  }
  return typeof message.text === "string" ? message.text.trim() : "";
};

/** The refusal a phase call gets when the gate could not reach a verdict. */
export const failedClosed = (reason: string): string =>
  `the phase gate failed before a verdict (${reason}); this blocks rather than passing.`;
