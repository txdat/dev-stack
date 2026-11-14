// The gate, wire-level: this plugin's DSH tool names and arguments mapped onto the hook calls the
// core gate reads (core/gate-check.ts), and the phase or plan a call names. The core works on
// Claude-shaped hook JSON, so the adapter supplies that shape; nothing here decides policy.

import { b } from "../core/bytes.ts";
import { byteEnv } from "../core/cli.ts";
import { type GateResult, gateCheck, skillSlug } from "../core/gate-check.ts";
import type { GateCtx, HookInput, Json } from "../core/hook-input.ts";
import { serialCheck } from "../core/serial-check.ts";
import { GATED_PHASES } from "../hooks/commands.ts";

/** The DSH tool names the gate reads: the phase loader, and the three guarded mutators. */
export type GatedTool = "skill" | "bash" | "write" | "edit";

/** A plan as `<issue>_<slug>/pr<N>.spec.md`, however its path is written. */
const PLAN_REF = /[^\s/]+\/pr\d+\.spec\.md/;

/** Where a check runs: the session's directory and this process's environment, as bytes. */
export const gateCtx = (cwd: string): GateCtx => ({ cwd: b(cwd), env: byteEnv(process.env) });

/**
 * `gateCheck` with an error kept apart from a verdict: a phase call fails closed, an unreadable
 * guard input passes with a warning, as the Claude Code module and the Pi extension do.
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

/** The gated phase a skill name invokes; "" for every other skill. */
export const gatedPhase = (name: string): string => {
  const slug = skillSlug(name);
  return GATED_PHASES.includes(slug) ? slug : "";
};

/** The gated phase a typed prompt invokes: a leading slash command only, never prose. */
export const typedPhase = (text: string): string => {
  if (!/^[ \t\n\v\f\r]*\//.test(text)) return "";
  const slug = skillSlug(text);
  return GATED_PHASES.includes(slug) ? slug : "";
};

/** The hook call for a gated phase's `skill` tool call, `plan` being the plan text. */
export const skillCall = (name: string, plan: string, callId: string): HookInput => ({
  hook_event_name: "PreToolUse",
  tool_name: "Skill",
  tool_use_id: callId,
  tool_input: { skill: `dev:${name}`, arguments: plan },
});

/**
 * The hook call for a mutator tool, from its DSH arguments. DSH's `edit` input matches Claude
 * Code's Edit; `write` matches Write; `bash` matches Bash.
 */
export const toolCall = (tool: GatedTool, args: unknown, callId: string): HookInput => {
  const input = objectOf(args);
  const base = { hook_event_name: "PreToolUse", tool_use_id: callId };
  if (tool === "bash")
    return { ...base, tool_name: "Bash", tool_input: { command: stringOf(input["command"]) } };
  if (tool === "write")
    return {
      ...base,
      tool_name: "Write",
      tool_input: {
        file_path: stringOf(input["file_path"]),
        content: stringOf(input["content"]),
      },
    };
  return {
    ...base,
    tool_name: "Edit",
    tool_input: {
      file_path: stringOf(input["file_path"]),
      old_string: stringOf(input["old_string"]),
      new_string: stringOf(input["new_string"]),
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
  serialCheck(toolCall("bash", args, ""));

/** The refusal a phase call gets when the gate could not reach a verdict. */
export const failedClosed = (reason: string): string =>
  `the phase gate failed before a verdict (${reason}); this blocks rather than passing.`;

export type { Json };
