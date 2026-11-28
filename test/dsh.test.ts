import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  Agent,
  CommandDefinition,
  DshContext,
  PreStepDecision,
  PromptSection,
  SkillRegistration,
  UserMessage,
} from "../plugins/dev/dsh/api.ts";
import { messageText } from "../plugins/dev/dsh/api.ts";
import { gatedPhase, planText, toolCall, typedPhase } from "../plugins/dev/dsh/gate.ts";
import { apply } from "../plugins/dev/dsh/index.ts";
import { planText as planFixture, repo, tmp, write } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = path.join(ROOT, "plugins/dev");

type Handler = (...args: never[]) => unknown;

/** A Host context that records what `apply` registers and keeps its listeners by event name. */
const host = (cwd = ROOT) => {
  const sections: PromptSection[] = [];
  const skills: SkillRegistration[] = [];
  const commands: CommandDefinition[] = [];
  const handlers = new Map<string, Handler>();
  const ctx = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
    systemPrompt: {
      section: (section: PromptSection) => {
        sections.push(section);
        return () => {};
      },
    },
    skills: {
      register: (skill: SkillRegistration) => {
        skills.push(skill);
        return () => {};
      },
    },
    commands: {
      register: (command: CommandDefinition) => {
        commands.push(command);
        return () => {};
      },
    },
    workingDirectory: { get: () => cwd },
  } as unknown as DshContext;
  return { ctx, sections, skills, commands, handlers };
};

const agent = (injected: UserMessage[] = []): Agent => ({
  session: { header: { cwd: ROOT } },
  whenIdle: async () => {},
  inject: (message) => {
    injected.push(message);
  },
});

const listener = (handlers: Map<string, Handler>, event: string) => {
  const found = handlers.get(event);
  assert.ok(found !== undefined, `no ${event} listener`);
  return found as unknown as (...args: unknown[]) => Promise<unknown>;
};

const SKILLS = [
  "autopilot",
  "create-issue",
  "create-pr",
  "design-feature",
  "design-infra",
  "design-system",
  "execute-feature",
  "explore",
  "fix-bug",
  "handoff",
  "recap",
  "review-change",
  "review-code",
  "review-feature",
  "review-infra",
  "review-system",
  "run-stack",
  "split-pr-atomic",
];

const COMMAND_NAMES = [
  "dev-stack-check",
  "dev-stack-list",
  "dev-stack-next",
  "dev-stack-reopen",
  "dev-stack-resume",
  "dev-stack-review",
  "dev-stack-stop",
];

test("registers every skill under the dev- name, with its body and a real path", () => {
  const { ctx, skills } = host();
  apply(ctx);
  assert.deepEqual(
    skills.map((s) => s.name),
    SKILLS.map((slug) => `dev-${slug}`),
  );
  for (const skill of skills) {
    assert.ok(skill.description.length > 20, `${skill.name} has no description`);
    assert.ok(
      skill.content.startsWith("# /"),
      `${skill.name} body starts ${skill.content.slice(0, 20)}`,
    );
    assert.ok(!skill.content.startsWith("---"), `${skill.name} body keeps its frontmatter`);
    assert.ok(skill.path !== undefined && fs.existsSync(skill.path), `${skill.name} path`);
    assert.equal(skill.resourceBase?.kind, "directory");
  }
});

test("registers the rules as one prompt section naming $DEV_LIB", () => {
  const { ctx, sections } = host();
  apply(ctx);
  const rules = sections.find((s) => s.name === "dev-stack:rules");
  assert.ok(rules !== undefined, "no dev-stack:rules section");
  const text = typeof rules.text === "function" ? rules.text(undefined) : rules.text;
  assert.ok(text.startsWith(`$DEV_LIB is ${PLUGIN}:`), text.slice(0, 80));
  assert.ok(text.includes(`Contents of ${PLUGIN}/rules/CORE.md:`));
  assert.ok(text.includes(`Contents of ${PLUGIN}/rules/CODING.md:`));
  assert.ok(text.includes("# Dev Rules"));
});

test("registers the /dev-stack-* commands with their argument hints", () => {
  const { ctx, commands } = host();
  apply(ctx);
  assert.deepEqual(commands.map((c) => c.name).sort(), COMMAND_NAMES);
  for (const command of commands) {
    assert.ok(command.description.length > 10, `${command.name} has no description`);
    assert.ok(command.input?.hint !== undefined, `${command.name} has no input hint`);
  }
});

test("a command with a bad argument prints its usage instead of running", async () => {
  const { ctx, commands } = host();
  apply(ctx);
  const next = commands.find((c) => c.name === "dev-stack-next");
  assert.ok(next !== undefined);
  const result = await next.handler({ agent: agent(), rawInput: "   " });
  assert.equal(result.kind, "success");
  assert.ok(result.kind === "success" && result.text?.startsWith("Usage: /dev-stack-next"));
});

test("a write's note reaches the model as context, not as the gate's plan text", async () => {
  const dir = repo(tmp("dev-dsh-note"));
  const plan = path.join(dir, "docs/plans/7_note/pr1.spec.md");
  write(
    plan,
    planFixture({ Status: "planning", Spec: "-", Tip: "-", Type: "feature", Base: "main" }),
  );
  const { ctx, commands, handlers } = host(dir);
  apply(ctx);
  const injected: UserMessage[] = [];
  const stopping = agent(injected);
  const stop = commands.find((c) => c.name === "dev-stack-stop");
  assert.ok(stop !== undefined);
  const result = await stop.handler({ agent: stopping, rawInput: `${plan} needs a decision` });
  assert.equal(result.kind, "success");
  assert.equal(injected.length, 1);
  assert.equal(injected[0]?.role, "user");
  assert.equal(injected[0]?.source?.kind, "dev-stack");
  assert.match(
    messageText(injected[0]),
    /The user stopped .*pr1\.spec\.md with dev-stack\.js stop: needs a decision/,
  );

  // The note is context for the model, not the user's words: it names a plan, but a gated phase
  // still has no plan text the gate may resolve.
  await listener(handlers, "session/event")(stopping.session, {
    type: "user/message",
    seq: 1,
    data: injected[0],
  });
  const decision = (await listener(handlers, "tools/pre-execute")(
    {
      name: "skill",
      callId: "call-1",
      arguments: { name: "dev-execute-feature" },
      agent: stopping,
    },
    async () => ({ kind: "allow" }),
  )) as { kind: string; reason?: string };
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason ?? "", /none was named/);
});

test("a gated phase load with no plan named is denied, with the reason", async () => {
  const { ctx, handlers } = host();
  apply(ctx);
  const preExecute = listener(handlers, "tools/pre-execute");
  const decision = (await preExecute(
    {
      name: "skill",
      callId: "call-1",
      arguments: { name: "dev-execute-feature" },
      agent: agent(),
    },
    async () => ({ kind: "allow" }),
  )) as { kind: string; reason?: string };
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason ?? "", /\[dev\] \/execute-feature was not entered/);
  assert.match(decision.reason ?? "", /none was named/);
});

test("a @ plan path in the user's message resolves in the working directory", async () => {
  const dir = repo(tmp("dev-dsh-path"));
  const plan = path.join(dir, "docs/plans/12_path/pr1.spec.md");
  write(
    plan,
    planFixture(
      {
        Issue: "#12",
        Type: "feature",
        Status: "planning",
        Spec: "-",
        Tip: "-",
        Base: "main",
        Branch: "feat/path",
      },
      [
        "## Goal",
        "g",
        "## Acceptance Criteria",
        "AC-1 — a",
        "  Source: s",
        "  Success: ok",
        "  Failure: fail",
        "## Test Cases",
        "TC-1 — t",
        "  Proves: AC-1",
        "  Fixture: f",
        "  Action: a",
        "  Expected: e",
        "## Implementation Steps",
        "ST-1 — s — satisfies TC-1",
        "  PC-1 — p — Check: true",
        "",
      ].join("\n"),
    ),
  );
  const { ctx, handlers } = host(dir);
  apply(ctx);
  const say = async (text: string) => {
    const one = agent();
    await listener(handlers, "session/event")(one.session, {
      type: "user/message",
      seq: 1,
      data: { role: "user", content: [{ type: "text", text }] },
    });
    return (await listener(handlers, "tools/pre-execute")(
      {
        name: "skill",
        callId: "call-1",
        arguments: { name: "dev-review-feature" },
        agent: one,
      },
      async () => ({ kind: "allow" }),
    )) as { kind: string; reason?: string };
  };
  const allow = await say("/dev-review-feature @docs/plans/12_path/pr1.spec.md");
  assert.equal(allow.kind, "allow", JSON.stringify(allow));
  assert.equal((await say("/dev-review-feature @./docs/plans/12_path/pr1.spec.md")).kind, "allow");
  const missing = await say("/dev-review-feature @docs/plans/12_path/pr9.spec.md");
  assert.equal(missing.kind, "deny", JSON.stringify(missing));
  assert.match(missing.reason ?? "", /not found/);
  const bare = await say("/dev-review-feature docs/plans/12_path/pr1.spec.md");
  assert.equal(bare.kind, "deny", "a relative path without @ does not resolve");
  assert.match(bare.reason ?? "", /none was named|not found/);
});

test("a non-gated skill load is passed through", async () => {
  const { ctx, handlers } = host();
  apply(ctx);
  const preExecute = listener(handlers, "tools/pre-execute");
  const decision = await preExecute(
    { name: "skill", callId: "c", arguments: { name: "dev-explore" }, agent: agent() },
    async () => ({ kind: "allow" }),
  );
  assert.deepEqual(decision, { kind: "allow" });
});

test("a jest command without its serial flag is denied", async () => {
  const { ctx, handlers } = host();
  apply(ctx);
  const preExecute = listener(handlers, "tools/pre-execute");
  const decision = (await preExecute(
    { name: "bash", callId: "c", arguments: { command: "npx jest src" }, agent: agent() },
    async () => ({ kind: "allow" }),
  )) as { kind: string; reason?: string };
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason ?? "", /--runInBand/);
});

test("a typed gated phase that the gate refuses rejects the turn", async () => {
  const { ctx, handlers } = host();
  apply(ctx);
  const preStep = listener(handlers, "agent/pre-step");
  const messages = [
    { content: [{ type: "text", text: "/dev-review-code docs/plans/0_x/pr1.spec.md" }] },
  ];
  const decision = (await preStep({ agent: agent(), messages }, async () => ({
    kind: "enter",
    messages,
  }))) as PreStepDecision;
  assert.deepEqual(decision, { kind: "reject" });
});

test("a typed non-gated phase enters unchanged", async () => {
  const { ctx, handlers } = host();
  apply(ctx);
  const preStep = listener(handlers, "agent/pre-step");
  const messages = [{ content: [{ type: "text", text: "/dev-design-feature add caching" }] }];
  const decision = await preStep({ agent: agent(), messages }, async () => ({
    kind: "enter",
    messages,
  }));
  assert.deepEqual(decision, { kind: "enter", messages });
});

test("names map to phases exactly, and tool arguments map to Claude-shaped calls", () => {
  assert.equal(gatedPhase("dev-review-code"), "review-code");
  assert.equal(gatedPhase("dev:review-code"), "review-code");
  assert.equal(gatedPhase("review-code"), "");
  assert.equal(gatedPhase("dev-explore"), "");
  assert.equal(gatedPhase("dev-review-codebase"), "");
  assert.equal(typedPhase("/dev-execute-feature docs/plans/0_x/pr1.spec.md"), "execute-feature");
  assert.equal(typedPhase("see dev-execute-feature"), "");
  const bash = toolCall("bash", { command: "ls" }, "c1");
  assert.equal(bash["tool_name"], "Bash");
  assert.deepEqual(bash["tool_input"], { command: "ls" });
  const write = toolCall("write", { file_path: "/a", content: "b" }, "c2");
  assert.equal(write["tool_name"], "Write");
  assert.deepEqual(write["tool_input"], { file_path: "/a", content: "b" });
  const edit = toolCall("edit", { file_path: "/a", old_string: "b", new_string: "c" }, "c3");
  assert.equal(edit["tool_name"], "Edit");
  assert.deepEqual(edit["tool_input"], { file_path: "/a", old_string: "b", new_string: "c" });
});

test("the plan text prefers the assistant message only when it names a plan", () => {
  assert.equal(
    planText("editing docs/plans/12_x/pr1.spec.md", "user text"),
    "editing docs/plans/12_x/pr1.spec.md",
  );
  assert.equal(
    planText("no plan here", "run docs/plans/12_x/pr1.spec.md"),
    "run docs/plans/12_x/pr1.spec.md",
  );
});
