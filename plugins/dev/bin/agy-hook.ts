#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Antigravity's hook entry: reads camelCase hook JSON on stdin and prints Antigravity's response
// JSON. SessionStart injects $DEV_LIB and the shared rules; PreToolUse runs the serial-test check
// and gateCheck; PostToolUse runs bashPostCheck so unauthorized plan edits are restored.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b, utf8 } from "../core/bytes.ts";
import { processCtx } from "../core/cli.ts";
import { gateCheck, gateIndexed, isPhaseCall, skillSlug } from "../core/gate-check.ts";
import { type HookInput, type Json, member, str } from "../core/hook-input.ts";
import { PlanLib, planMentions } from "../core/plan-lib.ts";
import { serialCheck } from "../core/serial-check.ts";
import { tryMainRoot } from "../core/utils.ts";
import { RULE_FILES, rulesText } from "../hooks/commands.ts";

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

/** Skill slug if `filePath` points to a skill's SKILL.md (e.g., .../skills/<slug>/SKILL.md). */
const skillFromPath = (filePath: string): string => {
  const m = /(?:^|\/)skills\/([a-z0-9-]+)\/SKILL\.md$/i.exec(filePath.replace(/\\/g, "/"));
  return m?.[1] ?? "";
};

/** Whether `text` invokes an orchestrator (`autopilot` or `run-stack`). */
const isOrchestratorInput = (text: string): boolean =>
  /^[ \t\n\v\f\r]*\/?(?:skill:(?:dev[:-])?|dev[:-])?(?:autopilot|run-stack)(?:[^a-z0-9_-]|$)/i.test(
    text.replace(/_/g, "-"),
  );

/** Whether `text` names `slug` as a phase (either as a slash/prefix command or a standalone word). */
const namesPhase = (text: string, slug: string): boolean =>
  skillSlug(text) === slug ||
  new RegExp(`(^|[^a-z0-9_-])${slug}([^a-z0-9_-]|$)`, "i").test(text.replace(/_/g, "-"));

const PHASE_ENTRY_STATUSES: Record<string, readonly string[]> = {
  "review-feature": ["planning", "needs-changes", "ready"],
  "execute-feature": ["approved", "auto-approved"],
  "review-code": ["implemented"],
  "create-pr": ["reviewed"],
};

/**
 * Checks whether any plan in the main root's `docs/plans/` passes `gateIndexed` for `skill`.
 * A `Status: ready` plan counts as runnable for `review-feature` only when its review is stale
 * (not current `ready`), so a plan awaiting user approval does not permanently unlock the gate.
 */
const hasRunnablePlan = (skill: string, ctx: Parameters<typeof gateCheck>[1]): boolean => {
  const slug = skill.startsWith("dev:") ? skill.slice(4) : skill;
  const allowedStatuses = PHASE_ENTRY_STATUSES[slug];
  if (!allowedStatuses) return false;
  const root = tryMainRoot(ctx.cwd, ctx.env);
  if (!root) return false;
  const plansDir = path.join(root, "docs", "plans");
  let stacks: fs.Dirent[];
  try {
    stacks = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const lib = new PlanLib(root, ctx);
  const indexed = new Set<string>();
  for (const stack of stacks) {
    if (!stack.isDirectory()) continue;
    const stackDir = path.join(plansDir, stack.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(stackDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^pr[1-9][0-9]*\.spec\.md$/.test(entry.name)) continue;
      const planPath = path.join(stackDir, entry.name);
      const status = lib.status(planPath);
      if (!allowedStatuses.includes(status)) continue;
      if (!indexed.has(stackDir)) {
        lib.indexStack(planPath);
        indexed.add(stackDir);
      }
      if (slug === "review-feature" && status === "ready" && lib.reviewState(planPath) === "ready")
        continue;
      if (gateIndexed(slug, planPath, lib) === undefined) return true;
    }
  }
  return false;
};

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
    const assistant =
      str(raw["lastAssistantMessage"]) ??
      str(raw["assistantMessage"]) ??
      str(member(call, "message")) ??
      "";
    const user = str(raw["lastUserInput"]) ?? "";
    const text = planMentions(assistant).length > 0 ? assistant : user;
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
    const verdict = gateCheck(mapped, ctx);
    if (verdict && "block" in verdict) {
      const skill = str(member(mapped["tool_input"], "skill")) ?? "";
      const slug = skill.startsWith("dev:") ? skill.slice(4) : skill;
      const args = str(member(mapped["tool_input"], "arguments")) ?? "";
      const namedWrongPlan =
        !isOrchestratorInput(args) && namesPhase(args, slug) && planMentions(args).length > 0;
      if (isPhaseCall(mapped) && !namedWrongPlan && hasRunnablePlan(skill, ctx)) {
        writeJson({ decision: "allow" });
        return;
      }
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
