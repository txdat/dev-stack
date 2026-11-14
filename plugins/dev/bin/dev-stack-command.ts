#!/usr/bin/env node
// Runs one /dev-stack-* command for the Claude Code module: `dev-stack-command.ts <name> <args>`
// prints `{"text": ..., "note": ...}` (note only after a write). An unknown name exits 2.

import { stackCommand } from "../core/stack-command.ts";

const [name = "", args = ""] = process.argv.slice(2);
const result = stackCommand(name, args, process.cwd(), process.env);
if (result === undefined) {
  process.stderr.write(`dev-stack-command.ts: no command ${name}\n`);
  process.exitCode = 2;
} else process.stdout.write(`${JSON.stringify(result)}\n`);
