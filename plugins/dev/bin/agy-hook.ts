#!/usr/bin/env node
// Antigravity's hook entry: reads camelCase hook JSON on stdin and prints Antigravity's response
// JSON. SessionStart injects $DEV_LIB and the shared rules; PreInvocation runs /dev-stack-*
// commands; PreToolUse runs the serial-test check and gateCheck; PostToolUse runs bashPostCheck so
// unauthorized plan edits are restored.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b, utf8 } from "../core/bytes.ts";
import { processCtx } from "../core/cli.ts";
import { gateCheck, isPhaseCall } from "../core/gate-check.ts";
import { type HookInput, type Json, member, str } from "../core/hook-input.ts";
import { planMentions } from "../core/plan-lib.ts";
import { serialCheck } from "../core/serial-check.ts";
import { skillFromPath, skillReadBlock } from "../core/skill-read.ts";
import { stackCommand } from "../core/stack-command.ts";
import { COMMANDS, RULE_FILES, rulesText } from "../hooks/commands.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

/** Temporary file holding pending post-check notices for a conversation until PostInvocation. */
const noticeFile = (conversationId: string): string | undefined => {
  if (conversationId === "") return undefined;
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_");
  const uid = process.getuid?.() ?? 0;
  const dir = path.join(
    process.env["XDG_RUNTIME_DIR"] || process.env["TMPDIR"] || os.tmpdir(),
    `dev-agy-notices-${uid}`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${safe}.txt`);
  } catch {
    return undefined;
  }
};

const pushNotice = (conversationId: string, text: string): void => {
  const file = noticeFile(conversationId);
  if (!file) return;
  try {
    fs.appendFileSync(file, `${text}\n\n`, "utf8");
  } catch {}
};

const drainNotices = (conversationId: string): string => {
  const file = noticeFile(conversationId);
  if (!file || !fs.existsSync(file)) return "";
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    fs.rmSync(file, { force: true });
    return text;
  } catch {
    return "";
  }
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

/** Parses a typed `/dev-stack-*` command from user input, or undefined for any other input. */
const parseStackCommand = (text: string): { name: string; args: string } | undefined => {
  const m = /^[ \t\r\n]*\/(dev-stack-[a-z-]+)(?:[ \t\r\n]+([\s\S]*))?$/.exec(text);
  const name = m?.[1];
  if (!name || !COMMANDS.some((c) => c.name === name)) return undefined;
  return { name, args: (m[2] ?? "").trim() };
};

/** A JSON string as the UTF-8 text a HookInput carries, which core's str() reads as bytes. */
const jsonText = (v: Json | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Converts an Antigravity PreToolUse/PostToolUse payload into the Claude-shaped HookInput. Its
 * values stay UTF-8 text, as Claude Code's are; converting them to bytes here would encode
 * non-ASCII text twice once core reads them.
 */
const toHookInput = (raw: HookInput, event: string): HookInput | undefined => {
  const call = raw["toolCall"];
  const name = str(member(call, "name")) ?? "";
  const id = jsonText(member(call, "id")) ?? "";
  const args = member(call, "args");
  const base: HookInput = {
    hook_event_name: event === "PostToolUse" && raw["error"] ? "PostToolUseFailure" : event,
    tool_use_id: id,
  };

  if (name === "run_command") {
    return {
      ...base,
      tool_name: "Bash",
      tool_input: { command: jsonText(member(args, "CommandLine")) ?? "" },
    };
  }
  if (event !== "PreToolUse") return undefined;

  if (name === "edit_file") {
    return {
      ...base,
      tool_name: "Edit",
      tool_input: {
        file_path: jsonText(member(args, "Path")) ?? "",
        old_string: jsonText(member(args, "Target")) ?? "",
        new_string: jsonText(member(args, "Replacement")) ?? "",
        replace_all: true,
      },
    };
  }
  if (name === "write_file") {
    const filePath = jsonText(member(args, "Path")) ?? "";
    let content = jsonText(member(args, "Content")) ?? "";
    if (member(args, "Append") === true && filePath !== "") {
      try {
        content =
          fs.readFileSync(path.resolve(jsonText(raw["cwd"]) ?? "", filePath), "utf8") + content;
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
    const assistant =
      jsonText(raw["lastAssistantMessage"]) ??
      jsonText(raw["assistantMessage"]) ??
      jsonText(member(call, "message")) ??
      "";
    const user = jsonText(raw["lastUserInput"]) ?? "";
    const text = planMentions(b(assistant)).length > 0 ? assistant : user;
    return {
      ...base,
      tool_name: "Skill",
      tool_input: {
        skill: `dev:${slug}`,
        arguments: text,
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

  if (event === "PreInvocation") {
    const cmd = parseStackCommand(jsonText(raw["lastUserInput"]) ?? "");
    if (cmd === undefined) {
      writeJson({});
      return;
    }
    const cwd = jsonText(raw["cwd"]) || process.cwd();
    const result = stackCommand(cmd.name, cmd.args, cwd, process.env);
    if (result === undefined) {
      writeJson({});
      return;
    }
    const text = result.note ? `${result.text}\n\n${result.note}` : result.text;
    writeJson({
      injectSteps: [{ systemMessage: { systemMessage: text } }],
      terminationBehavior: "terminate",
    });
    return;
  }

  const conversationId = str(raw["conversationId"]) ?? "";
  if (event === "PostInvocation") {
    const notice = drainNotices(conversationId);
    writeJson(
      notice === ""
        ? {}
        : {
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: `[dev] ${notice}`,
                },
              },
            ],
          },
    );
    return;
  }

  const mapped = toHookInput(raw, event);
  if (event === "PostToolUse") {
    if (mapped !== undefined) {
      try {
        const result = gateCheck(mapped, ctx);
        if (result && "postBlock" in result) {
          const text = utf8(result.postBlock);
          pushNotice(conversationId, text);
          process.stderr.write(`[dev] ${text}\n`);
        }
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
    const reason = skillReadBlock(mapped, ctx);
    if (reason !== undefined) {
      writeJson({ decision: "deny", reason: utf8(reason) });
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
