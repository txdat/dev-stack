#!/usr/bin/env node
// Antigravity's hook entry: reads camelCase hook JSON on stdin and prints Antigravity's response
// JSON. SessionStart injects $DEV_LIB and the shared rules; PreToolUse runs the serial-test check
// and gateCheck; PostToolUse runs bashPostCheck so unauthorized plan edits are restored.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { asciiLower, b, utf8 } from "../core/bytes.ts";
import { processCtx } from "../core/cli.ts";
import { gateCheck, isPhaseCall } from "../core/gate-check.ts";
import { type HookInput, type Json, member, str } from "../core/hook-input.ts";
import { serialCheck } from "../core/serial-check.ts";
import { GATED_PHASES, RULE_FILES, rulesText } from "../hooks/commands.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const pluginRoot = (env: Record<string, string | undefined>): string =>
  env["PLUGIN_ROOT"] && env["PLUGIN_ROOT"] !== "" ? env["PLUGIN_ROOT"] : ROOT;

/** Reads CORE.md and CODING.md and formats the SessionStart systemMessage step. */
const sessionRules = (root: string): unknown => {
  const contents = RULE_FILES.map((name) => {
    const file = path.join(root, "rules", name);
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: rulesText(root, contents, "read_file"),
        },
      },
    ],
  };
};

/** Skill slug if `filePath` points to a skill's SKILL.md (e.g., .../skills/<slug>/SKILL.md). */
const skillFromPath = (filePath: string): string => {
  const m = /(?:^|\/)skills\/([a-z0-9-]+)\/SKILL\.md$/i.exec(filePath.replace(/\\/g, "/"));
  return m?.[1] ?? "";
};

/** Whether `lastUserInput` invokes an orchestrator (`autopilot` or `run-stack`). */
const isOrchestratorInput = (lastUserInput: string): boolean =>
  /^[ \t\n\v\f\r]*\/?(?:skill:(?:dev[:-])?|dev[:-])?(?:autopilot|run-stack)(?:[^a-z0-9_-]|$)/i.test(
    lastUserInput.replace(/_/g, "-"),
  );

/** Converts an Antigravity PreToolUse/PostToolUse payload into the Claude-shaped HookInput. */
const toHookInput = (raw: HookInput, event: string): HookInput | undefined => {
  const call = raw["toolCall"];
  const name = str(member(call, "name")) ?? "";
  const id = str(member(call, "id")) ?? "";
  const args = member(call, "args");
  const base: HookInput = {
    hook_event_name: event === "PostToolUse" && raw["error"] ? "PostToolUseFailure" : event,
    tool_use_id: id,
  };

  if (name === "run_command") {
    return {
      ...base,
      tool_name: "Bash",
      tool_input: { command: str(member(args, "CommandLine")) ?? "" },
    };
  }
  if (event !== "PreToolUse") return undefined;

  if (name === "edit_file") {
    return {
      ...base,
      tool_name: "Edit",
      tool_input: {
        file_path: str(member(args, "Path")) ?? "",
        old_string: str(member(args, "Target")) ?? "",
        new_string: str(member(args, "Replacement")) ?? "",
        replace_all: true,
      },
    };
  }
  if (name === "write_file") {
    const filePath = str(member(args, "Path")) ?? "";
    let content = str(member(args, "Content")) ?? "";
    if (member(args, "Append") === true && filePath !== "") {
      try {
        content = b(fs.readFileSync(filePath, "latin1")) + content;
      } catch {}
    }
    return {
      ...base,
      tool_name: "Write",
      tool_input: { file_path: filePath, content },
    };
  }
  if (name === "read_file") {
    const slug = skillFromPath(str(member(args, "Path")) ?? "");
    if (slug === "") return undefined;
    const lastUserInput = str(raw["lastUserInput"]) ?? "";
    // Orchestrators (autopilot, run-stack) delegate gated phases to subagents whose read_file
    // inherits the user's top-level prompt, which need not name the subagent's target plan.
    if (GATED_PHASES.includes(asciiLower(slug)) && isOrchestratorInput(lastUserInput)) {
      return undefined;
    }
    return {
      ...base,
      tool_name: "Skill",
      tool_input: {
        skill: `dev:${slug}`,
        arguments: lastUserInput,
      },
    };
  }
  return undefined;
};

const run = (raw: HookInput): void => {
  const event = str(raw["hookEventName"]) ?? "";
  const cwdRaw = str(raw["cwd"]);
  const baseCtx = processCtx();
  const ctx = cwdRaw ? { cwd: cwdRaw, env: baseCtx.env } : baseCtx;

  if (event === "SessionStart") {
    writeJson(sessionRules(pluginRoot(process.env)));
    return;
  }

  const mapped = toHookInput(raw, event);
  if (event === "PostToolUse") {
    if (mapped !== undefined) {
      try {
        gateCheck(mapped, ctx);
      } catch (e) {
        process.stderr.write(`agy-hook.js: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    writeJson({});
    return;
  }

  if (event !== "PreToolUse" || mapped === undefined) {
    writeJson({ decision: "allow" });
    return;
  }

  try {
    const serial = serialCheck(mapped);
    if (serial !== undefined) {
      writeJson({ decision: "deny", reason: utf8(serial) });
      return;
    }
    const verdict = gateCheck(mapped, ctx);
    if (verdict && "block" in verdict) {
      writeJson({ decision: "deny", reason: utf8(verdict.block) });
      return;
    }
    writeJson({ decision: "allow" });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (isPhaseCall(mapped)) {
      writeJson({
        decision: "deny",
        reason: `agy-hook.js failed (${why}) before reaching a verdict; this blocks rather than passing.`,
      });
    } else {
      process.stderr.write(`agy-hook.js: ${why}\n`);
      writeJson({ decision: "allow" });
    }
  }
};

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  process.stderr.write("agy-hook.js: the hook input is not a JSON object\n");
  writeJson({ decision: "allow" });
} else {
  run(parsed as { [key: string]: Json });
}
