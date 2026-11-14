#!/usr/bin/env node
// Claude Code's hook entry: reads hook JSON on stdin and prints the verdict JSON, or nothing to
// pass. A PreToolUse Bash call gets the serial-test check, then the record guard.
//
// Every error is caught: on a phase-gate call it denies; on a guard or serial-check call it passes
// and exits 1, as input that is not a JSON object does, which an adapter reports as a check that
// could not run.

import * as fs from "node:fs";
import { processCtx } from "../core/cli.ts";
import { claudeVerdict, gateCheck, isPhaseCall } from "../core/gate-check.ts";
import type { HookInput } from "../core/hook-input.ts";
import { claudeSerialDeny, serialCheck } from "../core/serial-check.ts";

const ctx = processCtx();
const write = (text: string) => {
  if (text !== "") process.stdout.write(text);
};

let input: HookInput | undefined;
try {
  const parsed: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
    input = parsed as HookInput;
} catch {}
// Unreadable input names no call, so no verdict: the adapter passes it with a visible warning.
if (input === undefined) {
  process.stderr.write("hook.js: the hook input is not a JSON object\n");
  process.exitCode = 1;
} else {
  try {
    run(input);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (isPhaseCall(input))
      write(
        claudeVerdict(input, {
          block: `hook.js failed (${why}) before reaching a verdict; this blocks rather than passing.`,
        }),
      );
    else {
      // A guard or serial check that failed passes the call; exit 1 makes the adapter warn.
      process.stderr.write(`hook.js: ${why}\n`);
      process.exitCode = 1;
    }
  }
}

function run(input: HookInput): void {
  const serial = input["hook_event_name"] === "PreToolUse" ? serialCheck(input) : undefined;
  if (serial !== undefined) write(claudeSerialDeny(serial));
  else write(claudeVerdict(input, gateCheck(input, ctx)));
}
