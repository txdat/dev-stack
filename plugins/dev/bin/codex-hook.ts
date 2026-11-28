#!/usr/bin/env node
// Codex's hook entry: reads Codex's hook JSON on stdin, which has Claude Code's shape, and prints
// Codex's response JSON, or nothing to pass. SessionStart and SubagentStart inject $DEV_LIB, the
// shared rules, and the delegation rule. UserPromptSubmit runs /dev-stack-* commands and gates a
// `$dev:<phase>` mention, which Codex answers by injecting the skill. PreToolUse runs the
// serial-test check, gates a shell read of a phase's SKILL.md (Codex has no file-read tool), and runs
// the record guard on shell commands and on apply_patch, which it models as Edit and Write calls and
// snapshots; PostToolUse checks the plans after either, restoring what the record forbids.
//
// Codex reads only the documented shapes: a PreToolUse refusal is hookSpecificOutput's deny alone
// (with `continue` or `decision` beside it, Codex runs the call), and a prompt refusal is
// `decision: block`, whose reason Codex shows the user without calling the model.
//
// Every error is caught: on a phase-gate call it refuses; on a guard or serial-check call it
// passes and exits 1, which Codex reports as a failed hook.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b, utf8 } from "../core/bytes.ts";
import { processCtx } from "../core/cli.ts";
import { gateCheck, isPhaseCall } from "../core/gate-check.ts";
import { type GateCtx, type HookInput, type Json, member } from "../core/hook-input.ts";
import { planMentions } from "../core/plan-lib.ts";
import { GUARDED_PATH, snapshotPlans } from "../core/record-guard.ts";
import { serialCheck } from "../core/serial-check.ts";
import { skillFromPath, skillReadBlock } from "../core/skill-read.ts";
import { stackCommand } from "../core/stack-command.ts";
import { COMMANDS, RULE_FILES, rulesText } from "../hooks/commands.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The delegation rule Codex loads with the shared rules; scripts/build-codex.ts renders it. */
const CODEX_RULE = "codex-agents.md";
/** How much of a transcript's end the hook reads for the latest messages. */
const TRANSCRIPT_TAIL = 1 << 20;

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const deny = (reason: string): void =>
  writeJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

/** A JSON string as the UTF-8 text a HookInput carries, which core's str() reads as bytes. */
const text = (v: Json | undefined): string => (typeof v === "string" ? v : "");

const pluginRoot = (): string => process.env["PLUGIN_ROOT"] || ROOT;

/** $DEV_LIB, CORE.md, CODING.md, and the delegation rule, as one context block. */
const sessionContext = (root: string): string => {
  const read = (name: string): string | { error: string } => {
    try {
      return fs.readFileSync(path.join(root, "rules", name), "utf8");
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  const rules = `${rulesText(root, RULE_FILES.map(read), "the shell tool")}\n\nCodex's shell does not define $DEV_LIB: write its value, ${root}, in commands.`;
  const agents = read(CODEX_RULE);
  const file = `${root}/rules/${CODEX_RULE}`;
  return typeof agents === "string"
    ? `${rules}\n\nContents of ${file}:\n\n${agents}`
    : `${rules}\n\n${file} could not be read (${agents.error}); read it with the shell tool.`;
};

/** Parses a typed `/dev-stack-*` command, or undefined for any other prompt. */
const parseStackCommand = (prompt: string): { name: string; args: string } | undefined => {
  const m = /^[ \t\r\n]*\/(dev-stack-[a-z-]+)(?:[ \t\r\n]+([\s\S]*))?$/.exec(prompt);
  const name = m?.[1];
  if (!name || !COMMANDS.some((c) => c.name === name)) return undefined;
  return { name, args: (m[2] ?? "").trim() };
};

/** Each `$dev:<skill>` a prompt mentions, in order: Codex injects each one's skill. */
const skillMentions = (prompt: string): string[] =>
  [...prompt.matchAll(/(?:^|[^A-Za-z0-9_$])\$dev:([a-z0-9-]+)(?![a-z0-9_-])/gi)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );

/**
 * `prompt` as the shared gate reads a typed skill: led by `/dev:<skill>`, as Claude Code's typed
 * command is. The rest of the prompt follows, so the plan it names still resolves.
 */
const asCommand = (skill: string, prompt: string): string => `/dev:${skill} ${prompt}`;

/** The text of a transcript message's content parts. */
const partsText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
        .filter((t) => t !== "")
        .join("\n")
    : "";

/**
 * The latest user prompt in a Codex transcript (a rollout JSONL), read from its last
 * TRANSCRIPT_TAIL bytes, and the latest assistant message after it; "" for each one it cannot find.
 * An assistant message from before the prompt belongs to an earlier turn. A subagent's task, its
 * first or a later one through followup_task, arrives as an `agent_message` sent down to it, from
 * its parent; a reply sent up from a subagent arrives mid-turn and starts no turn.
 */
const latestMessages = (file: string): { assistant: string; user: string } => {
  const out = { assistant: "", user: "" };
  if (file === "") return out;
  let tail: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString("utf8");
      // A cut first line is not a whole record.
      if (start > 0) tail = tail.slice(tail.indexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.user === ""; i--) {
    let rec: { type?: unknown; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    const p = rec.payload;
    if (!p || typeof p !== "object") continue;
    if (out.assistant === "" && rec.type === "response_item" && p["type"] === "message") {
      if (p["role"] === "assistant") out.assistant = partsText(p["content"]);
    }
    const item = p["item"] as Record<string, unknown> | undefined;
    if (rec.type === "event_msg" && item?.["type"] === "UserMessage")
      out.user = partsText(item["content"]);
    else if (rec.type === "response_item" && p["type"] === "agent_message") {
      const author = text(p["author"] as Json);
      if (author !== "" && text(p["recipient"] as Json).startsWith(`${author}/`))
        out.user = partsText(p["content"]);
    }
  }
  return out;
};

/** A typed prompt as the gate reads it: its first `$dev:<skill>` led as a command. */
const promptText = (prompt: string): string => {
  const first = skillMentions(prompt)[0];
  return first === undefined ? prompt : asCommand(first, prompt);
};

/**
 * Whether `file`, resolved from `cwd`, is inside the plugin's install root. A leading `$DEV_LIB`
 * names that root, as the rules write it, though Codex's shell does not define it.
 */
const inPlugin = (file: string, cwd: string): boolean => {
  if (/^\$(?:DEV_LIB|\{DEV_LIB\})\//.test(file)) return true;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(pluginRoot()), real(path.resolve(cwd, file)));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * The Skill call a shell command that reads this plugin's SKILL.md stands for, its text the
 * model's latest message when that names a plan, else the user's latest prompt; undefined for any
 * other command. Codex reads files only through its shell, so such a read loads the skill; a skill
 * file elsewhere, such as this repository's sources, is no skill load.
 */
const skillRead = (input: HookInput, command: string, cwd: string): HookInput | undefined => {
  const re =
    /(?:^|[^A-Za-z0-9_.-])([^ \t\r\n'"`;&|<>]*skills\/[a-z0-9-]+\/SKILL\.md)(?![A-Za-z0-9_.-])/gi;
  const file = [...command.matchAll(re)].map((m) => m[1] ?? "").find((f) => inPlugin(f, cwd));
  const slug = skillFromPath(file ?? "");
  if (slug === "") return undefined;
  const { assistant, user } = latestMessages(text(input["transcript_path"]));
  const said = planMentions(b(assistant)).length > 0 ? assistant : promptText(user);
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_use_id: text(input["tool_use_id"]),
    tool_input: { skill: `dev:${slug}`, arguments: said },
  };
};

// ── apply_patch ───────────────────────────────────────────────────────

/** One file an apply_patch call writes, as the Write call that leaves the same text. */
type PatchWrite = { file: string; content: string };

/** What an apply_patch call does: the files it writes, and those it deletes or moves away. */
type PatchOps = { writes: PatchWrite[]; removes: string[] };

/**
 * The files `patch` (Codex's `*** Begin Patch` format) adds, updates, or moves to, each with its
 * text after the patch, and the files it deletes or moves from; undefined when the patch cannot be
 * modeled, such as a hunk whose old lines do not appear in order.
 */
const patchOps = (patch: string, cwd: string): PatchOps | undefined => {
  const lines = patch.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch")
    return undefined;
  const writes: PatchWrite[] = [];
  const removes: string[] = [];
  let i = 1;
  const header = (line: string, tag: string) =>
    line.startsWith(tag) ? line.slice(tag.length).trim() : undefined;
  while (i < lines.length - 1) {
    const line = lines[i] ?? "";
    const add = header(line, "*** Add File: ");
    const del = header(line, "*** Delete File: ");
    const upd = header(line, "*** Update File: ");
    i++;
    if (add !== undefined) {
      const body: string[] = [];
      while (i < lines.length - 1 && !(lines[i] ?? "").startsWith("*** ")) {
        const l = lines[i++] ?? "";
        if (!l.startsWith("+")) return undefined;
        body.push(l.slice(1));
      }
      writes.push({ file: add, content: body.length === 0 ? "" : `${body.join("\n")}\n` });
    } else if (del !== undefined) {
      removes.push(del);
    } else if (upd !== undefined) {
      const moveTo = header(lines[i] ?? "", "*** Move to: ");
      if (moveTo !== undefined) {
        i++;
        removes.push(upd);
      }
      let current: string;
      try {
        current = fs.readFileSync(path.resolve(cwd, upd), "utf8");
      } catch {
        return undefined;
      }
      const eol = current.endsWith("\n");
      const fileLines = (eol ? current.slice(0, -1) : current).split("\n");
      let at = 0;
      while (i < lines.length - 1 && !(lines[i] ?? "").startsWith("*** ")) {
        const hunkHead = lines[i] ?? "";
        if (!hunkHead.startsWith("@@")) return undefined;
        i++;
        const anchor = hunkHead.slice(2).trim();
        if (anchor !== "") {
          const found = fileLines.findIndex((l, k) => k >= at && l.trim() === anchor);
          if (found === -1) return undefined;
          at = found + 1;
        }
        const old: string[] = [];
        const next: string[] = [];
        let eof = false;
        while (i < lines.length - 1) {
          const l = lines[i] ?? "";
          if (l === "*** End of File") {
            eof = true;
            i++;
            continue;
          }
          if (l.startsWith("@@") || l.startsWith("*** ")) break;
          i++;
          const sign = l[0] ?? " ";
          const body = l.slice(1);
          if (sign === " " || l === "") {
            old.push(body);
            next.push(body);
          } else if (sign === "-") old.push(body);
          else if (sign === "+") next.push(body);
          else return undefined;
        }
        if (old.length === 0) {
          fileLines.splice(fileLines.length, 0, ...next);
          at = fileLines.length;
          continue;
        }
        // An end-of-file hunk matches only at the file's end, as Codex applies it.
        let pos = -1;
        const matches = (k: number) => old.every((o, j) => fileLines[k + j] === o);
        if (eof) {
          const k = fileLines.length - old.length;
          if (k >= at && matches(k)) pos = k;
        } else
          for (let k = at; k + old.length <= fileLines.length; k++)
            if (matches(k)) {
              pos = k;
              break;
            }
        if (pos === -1) return undefined;
        fileLines.splice(pos, old.length, ...next);
        at = pos + next.length;
      }
      writes.push({ file: moveTo ?? upd, content: fileLines.join("\n") + (eol ? "\n" : "") });
    } else if (line.trim() !== "") return undefined;
  }
  return { writes, removes };
};

/** Every file a patch's headers name, moved-to targets included, for a patch it cannot model. */
const patchFiles = (patch: string): string[] =>
  [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) =>
    (m[1] ?? "").trim(),
  );

/** Whether `file`, resolved from `cwd`, is under a directory family the record guard judges. */
const guarded = (file: string, cwd: string): boolean =>
  GUARDED_PATH.test(path.resolve(cwd, file).replace(/\\/g, "/"));

/**
 * The record guard's refusal of an apply_patch call; undefined to pass. Its writes are judged as
 * Write calls. A delete or move of a guarded file, or a patch it cannot model that names one, is
 * refused: the guard judges a file's change from its content, which neither leaves.
 */
const patchBlock = (input: HookInput, ctx: GateCtx, cwd: string): string | undefined => {
  const patch = text(member(input["tool_input"], "command")) || text(input["tool_input"]);
  const ops = patchOps(patch, cwd);
  if (ops === undefined) {
    const file = patchFiles(patch).find((f) => guarded(f, cwd));
    if (file !== undefined)
      return `apply_patch on ${file} could not be checked by the record guard: each hunk's old lines must match the file exactly. Re-read ${file} and patch it with its exact lines.`;
  }
  const removed = ops?.removes.find((f) => guarded(f, cwd));
  if (removed !== undefined)
    return `apply_patch never deletes or moves ${removed}: the record guard cannot check that change under docs/plans, docs/runbook, or docs/architecture. dev-stack.js renumber moves a plan and drop removes one; for a runbook or architecture document, ask the user.`;
  for (const w of ops?.writes ?? []) {
    const result = gateCheck(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_use_id: text(input["tool_use_id"]),
        tool_input: { file_path: w.file, content: w.content },
      },
      ctx,
    );
    if (result && "block" in result) return utf8(result.block);
  }
  snapshotPlans(input, ctx);
  return undefined;
};

// ── events ────────────────────────────────────────────────────────────

const userPrompt = (input: HookInput, ctx: GateCtx, cwd: string): void => {
  const prompt = text(input["prompt"]);
  const cmd = parseStackCommand(prompt);
  if (cmd !== undefined) {
    const result = stackCommand(cmd.name, cmd.args, cwd, process.env);
    if (result !== undefined) {
      writeJson({
        decision: "block",
        reason: result.note ? `${result.text}\n\n${result.note}` : result.text,
      });
      return;
    }
  }
  for (const skill of skillMentions(prompt)) {
    const mapped: HookInput = {
      hook_event_name: "UserPromptSubmit",
      prompt: asCommand(skill, prompt),
    };
    let result: ReturnType<typeof gateCheck>;
    try {
      result = gateCheck(mapped, ctx);
    } catch (e) {
      if (!isPhaseCall(mapped)) throw e;
      const why = e instanceof Error ? e.message : String(e);
      result = {
        block: `codex-hook.js failed (${why}) before reaching a verdict; this blocks rather than passing.`,
      };
    }
    if (result && "block" in result) {
      writeJson({ decision: "block", reason: utf8(result.block) });
      return;
    }
  }
};

const preTool = (input: HookInput, ctx: GateCtx, cwd: string): void => {
  const tool = text(input["tool_name"]);
  if (tool === "apply_patch") {
    const reason = patchBlock(input, ctx, cwd);
    if (reason !== undefined) deny(reason);
    return;
  }
  if (tool !== "Bash") return;
  const serial = serialCheck(input);
  if (serial !== undefined) {
    deny(utf8(serial));
    return;
  }
  const read = skillRead(input, text(member(input["tool_input"], "command")), cwd);
  if (read !== undefined) {
    let reason: string | undefined;
    try {
      reason = skillReadBlock(read, ctx);
    } catch (e) {
      if (!isPhaseCall(read)) throw e;
      const why = e instanceof Error ? e.message : String(e);
      reason = b(
        `codex-hook.js failed (${why}) before reaching a verdict; this blocks rather than passing.`,
      );
    }
    if (reason !== undefined) {
      deny(utf8(reason));
      return;
    }
  }
  const result = gateCheck(input, ctx);
  if (result && "block" in result) deny(utf8(result.block));
};

const postTool = (input: HookInput, ctx: GateCtx): void => {
  const tool = text(input["tool_name"]);
  if (tool !== "Bash" && tool !== "apply_patch") return;
  const result = gateCheck({ ...input, tool_name: "Bash", hook_event_name: "PostToolUse" }, ctx);
  // Codex edits files only with apply_patch.
  if (result && "postBlock" in result)
    writeJson({
      decision: "block",
      reason: utf8(result.postBlock).replace("with the Edit tool", "with apply_patch"),
    });
};

const run = (input: HookInput): void => {
  const event = text(input["hook_event_name"]);
  const cwd = text(input["cwd"]) || process.cwd();
  const ctx: GateCtx = { cwd: b(cwd), env: processCtx().env };
  if (event === "SessionStart" || event === "SubagentStart") {
    writeJson({
      hookSpecificOutput: { hookEventName: event, additionalContext: sessionContext(pluginRoot()) },
    });
  } else if (event === "UserPromptSubmit") userPrompt(input, ctx, cwd);
  else if (event === "PreToolUse") preTool(input, ctx, cwd);
  else if (event === "PostToolUse") postTool(input, ctx);
};

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {}
if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  process.stderr.write("codex-hook.js: the hook input is not a JSON object\n");
  process.exitCode = 1;
} else {
  try {
    run(parsed as HookInput);
  } catch (e) {
    // Phase gates refuse on their own errors above; what reaches here is a guard or serial check.
    process.stderr.write(`codex-hook.js: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
