// Autopilot's and run-stack's delivery, end to end, through every supporting harness's own gate
// entry point: Claude Code's bin/hook.ts (the program hooks/register.ts runs), Pi's extension,
// DSH's Host plugin, OpenCode's V2 plugin, and Antigravity's bin/agy-hook.ts. Autopilot's direct-edit
// lane, autopilot's plan-backed lane, and run-stack's plan-backed lane run the real dev-stack.ts and
// dev-worktree.ts against a scratch repository, so each verdict is the gate's for plans and
// commits that real phases wrote.
//
// A harness's driver is its whole adapter surface here: the prompt that invokes an orchestrator, a
// skill load, and a Bash, Write, or Edit call. A new harness adds its driver and runs all three
// lanes, as AGENTS.md — Adding a harness requires.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type {
  Agent,
  DshContext,
  PreStepDecision,
  PreToolDecision,
  UserMessage,
} from "../plugins/dev/dsh/api.ts";
import { apply } from "../plugins/dev/dsh/index.ts";
import type {
  CommandDefinition,
  OpenCodeContext,
  SkillInfo,
  ToolHookBefore,
} from "../plugins/dev/opencode/api.ts";
import { setup as opencodeSetup } from "../plugins/dev/opencode/index.ts";
import devExtension from "../plugins/dev/pi/dev.ts";
import { exec, git, NODE, PLUGIN, planText, RUN, read, repo, tmp, write } from "./helpers.ts";

const BIN = path.join(PLUGIN, "bin");
const HOOK = path.join(BIN, "hook.ts");
const AGY_HOOK = path.join(BIN, "agy-hook.ts");
const STACK = path.join(BIN, "dev-stack.ts");
const WORKTREE = path.join(BIN, "dev-worktree.ts");

/** One gate verdict as its harness reports it: allowed, or refused with the reason it shows. */
type Verdict = { allowed: boolean; reason: string };
const PASS: Verdict = { allowed: true, reason: "" };
const refusal = (reason: string): Verdict => ({ allowed: false, reason });

/** What a lane needs from a harness: its gate entry point, as its adapter reaches the shared core. */
type Harness = {
  /** The user invokes `autopilot` or `run-stack` with these arguments. */
  invoke(orchestrator: "autopilot" | "run-stack", args: string): Promise<Verdict>;
  /** The model loads this plugin's skill `name`, its call naming `text`: a plan for a gated phase. */
  skill(name: string, text: string, cwd?: string): Promise<Verdict>;
  bash(command: string, cwd?: string): Promise<Verdict>;
  write(file: string, content: string, cwd?: string): Promise<Verdict>;
  edit(file: string, oldText: string, newText: string, cwd?: string): Promise<Verdict>;
};

const allowed = async (label: string, verdict: Promise<Verdict>): Promise<void> => {
  const got = await verdict;
  assert.equal(got.allowed, true, `${label}: refused: ${got.reason}`);
};

const refused = async (label: string, verdict: Promise<Verdict>, why: RegExp): Promise<void> => {
  const got = await verdict;
  assert.equal(got.allowed, false, `${label}: allowed`);
  assert.match(got.reason, why, label);
};

/**
 * Runs a shell command under the harness's verdict, as that harness would: a refused call never
 * runs, so its effect on the repository is part of what a lane proves.
 */
const runs = async (
  label: string,
  h: Harness,
  command: string,
  cwd: string,
): Promise<{ out: string }> => {
  await allowed(label, h.bash(command, cwd));
  const r = exec(["bash", "-c", command], { cwd });
  assert.equal(r.code, 0, `${label}: ${r.all}`);
  return r;
};

/** Writes a file under its harness's verdict, as that harness would: only when allowed. */
const writes = async (
  label: string,
  h: Harness,
  file: string,
  content: string,
  cwd?: string,
): Promise<void> => {
  await allowed(label, h.write(file, content, cwd));
  write(file, content);
};

/** Applies one edit under its harness's verdict, as that harness would: only when allowed. */
const edits = async (
  label: string,
  h: Harness,
  file: string,
  oldText: string,
  newText: string,
  cwd?: string,
): Promise<void> => {
  await allowed(label, h.edit(file, oldText, newText, cwd));
  const before = read(file);
  assert.equal(before.split(oldText).length, 2, `${label}: ${oldText} does not appear once`);
  write(file, before.replace(oldText, newText));
};

/** A plan whose ID graph and schema pass review-feature's checks. */
const BODY = [
  "## Goal",
  "g",
  "## Scope",
  "in / out",
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

const FIELDS = {
  Status: "planning",
  Spec: "-",
  Tip: "-",
  Type: "feature",
  Base: "main",
  Branch: "feat/auto",
  Issue: "#12",
};

/** A fresh scratch repository with a source file and its test file, both committed on main. */
const scratch = (harness: string, lane: string): string => {
  const dir = repo(`${tmp("dev-autopilot-e2e")}/${harness}-${lane}`);
  write(path.join(dir, "src/cache.ts"), "export const cache = 1;\n");
  write(path.join(dir, "test/cache.test.ts"), "// cache tests\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return dir;
};

// ── the lanes ─────────────────────────────────────────────────────────

/**
 * Autopilot's direct-edit lane from [plan.md — Scope](../plugins/dev/rules/plan.md#scope): no
 * plan, a worktree on a feature branch, a failing test, the change, a serial test run, and a draft
 * PR. The plan gates never fire, and the plan stack stays dev-stack's and the user's.
 */
const directEdit = async (dir: string, h: Harness): Promise<void> => {
  const branch = "feat/cache";
  const plan = path.join(dir, "docs/plans/13_cache/pr1.spec.md");
  await allowed("autopilot starts", h.invoke("autopilot", "#13 make the cache configurable"));
  await allowed(
    "autopilot loads its own skill",
    h.skill("autopilot", "issue #13 make the cache configurable"),
  );
  const created = await runs(
    "autopilot creates the worktree",
    h,
    `${RUN} ${WORKTREE} create 13_cache-pr1 ${branch} main`,
    dir,
  );
  const wt = created.out.trim();
  await writes(
    "the failing test is written",
    h,
    path.join(wt, "test/cache.test.ts"),
    "export const cache = 2;\n",
    wt,
  );
  await runs(
    "the test(red) proof commit",
    h,
    "git add -A && git commit -qm 'test(red): the cache is configurable'",
    wt,
  );
  await refused(
    "a parallel test run is refused",
    h.bash("npx jest test/cache.test.ts", wt),
    /--runInBand/,
  );
  // The run itself is judged, not run: the scratch repository has no test runner to run.
  await allowed("a serial test run", h.bash("npx jest test/cache.test.ts --runInBand", wt));
  await edits(
    "the change",
    h,
    path.join(wt, "src/cache.ts"),
    "export const cache = 1;",
    "export const cache = 2;",
    wt,
  );
  await runs(
    "the implementation commit",
    h,
    "git add -A && git commit -qm 'feat: configurable cache'",
    wt,
  );
  // The push and the PR are judged, not run: there is no remote and no GitHub here.
  await allowed("the push", h.bash(`git push -u origin ${branch}`, wt));
  await allowed("the draft PR", h.bash(`gh pr create --draft --base main --head ${branch}`, wt));
  await allowed("review-change is not a gated phase", h.skill("review-change", plan, wt));
  // A refused call never runs, so the log this one is refused for writing must stay absent.
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  await refused(
    "the stack log stays dev-stack's",
    h.bash(`echo x >> ${path.dirname(plan)}/log`, wt),
    /written only by dev-stack\.js/,
  );
  assert.ok(!fs.existsSync(path.join(path.dirname(plan), "log")), "a refused call ran");
  await refused(
    "resume stays the user's",
    h.bash(`${RUN} ${STACK} resume ${plan}`, wt),
    /is the user's alone/,
  );
  await runs("autopilot removes its worktree", h, `${RUN} ${WORKTREE} remove ${wt}`, dir);
};

/**
 * The plan-backed lane both orchestrators share, from design to a reviewed plan create-pr may
 * publish. `autopilot` approves with run-stack `--auto-approve`'s `dev-stack.js approve`;
 * `run-stack` waits for the user's own `approved`.
 */
const planBacked = async (
  dir: string,
  h: Harness,
  orchestrator: "autopilot" | "run-stack",
): Promise<void> => {
  const branch = "feat/auto";
  const plan = path.join(dir, "docs/plans/12_auto/pr1.spec.md");
  const spec = planText(FIELDS, BODY);
  // run-stack drives plans design-feature already wrote; autopilot's planner writes this one.
  if (orchestrator === "run-stack") write(plan, spec);
  await allowed(
    `${orchestrator} starts`,
    h.invoke(orchestrator, orchestrator === "autopilot" ? "#12 add a cache" : plan),
  );
  await allowed("autopilot loads its own skill", h.skill("autopilot", "issue #12 add a cache"));
  if (orchestrator === "autopilot") await writes("the planner writes the plan", h, plan, spec);

  await allowed("review-feature enters on a planning plan", h.skill("review-feature", plan));
  await runs("review-feature records a ready spec", h, `${RUN} ${STACK} review ${plan} ready`, dir);
  await refused(
    "execute-feature waits for approval",
    h.skill("execute-feature", plan),
    /awaiting approval/,
  );
  await refused(
    "an agent's edit cannot set approved",
    h.edit(plan, "Status: ready", "Status: approved"),
    /Only the user sets 'Status: approved'/,
  );
  assert.match(read(plan), /^Status: ready$/m, "a refused edit ran");
  if (orchestrator === "autopilot") {
    await refused(
      "an agent's edit cannot set auto-approved",
      h.edit(plan, "Status: ready", "Status: auto-approved"),
      /Only dev-stack\.js approve sets 'Status: auto-approved'/,
    );
    assert.match(read(plan), /^Status: ready$/m, "a refused edit ran");
    await runs(
      "run-stack --auto-approve claims the stack",
      h,
      `${RUN} ${STACK} autopilot ${plan}`,
      dir,
    );
    await runs(
      "run-stack --auto-approve runs dev-stack approve",
      h,
      `${RUN} ${STACK} approve ${plan}`,
      dir,
    );
    assert.match(read(plan), /^Status: auto-approved$/m);
  } else {
    // The user approves in their editor, outside the agent's tools, and dev-stack records it.
    write(plan, read(plan).replace("Status: ready", "Status: approved"));
    await runs("dev-stack records the user's approval", h, `${RUN} ${STACK} next ${plan}`, dir);
    assert.match(read(plan), /^Status: approved$/m);
  }

  await allowed("execute-feature enters on an approved plan", h.skill("execute-feature", plan));
  await refused(
    "review-code waits for execution",
    h.skill("review-code", plan),
    /not yet implemented/,
  );
  await deliver(dir, plan, branch, h);
};

/** Executes the plan in its worktree, then reviews and publishes it as create-pr's gate allows. */
const deliver = async (dir: string, plan: string, branch: string, h: Harness): Promise<void> => {
  const created = await runs(
    "execute-feature creates the worktree",
    h,
    `${RUN} ${WORKTREE} create 12_auto-pr1 ${branch} main`,
    dir,
  );
  const wt = created.out.trim();
  // execute-feature's test-first commits, on the plan's branch.
  await writes(
    "the failing test",
    h,
    path.join(wt, "test/cache.test.ts"),
    "export const cache = 2;\n",
    wt,
  );
  await runs(
    "the test(red) proof commit",
    h,
    "git add -A && git commit -qm 'test(red): the cache is configurable'",
    wt,
  );
  await writes(
    "the implementation",
    h,
    path.join(wt, "src/cache.ts"),
    "export const cache = 2;\n",
    wt,
  );
  await runs(
    "the implementation commit",
    h,
    "git add -A && git commit -qm 'feat: configurable cache'",
    wt,
  );
  const tip = git(wt, "rev-parse", "HEAD");
  const approved = /^Status: (.*)$/m.exec(read(plan))?.[1] ?? "";
  await edits(
    "execute-feature records implemented",
    h,
    plan,
    `Status: ${approved}`,
    "Status: implemented",
  );
  await allowed(
    "review-code enters on an implemented plan with its proof",
    h.skill("review-code", plan, wt),
  );
  await runs("review-code records its pass", h, `${RUN} ${STACK} code-review ${plan} pass`, dir);
  await refused(
    "create-pr waits for the reviewed status",
    h.skill("create-pr", plan, wt),
    /run review-code first/,
  );
  await edits("review-code records reviewed", h, plan, "Status: implemented", "Status: reviewed");
  await edits("review-code records its tip", h, plan, "Tip: -", `Tip: ${tip}`);
  await allowed("create-pr enters on a reviewed plan", h.skill("create-pr", plan, wt));
  await runs("create-pr removes the worktree", h, `${RUN} ${WORKTREE} remove ${wt}`, dir);
};

// ── Claude Code ───────────────────────────────────────────────────────

/**
 * Claude Code's gate: bin/hook.js, which hooks/register.js runs for every language-model turn and
 * every Skill, Bash, and Edit or Write call, in the session's directory.
 */
const claude = (dir: string): Harness => {
  const hook = (input: unknown, cwd = dir): Verdict => {
    const r = exec([...NODE, HOOK], { cwd, input: JSON.stringify(input) });
    assert.equal(r.code, 0, `bin/hook.ts: ${r.all}`);
    if (r.out.trim() === "") return PASS;
    const out = JSON.parse(r.out) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      reason?: string;
    };
    if (out.hookSpecificOutput?.permissionDecision !== "deny") return PASS;
    return refusal(out.hookSpecificOutput.permissionDecisionReason ?? out.reason ?? "denied");
  };
  const call = (tool: string, toolInput: unknown, cwd = dir): Verdict =>
    hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_use_id: "call",
        tool_input: toolInput,
      },
      cwd,
    );
  return {
    invoke: async (orchestrator, args) =>
      hook({ hook_event_name: "UserPromptSubmit", prompt: `/dev:${orchestrator} ${args}` }),
    skill: async (name, text, cwd) => call("Skill", { skill: `dev:${name}`, arguments: text }, cwd),
    bash: async (command, cwd) => call("Bash", { command }, cwd),
    write: async (file, content, cwd) => call("Write", { file_path: file, content }, cwd),
    edit: async (file, oldText, newText, cwd) =>
      call("Edit", { file_path: file, old_string: oldText, new_string: newText }, cwd),
  };
};

// ── Pi ────────────────────────────────────────────────────────────────

/**
 * Pi's gate: the extension's `input` event for a typed phase and `tool_call` for a skill read
 * (Pi has no Skill tool, so reading `<root>/skills/<slug>/SKILL.md` loads one) and for Bash, Write,
 * and Edit. The plan a phase resolves is the one the issuing assistant message names, as run-stack
 * and autopilot name it.
 */
const pi = (dir: string): Harness => {
  type Handler = (event: never, ctx: never) => unknown;
  const handlers = new Map<string, Handler>();
  let branch: unknown[] = [];
  let notes: [string, string][] = [];
  let cwd = dir;
  devExtension({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: () => {},
    sendMessage: () => {},
    sendUserMessage: async () => {},
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  } as never);
  const ctx = {
    get cwd() {
      return cwd;
    },
    ui: { notify: (text: string, level: string) => notes.push([text, level]) },
    sessionManager: { getBranch: () => branch },
    waitForIdle: async () => {},
  };
  const fire = async (name: string, event: unknown): Promise<unknown> => {
    notes = [];
    const handler = handlers.get(name);
    assert.ok(handler !== undefined, `Pi registered no ${name} handler`);
    return handler(event as never, ctx as never);
  };
  const verdict = (result: unknown): Verdict => {
    const blocked = result as { block?: boolean; reason?: string } | undefined;
    if (blocked?.block === true) return refusal(blocked.reason ?? "blocked");
    if ((result as { action?: string } | undefined)?.action === "handled")
      return refusal(notes[0]?.[0] ?? "blocked");
    return PASS;
  };
  const call = async (event: unknown): Promise<Verdict> => verdict(await fire("tool_call", event));
  return {
    invoke: async (orchestrator, args) =>
      verdict(await fire("input", { text: `/dev:${orchestrator} ${args}` })),
    skill: async (name, text, at = dir) => {
      cwd = at;
      const id = `call-${branch.length}`;
      branch = [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "/dev:autopilot the issue" }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: `Loading ${name} on ${text}` },
              { type: "toolCall", id, name: "read" },
            ],
          },
        },
      ];
      return call({
        toolName: "read",
        toolCallId: id,
        input: { path: path.join(PLUGIN, "skills", name, "SKILL.md") },
      });
    },
    bash: async (command, at = dir) => {
      cwd = at;
      return call({ toolName: "bash", toolCallId: "bash", input: { command } });
    },
    write: async (file, content, at = dir) => {
      cwd = at;
      return call({ toolName: "write", toolCallId: "write", input: { path: file, content } });
    },
    edit: async (file, oldText, newText, at = dir) => {
      cwd = at;
      return call({
        toolName: "edit",
        toolCallId: "edit",
        input: { path: file, edits: [{ oldText, newText }] },
      });
    },
  };
};

// ── DSH ───────────────────────────────────────────────────────────────

/**
 * DSH's gate: its Host plugin's `agent/pre-step` for a typed phase, `tools/pre-execute` for the
 * `skill` tool (whose arguments are the name alone) and for `bash`, `write`, and `edit`, and
 * `session/event` for the messages the plan resolves from.
 */
const dsh = (dir: string): Harness => {
  type Handler = (...args: never[]) => unknown;
  const handlers = new Map<string, Handler>();
  let cwd = dir;
  const ctx = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
    systemPrompt: { section: () => () => {} },
    skills: { register: () => () => {} },
    commands: { register: () => () => {} },
    workingDirectory: { get: () => cwd },
  } as unknown as DshContext;
  apply(ctx);
  const agent: Agent = {
    session: { header: { cwd: dir } },
    whenIdle: async () => {},
    inject: () => {},
  };
  const listener = <T>(event: string) => {
    const handler = handlers.get(event);
    assert.ok(handler !== undefined, `DSH registered no ${event} listener`);
    return handler as unknown as T;
  };
  const emit = (event: { type: string; seq: number; data: unknown }): void =>
    listener<(session: unknown, e: unknown) => void>("session/event")(agent.session, event);
  const preExecute = async (name: string, args: unknown): Promise<Verdict> => {
    const decision = await listener<
      (exec: unknown, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
    >("tools/pre-execute")({ name, arguments: args, agent, callId: "call" }, async () => ({
      kind: "allow",
    }));
    return decision.kind === "deny" ? refusal(decision.reason) : PASS;
  };
  return {
    invoke: async (orchestrator, args) => {
      const messages: UserMessage[] = [
        { role: "user", content: [{ type: "text", text: `/dev-${orchestrator} ${args}` }] },
      ];
      const decision = await listener<
        (
          payload: { agent: Agent; messages: UserMessage[] },
          next: () => Promise<PreStepDecision>,
        ) => Promise<PreStepDecision>
      >("agent/pre-step")({ agent, messages }, async () => ({ kind: "enter", messages }));
      return decision.kind === "reject" ? refusal("the turn was rejected") : PASS;
    },
    skill: async (name, text, at = dir) => {
      cwd = at;
      emit({
        type: "user/message",
        seq: 1,
        data: { role: "user", content: [{ type: "text", text: "/dev-autopilot the issue" }] },
      });
      emit({
        type: "assistant/message",
        seq: 2,
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Loading ${name} on ${text}` }],
          },
        },
      });
      return preExecute("skill", { name: `dev-${name}` });
    },
    bash: async (command, at = dir) => {
      cwd = at;
      return preExecute("bash", { command });
    },
    write: async (file, content, at = dir) => {
      cwd = at;
      return preExecute("write", { file_path: file, content });
    },
    edit: async (file, oldText, newText, at = dir) => {
      cwd = at;
      return preExecute("edit", { file_path: file, old_string: oldText, new_string: newText });
    },
  };
};

// ── OpenCode ──────────────────────────────────────────────────────────

let openCodeSessions = 0;

/**
 * OpenCode's gate: its V2 plugin's `execute.before` for the `skill` tool and for `shell`, `write`,
 * and `edit`, with `session.context` supplying the messages a skill call resolves its plan from.
 * A typed `/dev-<skill>` is a command whose executor runs the same phase gate.
 */
const opencode = (dir: string): Harness => {
  type Handler = (...args: never[]) => unknown;
  const sessionID = `oc${++openCodeSessions}`;
  const hooks = new Map<string, Handler>();
  const commands: CommandDefinition[] = [];
  const skills: SkillInfo[] = [];
  const synthetics: { text: string }[] = [];
  let cwd = dir;
  let messages: { id?: string; type?: string; text?: string; content?: unknown }[] = [];
  const registration = { dispose: async () => {} };
  const ctx = {
    location: { directory: dir },
    options: {},
    skill: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          list: () => skills,
          get: () => undefined,
          add: (s: SkillInfo) => skills.push(s),
          update: () => {},
          remove: () => {},
        });
        return registration;
      },
      reload: async () => {},
    },
    command: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (c: CommandDefinition) => commands.push(c) });
        return registration;
      },
      reload: async () => {},
    },
    session: {
      get: async () => ({ location: { directory: cwd } }),
      context: async () => messages,
      prompt: async () => {},
      synthetic: async (input: { text: string }) => {
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
  const ready = opencodeSetup(ctx);
  const hook = async (name: string): Promise<Handler> => {
    await ready;
    const found = hooks.get(name);
    assert.ok(found !== undefined, `OpenCode registered no ${name} hook`);
    return found;
  };
  const call = async (event: Partial<ToolHookBefore>): Promise<Verdict> => {
    try {
      await (await hook("execute.before"))({
        tool: "shell",
        input: {},
        sessionID,
        agent: "build",
        messageID: "a",
        id: "call",
        codemode: false,
        ...event,
      } as never);
      return PASS;
    } catch (e) {
      return refusal(e instanceof Error ? e.message : String(e));
    }
  };
  return {
    invoke: async (orchestrator, args) => {
      await ready;
      const found = commands.find((c) => c.name === `dev-${orchestrator}`);
      assert.ok(found !== undefined, `OpenCode registered no /dev-${orchestrator}`);
      synthetics.length = 0;
      await found.execute({ sessionID, prompt: { text: args }, delivery: "steer" });
      const refused = synthetics.find((s) => s.text.startsWith("[dev]"));
      return refused === undefined ? PASS : refusal(refused.text);
    },
    skill: async (name, text, at = dir) => {
      cwd = at;
      if (name !== "autopilot") {
        messages = [
          { id: "u", type: "user", text: "/dev-autopilot the issue" },
          {
            id: "a",
            type: "assistant",
            content: [
              { type: "text", text: `Loading ${name} on ${text}` },
              { type: "tool", id: "call", name: "skill" },
            ],
          },
        ];
      } else {
        messages = [{ id: "u", type: "user", text: `/dev-autopilot ${text}` }];
      }
      return call({ tool: "skill", input: { id: `dev-${name}` }, messageID: "a" });
    },
    bash: async (command, at = dir) => {
      cwd = at;
      return call({ tool: "shell", input: { command } });
    },
    write: async (file, content, at = dir) => {
      cwd = at;
      return call({ tool: "write", input: { path: file, content } });
    },
    edit: async (file, oldText, newText, at = dir) => {
      cwd = at;
      return call({ tool: "edit", input: { path: file, oldString: oldText, newString: newText } });
    },
  };
};

// ── Antigravity ───────────────────────────────────────────────────────

/**
 * Antigravity's gate: bin/agy-hook.js, which translates each PreToolUse `read_file`, `run_command`,
 * `write_file`, or `edit_file` into the shared gate's call, with `lastUserInput` as the text a
 * phase's plan resolves from.
 */
const antigravity = (dir: string): Harness => {
  const hook = (payload: unknown, cwd = dir): Verdict => {
    const r = exec([...NODE, AGY_HOOK], { cwd, input: JSON.stringify(payload) });
    assert.equal(r.code, 0, `bin/agy-hook.ts: ${r.all}`);
    const out = JSON.parse(r.out) as { decision?: string; reason?: string };
    return out.decision === "deny" ? refusal(out.reason ?? "denied") : PASS;
  };
  const attempt = (lastUserInput: string, toolCall: unknown, cwd = dir): Verdict =>
    hook({ hookEventName: "PreToolUse", cwd, lastUserInput, toolCall }, cwd);
  return {
    invoke: async (orchestrator, args) =>
      attempt(`/dev:${orchestrator} ${args}`, {
        id: "call",
        name: "read_file",
        args: { Path: path.join(PLUGIN, "skills", orchestrator, "SKILL.md") },
      }),
    skill: async (name, text, cwd) =>
      attempt(
        text,
        {
          id: "call",
          name: "read_file",
          args: { Path: path.join(PLUGIN, "skills", name, "SKILL.md") },
        },
        cwd,
      ),
    bash: async (command, cwd) =>
      attempt("", { id: "call", name: "run_command", args: { CommandLine: command } }, cwd),
    write: async (file, content, cwd) =>
      attempt("", { id: "call", name: "write_file", args: { Path: file, Content: content } }, cwd),
    edit: async (file, oldText, newText, cwd) =>
      attempt(
        "",
        {
          id: "call",
          name: "edit_file",
          args: { Path: file, Target: oldText, Replacement: newText },
        },
        cwd,
      ),
  };
};

// ── the suites ────────────────────────────────────────────────────────

const HARNESSES: [string, (dir: string) => Harness][] = [
  ["Claude Code", claude],
  ["Pi", pi],
  ["DSH", dsh],
  ["OpenCode", opencode],
  ["Antigravity", antigravity],
];

for (const [name, make] of HARNESSES) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  test(`autopilot's direct-edit lane on ${name}`, async () => {
    const dir = scratch(slug, "direct");
    await directEdit(dir, make(dir));
  });
  test(`autopilot's plan-backed lane on ${name}`, async () => {
    const dir = scratch(slug, "autopilot");
    await planBacked(dir, make(dir), "autopilot");
  });
  test(`run-stack's plan-backed lane on ${name}`, async () => {
    const dir = scratch(slug, "run-stack");
    await planBacked(dir, make(dir), "run-stack");
  });
}
