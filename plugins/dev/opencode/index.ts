// The dev plugin's OpenCode V2 plugin: the rules as a system-prompt part, the skills and
// /dev-stack-* commands registered in memory, the phase gates on a skill load and a typed
// /dev-<skill>, the record guard and serial-test check on shell and edit calls, and the post check
// that restores plans a shell call changed. OpenCode runs the plugin inside its server under Node,
// so it calls core in-process, as the Pi extension and the DSH Host plugin do.
//
// A phase load is the `skill` tool, whose input is the skill ID alone. The plan a phase resolves is
// the one named by the assistant message that issued the call, else by the latest user message, as
// Pi's read gate and the DSH plugin do. A typed /dev-<skill> is a command: it runs the gate on the
// prompt, then sends the skill as an attachment, marked so the prompt hook does not gate it again.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b, utf8 } from "../core/bytes.ts";
import { type GateResult, gateContinue, skillSlug } from "../core/gate-check.ts";
import { stackCommand } from "../core/stack-command.ts";
import { COMMANDS, RULE_FILES, RULES_MARK, rulesText } from "../hooks/commands.ts";
import type {
  CommandInvocation,
  OpenCodeContext,
  Plugin,
  Registration,
  ToolHookAfter,
  ToolHookBefore,
} from "./api.ts";
import {
  bashPostCall,
  check,
  failedClosed,
  gateCtx,
  gatedPhase,
  messageText,
  patchTouchesGuarded,
  plansIn,
  planText,
  serialDeny,
  skillCall,
  toolCall,
} from "./gate.ts";
import { readSkills } from "./skills.ts";

/** The plugin's install root: `dist/dev` in the built plugin, `plugins/dev` from the sources. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The prefix every registered skill carries, so this plugin's names stay to itself. */
const SKILL_PREFIX = "dev-";

/** The prompt metadata marking a skill attachment this plugin already gated. */
const GATED_PROMPT = "dev-stack-gated";

/** The latest skill entered in a session, with the plans it was entered on. */
type PhaseEntry = { skill: string; plans: readonly string[] };
const phases = new Map<string, PhaseEntry>();

const objectOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** The rules, read once; a failed read is retried on the next request. */
let rulesCache: string | undefined;

const rules = (): string => {
  if (rulesCache !== undefined) return rulesCache;
  const contents = RULE_FILES.map((name) => {
    try {
      return fs.readFileSync(path.join(ROOT, "rules", name), "utf8");
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  const text = rulesText(ROOT, contents, "the read tool");
  if (!text.includes("could not be read (")) rulesCache = text;
  return text;
};

/** The session's directory, or this plugin instance's when the session cannot be read. */
const cwdOf = async (ctx: OpenCodeContext, sessionID: string): Promise<string> => {
  try {
    return (await ctx.session.get({ sessionID })).location.directory;
  } catch {
    return ctx.location.directory;
  }
};

/** A warning the user can see when a guard passes a call it could not check. */
const warn = async (ctx: OpenCodeContext, sessionID: string, text: string): Promise<void> => {
  try {
    await ctx.session.synthetic({
      sessionID,
      text: `[dev] ${text}`,
      description: "dev-stack warning",
      delivery: "queue",
      resume: false,
    });
  } catch {
    // A warning that cannot be shown never blocks the call it describes.
  }
};

/** The plan text a skill call resolves: its own assistant message, else the latest user message. */
const planTextFor = async (
  ctx: OpenCodeContext,
  sessionID: string,
  messageID: string,
): Promise<string> => {
  let assistant = "";
  let user = "";
  try {
    for (const message of await ctx.session.context({ sessionID })) {
      if (message.id === messageID) assistant = messageText(message);
      if (message.type === "user") user = messageText(message);
    }
  } catch {
    // Without the transcript the gate names no plan and refuses a gated phase.
  }
  return planText(assistant, user);
};

/** The plans of the phase in progress when reading `skill` continues it rather than entering one. */
const continuedPlans = (
  sessionID: string,
  skill: string,
  text: string,
): readonly string[] | undefined => {
  const last = phases.get(sessionID);
  if (last?.skill !== skill) return undefined;
  const plans = plansIn(text);
  return plans.length === 0 || plans.join("\n") === last.plans.join("\n") ? last.plans : undefined;
};

/**
 * Runs a gated phase's gate and records the entry. Returns the refusal, or undefined when the
 * phase may load. With `allowContinue`, reading the phase in progress again with no new plan
 * continues it: only the unpublished, unfrozen, and unstopped checks run, since its Status has
 * moved on.
 */
const gatePhase = async (
  ctx: OpenCodeContext,
  sessionID: string,
  phase: string,
  text: string,
  callId: string,
  allowContinue: boolean,
): Promise<string | undefined> => {
  const cwd = await cwdOf(ctx, sessionID);
  const continued = allowContinue ? continuedPlans(sessionID, phase, text) : undefined;
  let verdict: GateResult | { error: string };
  if (continued === undefined) {
    verdict = check(skillCall(phase, text, callId), cwd);
    if (verdict !== undefined && "block" in verdict) return `[dev] ${utf8(verdict.block)}`;
    if (verdict !== undefined && "error" in verdict) return `[dev] ${failedClosed(verdict.error)}`;
  } else {
    try {
      verdict = gateContinue(phase, continued.map(b), gateCtx(cwd));
    } catch (e) {
      return `[dev] ${failedClosed(e instanceof Error ? e.message : String(e))}`;
    }
    if (verdict !== undefined && "block" in verdict) return `[dev] ${utf8(verdict.block)}`;
    if (verdict !== undefined && "postBlock" in verdict) return `[dev] ${utf8(verdict.postBlock)}`;
  }
  phases.set(sessionID, { skill: phase, plans: continued ?? plansIn(text) });
  return undefined;
};

/** Records a skill of this plugin that is not gated, so a later gated load starts a new phase. */
const recordSkill = (sessionID: string, id: string, text: string): void => {
  const slug = skillSlug(id);
  if (slug === "" || !fs.existsSync(path.join(ROOT, "skills", slug, "SKILL.md"))) return;
  phases.set(sessionID, { skill: slug, plans: plansIn(text) });
};

/** Before a tool call: gate a skill load and run the record guard and serial-test check. */
const beforeTool = async (ctx: OpenCodeContext, event: ToolHookBefore): Promise<void> => {
  const { tool, sessionID, id } = event;
  if (tool === "skill") {
    const skill = stringOf(objectOf(event.input)["id"]);
    const phase = gatedPhase(skill);
    if (phase === "") {
      recordSkill(sessionID, skill, await planTextFor(ctx, sessionID, event.messageID));
      return;
    }
    const text = await planTextFor(ctx, sessionID, event.messageID);
    const reason = await gatePhase(ctx, sessionID, phase, text, id, true);
    if (reason !== undefined) throw new Error(reason);
    return;
  }
  if (tool === "patch") {
    if (patchTouchesGuarded(event.input))
      throw new Error(
        "[dev] Use the edit or write tool for changes under docs/plans, docs/runbook, and docs/architecture: the patch tool is not checked by the record guard.",
      );
    return;
  }
  if (tool !== "shell" && tool !== "write" && tool !== "edit") return;

  const cwd = await cwdOf(ctx, sessionID);
  const workdir = stringOf(objectOf(event.input)["workdir"]);
  const at = tool === "shell" && workdir !== "" ? path.resolve(cwd, workdir) : cwd;
  if (tool === "shell") {
    const serial = serialDeny(event.input);
    if (serial !== undefined) throw new Error(`[dev] ${serial}`);
  }
  const input = toolCall(tool, event.input, id);
  if (tool === "shell") input["cwd"] = at;
  const verdict = check(input, at);
  if (verdict !== undefined && "block" in verdict) throw new Error(`[dev] ${utf8(verdict.block)}`);
  if (verdict !== undefined && "error" in verdict)
    await warn(ctx, sessionID, `the record guard failed, ${tool} ran unguarded: ${verdict.error}`);
};

/** Joins a post-check report to a completed call's output, or to an error's message. */
const reportAfter = (event: ToolHookAfter, report: string): void => {
  if (event.status === "completed") {
    const content = event.result.content;
    if (typeof content === "string")
      event.result.content = [
        { type: "text", text: content },
        { type: "text", text: report },
      ];
    else event.result.content = [...(content ?? []), { type: "text", text: report }];
    return;
  }
  event.error.message = event.error.message === "" ? report : `${event.error.message}\n\n${report}`;
};

/** After a shell call: compare the plans with the snapshot its pre check took and report. */
const afterTool = async (ctx: OpenCodeContext, event: ToolHookAfter): Promise<void> => {
  if (event.tool !== "shell") return;
  const cwd = await cwdOf(ctx, event.sessionID);
  const verdict = check(bashPostCall(event.id, event.status === "error"), cwd);
  if (verdict === undefined) return;
  if ("postBlock" in verdict) reportAfter(event, `[dev] ${utf8(verdict.postBlock)}`);
  else if ("error" in verdict)
    await warn(
      ctx,
      event.sessionID,
      `the plan check after the shell command failed, its changes went unchecked: ${verdict.error}`,
    );
};

/** Registers every skill, every /dev-<skill>, and the /dev-stack-* commands. */
const register = async (ctx: OpenCodeContext): Promise<void> => {
  const skills = readSkills(ROOT, SKILL_PREFIX);
  await ctx.skill.transform((editor) => {
    for (const { info } of skills) editor.add(info);
  });
  await ctx.command.transform((editor) => {
    for (const { slug, info } of skills) {
      editor.add({
        name: `${SKILL_PREFIX}${slug}`,
        ...(info.description === undefined ? {} : { description: info.description }),
        execute: async ({ sessionID, prompt }: CommandInvocation) => {
          const text = prompt.text.trim();
          const phase = gatedPhase(info.id);
          if (phase !== "") {
            const reason = await gatePhase(
              ctx,
              sessionID,
              phase,
              text,
              `command:${info.id}`,
              false,
            );
            if (reason !== undefined) {
              await ctx.session.synthetic({
                sessionID,
                text: reason,
                description: "dev-stack",
                delivery: "queue",
                resume: false,
              });
              return;
            }
          } else {
            phases.set(sessionID, { skill: slug, plans: plansIn(text) });
          }
          await ctx.session.prompt({
            sessionID,
            text: text === "" ? `Run the ${info.id} skill.` : text,
            skills: [{ id: info.id }],
            ...(phase === "" ? {} : { metadata: { [GATED_PROMPT]: true } }),
            delivery: "queue",
          });
        },
      });
    }
    for (const command of COMMANDS) {
      editor.add({
        name: command.name,
        description: command.description,
        execute: async ({ sessionID, prompt }: CommandInvocation) => {
          // A write records the user's decision; waiting for idle keeps it from racing a reading turn.
          if (command.write !== undefined) {
            try {
              await ctx.session.wait({ sessionID });
            } catch {
              // A session that cannot be waited for still records the user's command.
            }
          }
          const result = stackCommand(
            command.name,
            prompt.text.trim(),
            await cwdOf(ctx, sessionID),
            process.env,
          );
          if (result === undefined) {
            await ctx.session.synthetic({
              sessionID,
              text: `no command /${command.name}`,
              description: "dev-stack",
              delivery: "queue",
              resume: false,
            });
            return;
          }
          // A command's text is shown to the user; a write's note reaches the model as context.
          await ctx.session.synthetic({
            sessionID,
            text: result.text === "" ? "(no output)" : result.text,
            description: command.name,
            delivery: "queue",
            resume: false,
          });
          if (result.note !== undefined)
            await ctx.session.synthetic({
              sessionID,
              text: result.note,
              description: "dev-stack note",
              delivery: "queue",
              resume: false,
            });
        },
      });
    }
  });
};

/** A user's `@dev-<skill>` mention, which OpenCode resolves into a skill attachment after hooks. */
const MENTION_RE = /(^|[\s(])@(dev[-:][a-z0-9-]+)/gi;

/** The OpenCode plugin. `setup` registers the rules, skills, commands, and hooks. */
export const setup = async (ctx: OpenCodeContext): Promise<(() => Promise<void>) | void> => {
  const registrations: Registration[] = [];
  registrations.push(
    await ctx.session.hook("context", (event) => {
      const text = rules();
      if (event.system.some((part) => part.text.includes(`${RULES_MARK}${ROOT}`))) return;
      event.system.push({ type: "text", text });
    }),
  );

  // A user's @dev-<phase> attachment loads the skill without the skill tool, so the prompt is the
  // gate. A prompt this plugin sent after gating a typed command carries the marker and is skipped.
  registrations.push(
    await ctx.session.hook("prompt", async (event) => {
      if (event.metadata?.[GATED_PROMPT] === true) return;
      const phases = new Set<string>();
      for (const skill of event.prompt.skills ?? []) {
        const phase = gatedPhase(skill.id);
        if (phase !== "") phases.add(phase);
      }
      // An @dev-<phase> mention is resolved into a skill attachment after this hook, so the gate
      // reads the mention from the text too.
      for (const match of event.prompt.text.matchAll(MENTION_RE)) {
        const phase = gatedPhase(match[2] ?? "");
        if (phase !== "") phases.add(phase);
      }
      for (const phase of phases) {
        const reason = await gatePhase(
          ctx,
          event.sessionID,
          phase,
          event.prompt.text,
          phase,
          false,
        );
        if (reason !== undefined) throw new Error(reason);
      }
    }),
  );

  registrations.push(await ctx.tool.hook("execute.before", (event) => beforeTool(ctx, event)));
  registrations.push(await ctx.tool.hook("execute.after", (event) => afterTool(ctx, event)));

  await register(ctx);

  return async () => {
    for (const registration of registrations) await registration.dispose();
  };
};

const plugin: Plugin = { id: "dev-stack", setup };

export default plugin;
