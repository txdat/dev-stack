// The OpenCode plugin (opencode/index.ts) driven through a stand-in plugin context: its hooks run
// with fake tool calls and a scratch repository. OpenCode loads the built plugin from
// dist/dev/opencode; this test runs the sources.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { devStack } from "../plugins/dev/core/stack.ts";
import type {
  CommandDefinition,
  OpenCodeContext,
  SkillInfo,
  ToolHookAfter,
  ToolHookBefore,
} from "../plugins/dev/opencode/api.ts";
import {
  messageText,
  patchTouchesGuarded,
  plansIn,
  planText,
} from "../plugins/dev/opencode/gate.ts";
import plugin, { setup } from "../plugins/dev/opencode/index.ts";
import { exec, planText as planFixture, read, repo, run, tmp, write } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = path.join(ROOT, "plugins/dev");

type Handler = (...args: never[]) => unknown;

let sessions = 0;

/** A plugin context that records registrations and keeps its hooks, messages, and outputs. */
const host = async (cwd = ROOT) => {
  const sessionID = `s${++sessions}`;
  const skills: SkillInfo[] = [];
  const commands: CommandDefinition[] = [];
  const hooks = new Map<string, Handler>();
  const synthetics: { text: string; description?: string }[] = [];
  const prompts: {
    text: string;
    skills?: readonly { id: string }[];
    metadata?: Record<string, unknown>;
  }[] = [];
  let messages: { id?: string; type?: string; text?: string; content?: unknown }[] = [];
  let sessionCwd = cwd;

  const registration = { dispose: async () => {} };
  const ctx = {
    location: { directory: cwd },
    options: {},
    skill: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          list: () => skills,
          get: (id: string) => skills.find((s) => s.id === id),
          add: (skill: SkillInfo) => skills.push(skill),
          update: () => {},
          remove: () => {},
        });
        return registration;
      },
      reload: async () => {},
    },
    command: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (command: CommandDefinition) => commands.push(command) });
        return registration;
      },
      reload: async () => {},
    },
    session: {
      get: async () => ({ location: { directory: sessionCwd } }),
      context: async () => messages,
      prompt: async (input: {
        text: string;
        skills?: readonly { id: string }[];
        metadata?: Record<string, unknown>;
      }) => {
        prompts.push(input);
      },
      synthetic: async (input: { text: string; description?: string }) => {
        synthetics.push(input);
      },
      wait: async () => {},
      hook: async (name: string, cb: Handler) => {
        hooks.set(name, cb);
        return registration;
      },
    },
    tool: {
      hook: async (name: string, cb: Handler) => {
        hooks.set(name, cb);
        return registration;
      },
    },
  } as unknown as OpenCodeContext;
  await setup(ctx);
  return {
    ctx,
    sessionID,
    skills,
    commands,
    hooks,
    synthetics,
    prompts,
    setMessages: (next: typeof messages) => {
      messages = next;
    },
    setCwd: (next: string) => {
      sessionCwd = next;
    },
  };
};

const hook = (hooks: Map<string, Handler>, name: string): Handler => {
  const found = hooks.get(name);
  assert.ok(found !== undefined, `no ${name} hook`);
  return found;
};

/** Runs the before hook; returns the refusal reason, or undefined when the call is allowed. */
const before = async (h: Awaited<ReturnType<typeof host>>, event: Partial<ToolHookBefore>) => {
  try {
    await hook(
      h.hooks,
      "execute.before",
    )({
      tool: "shell",
      input: {},
      sessionID: h.sessionID,
      agent: "build",
      messageID: "a",
      id: "call",
      codemode: false,
      ...event,
    } as never);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const after = async (h: Awaited<ReturnType<typeof host>>, event: ToolHookAfter) => {
  await hook(h.hooks, "execute.after")(event as never);
};

const context = async (
  h: Awaited<ReturnType<typeof host>>,
  system: { type: "text"; text: string }[],
) => {
  await hook(h.hooks, "context")({ sessionID: h.sessionID, system } as never);
};

const promptHook = async (
  h: Awaited<ReturnType<typeof host>>,
  event: {
    text: string;
    skills?: readonly { id: string }[];
    metadata?: Record<string, unknown>;
  },
) => {
  try {
    await hook(
      h.hooks,
      "prompt",
    )({
      sessionID: h.sessionID,
      messageID: "u",
      prompt: { text: event.text, skills: event.skills },
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      delivery: "steer",
    } as never);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const command = async (h: Awaited<ReturnType<typeof host>>, name: string, text: string) => {
  const found = h.commands.find((c) => c.name === name);
  assert.ok(found !== undefined, `no command ${name}`);
  await found.execute({ sessionID: h.sessionID, prompt: { text }, delivery: "steer" });
};

const SKILLS = [
  "autopilot",
  "create-issue",
  "create-pr",
  "design-feature",
  "design-infra",
  "design-system",
  "execute-feature",
  "explain",
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

const GRAPH = [
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
].join("\n");

const HEADER = {
  Status: "planning",
  Spec: "-",
  Tip: "-",
  Type: "feature",
  Base: "main",
  Branch: "feat/open",
  Issue: "#12",
};

/** A repository with one planning plan at `12_open/pr1.spec.md`. */
const fixture = (name: string) => {
  const dir = repo(tmp(name));
  const plan = path.join(dir, "docs/plans/12_open/pr1.spec.md");
  write(plan, planFixture(HEADER, GRAPH));
  return { dir, plan };
};

test("registers every skill under the dev- prefix, with its body and a real path", async () => {
  const h = await host();
  assert.deepEqual(
    h.skills.map((s) => s.id),
    SKILLS.map((slug) => `dev-${slug}`),
  );
  for (const skill of h.skills) {
    assert.ok((skill.description ?? "").length > 20, `${skill.id} has no description`);
    assert.ok(
      skill.content.startsWith("# /"),
      `${skill.id} body starts ${skill.content.slice(0, 20)}`,
    );
    assert.ok(!skill.content.startsWith("---"), `${skill.id} body keeps its frontmatter`);
    assert.ok(fs.existsSync(skill.path), `${skill.id} path`);
  }
});

test("the rules reach the system prompt once, naming $DEV_LIB", async () => {
  const h = await host();
  const system: { type: "text"; text: string }[] = [];
  await context(h, system);
  assert.equal(system.length, 1);
  assert.ok(system[0]?.text.startsWith(`$DEV_LIB is ${PLUGIN}:`), system[0]?.text.slice(0, 80));
  assert.ok(system[0]?.text.includes(`Contents of ${PLUGIN}/rules/CORE.md:`));
  assert.ok(system[0]?.text.includes(`Contents of ${PLUGIN}/rules/CODING.md:`));
  await context(h, system);
  assert.equal(system.length, 1, "the rules were added twice");
});

test("registers the /dev-stack-* commands and one /dev-<skill> per skill", async () => {
  const h = await host();
  assert.deepEqual(
    h.commands
      .map((c) => c.name)
      .filter((name) => name.startsWith("dev-stack-"))
      .sort(),
    COMMAND_NAMES,
  );
  assert.deepEqual(
    h.commands
      .map((c) => c.name)
      .filter((name) => !name.startsWith("dev-stack-"))
      .sort(),
    SKILLS.map((slug) => `dev-${slug}`),
  );
  for (const command of h.commands)
    assert.ok((command.description ?? "").length > 10, command.name);
});

test("a command with a bad argument prints its usage instead of running", async () => {
  const h = await host();
  await command(h, "dev-stack-next", "   ");
  assert.equal(h.synthetics.length, 1);
  assert.match(h.synthetics[0]?.text ?? "", /^Usage: \/dev-stack-next /);
});

test("a write's note reaches the model as context, not as the gate's plan text", async () => {
  const { dir, plan } = fixture("dev-open-note");
  const h = await host(dir);
  await command(h, "dev-stack-stop", `${plan} needs a decision`);
  assert.equal(h.synthetics.length, 2);
  const note = h.synthetics[1];
  assert.equal(note?.description, "dev-stack note");
  assert.match(note?.text ?? "", /The user stopped .*pr1\.spec\.md with dev-stack\.js stop/);
  // A synthetic note is not the user's words: a gated phase still has no plan text.
  h.setMessages([{ id: "n", type: "synthetic", text: note?.text ?? "" }]);
  const reason = await before(h, { tool: "skill", input: { id: "dev-execute-feature" } });
  assert.match(reason ?? "", /none was named/);
});

test("a gated phase load with no plan named is refused, with the reason", async () => {
  const h = await host();
  const reason = await before(h, { tool: "skill", input: { id: "dev-execute-feature" } });
  assert.match(reason ?? "", /\[dev\] .*none was named/);
});

test("a @ plan path in the user's message resolves in the session directory", async () => {
  const { dir } = fixture("dev-open-path");
  const say = async (text: string) => {
    const h = await host(dir);
    h.setMessages([
      { id: "u", type: "user", text },
      { id: "a", type: "assistant", content: [{ type: "text", text: "Loading review-feature" }] },
    ]);
    return before(h, { tool: "skill", input: { id: "dev-review-feature" }, messageID: "a" });
  };
  assert.equal(
    await say("/dev-review-feature @docs/plans/12_open/pr1.spec.md"),
    undefined,
    "the @ mention resolved",
  );
  assert.equal(await say("/dev-review-feature @./docs/plans/12_open/pr1.spec.md"), undefined);
  assert.match(
    (await say("/dev-review-feature @docs/plans/12_open/pr9.spec.md")) ?? "",
    /not found/,
  );
  assert.match(
    (await say("/dev-review-feature docs/plans/12_open/pr1.spec.md")) ?? "",
    /none was named|not found/,
    "a relative path without @ does not resolve",
  );
});

test("the issuing assistant message names the plan when the user's prompt does not", async () => {
  const { dir, plan } = fixture("dev-open-issuer");
  const h = await host(dir);
  h.setMessages([
    { id: "u", type: "user", text: "go on" },
    { id: "a", type: "assistant", content: [{ type: "text", text: `Reviewing ${plan}` }] },
  ]);
  assert.equal(
    await before(h, { tool: "skill", input: { id: "dev-review-feature" }, messageID: "a" }),
    undefined,
  );
});

test("a non-gated skill load is passed through", async () => {
  const h = await host();
  assert.equal(await before(h, { tool: "skill", input: { id: "dev-explore" } }), undefined);
});

test("a gated phase reload continues on the same plans until a stop", async () => {
  const { dir, plan } = fixture("dev-open-continue");
  const h = await host(dir);
  h.setMessages([{ id: "u", type: "user", text: `review ${plan}` }]);
  assert.equal(
    await before(h, { tool: "skill", input: { id: "dev-review-feature" }, messageID: "u" }),
    undefined,
  );
  // The plan moved past review-feature; reading the same skill again continues the phase.
  run(devStack, ["review", plan, "ready"], { cwd: dir });
  run(devStack, ["autopilot", plan], { cwd: dir });
  run(devStack, ["approve", plan], { cwd: dir });
  h.setMessages([{ id: "u", type: "user", text: "go on" }]);
  assert.equal(
    await before(h, { tool: "skill", input: { id: "dev-review-feature" }, messageID: "u" }),
    undefined,
    "a continuation passes the moved-on status",
  );
  run(devStack, ["stop", plan, "Failed fixes: 3/3 — x"], { cwd: dir });
  assert.match(
    (await before(h, { tool: "skill", input: { id: "dev-review-feature" }, messageID: "u" })) ?? "",
    /is stopped: Failed fixes: 3\/3/,
  );
});

test("the serial-test check and the record guard refuse shell and edit calls", async () => {
  const { dir, plan } = fixture("dev-open-guard");
  const h = await host(dir);
  assert.match(
    (await before(h, { tool: "shell", input: { command: "npx jest src" } })) ?? "",
    /^\[dev\] .*jest without --runInBand/,
  );
  assert.match(
    (await before(h, {
      tool: "shell",
      input: { command: `echo x >> ${path.dirname(plan)}/log` },
    })) ?? "",
    /written only by dev-stack\.js/,
  );
  assert.match(
    (await before(h, {
      tool: "write",
      input: { path: `${path.dirname(plan)}/log`, content: "x" },
    })) ?? "",
    /written only by dev-stack\.js/,
  );
  assert.equal(
    await before(h, {
      tool: "edit",
      input: {
        path: path.join(dir, "README.md"),
        oldString: "x",
        newString: "y",
      },
    }),
    undefined,
    "a source edit passes",
  );
  assert.equal(await before(h, { tool: "shell", input: { command: "ls" } }), undefined);
});

test("the shell post check restores a plan change and joins the report", async () => {
  const { dir, plan } = fixture("dev-open-post");
  const h = await host(dir);
  run(devStack, ["review", plan, "ready"], { cwd: dir });
  run(devStack, ["autopilot", plan], { cwd: dir });
  run(devStack, ["approve", plan], { cwd: dir });
  const beforeText = read(plan);
  const command = `sed -i 's/^Status: auto-approved/Status: planning/' ${plan}`;
  assert.equal(await before(h, { tool: "shell", input: { command }, id: "r1" }), undefined);
  exec(["bash", "-c", command], { cwd: dir });
  const result: { content?: string | readonly { type: string; text: string }[] } = {
    content: "out",
  };
  const event = {
    tool: "shell",
    id: "r1",
    sessionID: h.sessionID,
    status: "completed",
    result,
  } as unknown as ToolHookAfter;
  await after(h, event);
  const content = result.content as { type: string; text: string }[];
  assert.equal(content[0]?.text, "out");
  assert.match(content[1]?.text ?? "", /^\[dev\] [\s\S]*never returns below approved/);
  assert.equal(read(plan), beforeText);
});

test("a typed gated phase is gated before its skill is attached", async () => {
  const { dir, plan } = fixture("dev-open-command");
  const h = await host(dir);
  // A planning plan may enter review-feature; the skill is attached after the gate.
  await command(h, "dev-review-feature", `@docs/plans/12_open/pr1.spec.md`);
  assert.equal(h.synthetics.length, 0);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.prompts[0]?.skills, [{ id: "dev-review-feature" }]);
  assert.equal(h.prompts[0]?.metadata?.["dev-stack-gated"], true);

  // An auto-approved plan may not enter review-feature again.
  run(devStack, ["review", plan, "ready"], { cwd: dir });
  run(devStack, ["autopilot", plan], { cwd: dir });
  run(devStack, ["approve", plan], { cwd: dir });
  await command(h, "dev-review-feature", plan);
  assert.match(h.synthetics.at(-1)?.text ?? "", /already auto-approved/);
  assert.equal(h.prompts.length, 1, "a refused command sent a prompt");
});

test("a @dev-<phase> skill attachment runs the prompt gate unless this plugin gated it", async () => {
  const { dir, plan } = fixture("dev-open-prompt");
  const h = await host(dir);
  assert.match(
    (await promptHook(h, { text: `${plan}`, skills: [{ id: "dev-execute-feature" }] })) ?? "",
    /not approved|awaiting approval/,
  );
  assert.match(
    (await promptHook(h, { text: `@dev-execute-feature ${plan}` })) ?? "",
    /not approved|awaiting approval/,
    "an @ mention is gated from the text",
  );
  assert.equal(
    await promptHook(h, {
      text: plan,
      skills: [{ id: "dev-execute-feature" }],
      metadata: { "dev-stack-gated": true },
    }),
    undefined,
  );
  assert.equal(
    await promptHook(h, { text: "where is auth", skills: [{ id: "dev-explore" }] }),
    undefined,
  );
});

test("a patch that changes a plan is refused rather than bypass the guard", async () => {
  const h = await host();
  assert.equal(
    patchTouchesGuarded({
      patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n x\n*** End Patch\n",
    }),
    false,
  );
  assert.match(
    (await before(h, {
      tool: "patch",
      input: {
        patchText:
          "*** Begin Patch\n*** Update File: docs/plans/1_x/pr1.spec.md\n@@\n x\n*** End Patch\n",
      },
    })) ?? "",
    /Use the edit or write tool/,
  );
  assert.equal(
    await before(h, {
      tool: "patch",
      input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n x\n*** End Patch\n" },
    }),
    undefined,
  );
});

test("names map to phases exactly, and messages and plans parse", () => {
  assert.equal(
    planText("editing docs/plans/12_x/pr1.spec.md", "user text"),
    "editing docs/plans/12_x/pr1.spec.md",
  );
  assert.equal(
    planText("no plan here", "run docs/plans/12_x/pr1.spec.md"),
    "run docs/plans/12_x/pr1.spec.md",
  );
  assert.deepEqual(plansIn("a/docs/plans/12_x/pr2.spec.md b/12_x/pr1.spec.md"), [
    "12_x/pr1.spec.md",
    "12_x/pr2.spec.md",
  ]);
  assert.equal(
    messageText({ type: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool" }] }),
    "hi",
  );
  assert.equal(messageText({ type: "user", text: " hello " }), "hello");
  assert.equal(plugin.id, "dev-stack");
});
