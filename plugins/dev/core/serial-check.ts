// Before a shell command: refuses one that names a test runner listed in SERIAL_FLAG without that
// runner's serial flag, as ../rules/CODING.md#tests requires. It matches text, not runs: any
// command with a runner's name as a word needs its flag as a word, including one that only
// mentions the runner. Unreadable input passes.

import { type HookInput, member, str } from "./hook-input.ts";

/** A command that names a runner must name its serial flag. */
const SERIAL_FLAG: readonly (readonly [string, string])[] = [
  ["jest", "--runInBand"],
  ["vitest", "--no-file-parallelism"],
];

/** A word: not preceded or followed by a letter, digit, _, or -. */
const hasWord = (cmd: string, word: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_-])${word}([^A-Za-z0-9_-]|$)`).test(cmd);

/** Why a Bash call must not run; undefined to pass. */
export const serialCheck = (input: HookInput): string | undefined => {
  if (input["tool_name"] !== "Bash") return undefined;
  const cmd = str(member(input["tool_input"], "command")) ?? "";
  for (const [runner, flag] of SERIAL_FLAG)
    if (hasWord(cmd, runner) && !hasWord(cmd, flag))
      return `This command names ${runner} without ${flag}. Run tests serially (CODING.md#tests): add ${flag}, after -- for npm (npm test -- ${flag}).`;
  return undefined;
};

/**
 * A serial-check refusal as Claude Code reads it. Claude Code accepts only approve or block as a
 * top-level decision and drops output it cannot validate, so the deny goes in hookSpecificOutput
 * only.
 */
export const claudeSerialDeny = (reason: string): string =>
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`;
