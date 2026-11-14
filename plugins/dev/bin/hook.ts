#!/usr/bin/env node
// Claude Code's hook entry: reads hook JSON on stdin and prints the verdict JSON, or nothing to
// pass. A PreToolUse Bash call gets the serial-test check, then the record guard. `--gate` and
// `--serial` run one check alone; `--design <plan>` runs design-feature's stack check.
//
// Every error is caught: on a phase-gate call it denies, on a guard or serial-check call it passes.

import * as fs from "node:fs";
import { processCtx } from "../core/cli.ts";
import { claudeVerdict, gateCheck, gateDesign } from "../core/gate-check.ts";
import type { HookInput } from "../core/hook-input.ts";
import { claudeSerialDeny, serialCheck } from "../core/serial-check.ts";

const ctx = processCtx();
const [mode, plan] = ctx.argv;
const write = (text: string) => {
  if (text !== "") process.stdout.write(text);
};

if (mode === "--design") {
  write(claudeVerdict({}, gateDesign(plan ?? "", ctx)));
} else {
  let input: HookInput | undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      input = parsed as HookInput;
  } catch {}
  if (input !== undefined) {
    const serial =
      mode !== "--gate" && input["hook_event_name"] === "PreToolUse"
        ? serialCheck(input)
        : undefined;
    if (serial !== undefined) write(claudeSerialDeny(serial));
    else if (mode !== "--serial") write(claudeVerdict(input, gateCheck(input, ctx)));
  }
}
