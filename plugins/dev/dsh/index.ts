// The dev plugin's DSH (DeepSeek Harness) Host plugin: the rules as a prompt section, the skills
// registered in memory, the /dev-stack-* commands, the phase gate on a phase load, the record
// guard and serial-test check on shell and edit calls, and the post check that restores plans a
// shell call changed. It runs under Node, so it calls core in-process, as the Pi extension does;
// the DSH packages stay out of this checkout, so api.ts declares the Host API it uses.
//
// A phase load is the `skill` tool: DSH's skill tool takes only the name, so the plan a phase
// resolves is the one named by the assistant message that issued the call, else by the latest user
// message, as Pi's read gate does. A typed `/dev-<phase>` is the harness's own invocation path and
// has no plan text the gate could read, so the pre-step listener refuses the turn rather than load
// a gated phase ungated.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stackCommand } from "../core/stack-command.ts";
import { COMMANDS, RULE_FILES, rulesText } from "../hooks/commands.ts";
import type {
  DshContext,
  Message,
  PreStepDecision,
  PreToolDecision,
  Session,
  SessionEvent,
  ToolExecution,
} from "./api.ts";
import { inject, messageText } from "./api.ts";

export { inject };

import {
  bashPostCall,
  check,
  failedClosed,
  gatedPhase,
  planText,
  serialDeny,
  skillCall,
  toolCall,
  typedPhase,
} from "./gate.ts";
import { readSkills } from "./skills.ts";

/** The plugin's install root: `dist/dev` in the built plugin, `plugins/dev` from the sources. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The prefix the registered skills carry, so this plugin's names stay to itself. */
const SKILL_PREFIX = "dev-";

/** The rules, read once; a failed read is retried on the next assembly. */
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

/** What the latest user and assistant messages said, for the gate's plan resolution. */
type Seen = { user: string; assistant: string };
const seen = new WeakMap<Session, Seen>();

const seenOf = (session: Session): Seen => {
  const current = seen.get(session);
  if (current !== undefined) return current;
  const fresh: Seen = { user: "", assistant: "" };
  seen.set(session, fresh);
  return fresh;
};

const observe = (session: Session, event: SessionEvent): void => {
  const state = seenOf(session);
  if (event.type === "user/message") {
    const text = messageText(event.data as Message);
    if (text !== "") state.user = text;
    return;
  }
  if (event.type !== "assistant/message") return;
  const data = event.data as { message?: Message } | undefined;
  const text = messageText(data?.message);
  if (text !== "") state.assistant = text;
};

/** The refusal the phase gate shows when it blocks a phase load. */
const refusal = (what: string, why: string): string =>
  `[dev] ${what} was not entered: ${why}\n\nThe dev plugin's phase gate refused it. Tell the user and stop; do not work around it.`;

/** A gated phase entered by the model, gated before the skill loads. */
const gateSkill = (ctx: DshContext, exec: ToolExecution): PreToolDecision | undefined => {
  const args = exec.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const name = (args as Record<string, unknown>)["name"];
  if (typeof name !== "string") return undefined;
  const phase = gatedPhase(name);
  if (phase === "") return undefined;
  const agent = exec.agent;
  if (agent === undefined) return undefined;
  const state = seenOf(agent.session);
  const hint = planText(state.assistant, state.user);
  const verdict = check(
    skillCall(phase, hint, exec.callId),
    ctx.workingDirectory.get(agent.session),
  );
  if (verdict === undefined) return undefined;
  if ("block" in verdict) return { kind: "deny", reason: refusal(`/${phase}`, verdict.block) };
  if ("error" in verdict)
    return { kind: "deny", reason: refusal(`/${phase}`, failedClosed(verdict.error)) };
  return undefined;
};

/** The record guard, the serial-test check, and the post check, on the three mutator tools. */
const gateMutator = (ctx: DshContext, exec: ToolExecution): PreToolDecision | undefined => {
  const agent = exec.agent;
  if (agent === undefined) return undefined;
  const tool = exec.name;
  if (tool !== "bash" && tool !== "write" && tool !== "edit") return undefined;
  const cwd = ctx.workingDirectory.get(agent.session);
  if (tool === "bash") {
    const serial = serialDeny(exec.arguments);
    if (serial !== undefined) return { kind: "deny", reason: `[dev] ${serial}` };
  }
  const verdict = check(toolCall(tool, exec.arguments, exec.callId), cwd);
  if (verdict !== undefined && "block" in verdict)
    return { kind: "deny", reason: `[dev] ${verdict.block}` };
  // A guard or check that could not run passes the call with a warning, as a failed hook does.
  return undefined;
};

/** A typed gated phase the gate refuses: the turn ends blocked rather than load it ungated. */
const typedGate = (ctx: DshContext, messages: readonly Message[], agent: Session): string =>
  (() => {
    for (const message of messages) {
      const text = messageText(message);
      const phase = typedPhase(text);
      if (phase === "") continue;
      const verdict = check(
        { hook_event_name: "UserPromptSubmit", prompt: text },
        ctx.workingDirectory.get(agent),
      );
      if (verdict !== undefined) return phase;
    }
    return "";
  })();

/**
 * Registers the plugin on `ctx`: one prompt section, every skill, every /dev-stack-* command, and
 * the listeners that gate a phase load, the mutator calls, and a typed gated phase. The Host
 * disposes every registration with this plugin's context.
 */
export function apply(ctx: DshContext): void {
  ctx.systemPrompt.section({
    name: "dev-stack:rules",
    order: 8000,
    text: () => rules(),
  });

  for (const { registration } of readSkills(ROOT, SKILL_PREFIX)) ctx.skills.register(registration);

  for (const command of COMMANDS) {
    ctx.commands.register({
      name: command.name,
      description: command.description,
      input: { hint: command.argumentHint },
      handler: async ({ agent, rawInput }) => {
        // A write records the user's decision; waiting for idle keeps it from racing a reading turn.
        if (command.write !== undefined) await agent.whenIdle();
        const result = stackCommand(
          command.name,
          rawInput.trim(),
          ctx.workingDirectory.get(agent.session),
          process.env,
        );
        if (result === undefined) return { kind: "error", text: `no command /${command.name}` };
        return { kind: "success", text: result.text === "" ? "(no output)" : result.text };
      },
    });
  }

  ctx.on("session/event", observe);

  ctx.on("agent/pre-step", async ({ agent, messages }, next): Promise<PreStepDecision> => {
    // The entering prompt is the fallback plan text for a phase load later in this turn.
    const state = seenOf(agent.session);
    for (const message of messages) {
      const text = messageText(message);
      if (text !== "") state.user = text;
    }
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    // A typed gated phase: the harness injects the skill without the skill tool, so refusing the
    // turn is the only verdict that keeps it unloaded.
    return typedGate(ctx, decision.messages, agent.session) === "" ? decision : { kind: "reject" };
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    const denied = exec.name === "skill" ? gateSkill(ctx, exec) : gateMutator(ctx, exec);
    if (denied !== undefined) return denied;
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== "bash" || exec.agent === undefined) return decision;
    const verdict = check(
      bashPostCall(exec.callId, result.isError === true),
      ctx.workingDirectory.get(exec.agent.session),
    );
    if (verdict === undefined || !("postBlock" in verdict)) return decision;
    // The report joins the call's own output, so the model learns what was restored.
    const report = { type: "text" as const, text: `[dev] ${verdict.postBlock}` };
    return { kind: "accept", content: [...(result.content ?? []), report] };
  });
}
