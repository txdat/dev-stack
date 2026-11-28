// Codex adapter (plugins/dev/bin/codex-hook.ts and scripts/build-codex.ts): rule injection at
// SessionStart and SubagentStart, the prompt gate on `$dev:<phase>` and /dev-stack-* commands, the
// gate on a shell read of a phase's SKILL.md with its plan from the transcript, the record guard on
// shell commands and apply_patch, the check after either, and the dist/dev-codex build. Payloads
// have the shape Codex 0.172 sends.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { exec, NODE, PLUGIN, planText, RUN, read, repo, tmp, write } from "./helpers.ts";

const ROOT = path.resolve(PLUGIN, "../..");
const HOOK = path.join(PLUGIN, "bin/codex-hook.ts");
const STACK = path.join(PLUGIN, "bin/dev-stack.ts");

let calls = 0;

/** Runs the hook on `payload`; its parsed stdout, or undefined when it printed nothing. */
const runHook = (
  payload: Record<string, unknown> | string,
  opts: { cwd?: string; code?: number } = {},
): Record<string, unknown> | undefined => {
  const r = exec([...NODE, HOOK], {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, PLUGIN_ROOT: PLUGIN },
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  assert.equal(r.code, opts.code ?? 0, r.all);
  return r.out.trim() === "" ? undefined : (JSON.parse(r.out) as Record<string, unknown>);
};

const base = (cwd: string, transcript: string | null = null) => ({
  session_id: "s",
  turn_id: "t",
  transcript_path: transcript,
  cwd,
  model: "gpt",
  permission_mode: "bypassPermissions",
});

const prompt = (cwd: string, text: string) =>
  runHook({ ...base(cwd), hook_event_name: "UserPromptSubmit", prompt: text });

const pre = (cwd: string, tool: string, input: unknown, transcript: string | null = null) =>
  runHook({
    ...base(cwd, transcript),
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: `exec-${++calls}`,
  });

/** The refusal a PreToolUse answer carries; undefined when it passes. */
const denied = (out: Record<string, unknown> | undefined): string | undefined => {
  if (out === undefined) return undefined;
  // Codex runs a call whose answer carries anything beside hookSpecificOutput.
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  const h = out["hookSpecificOutput"] as Record<string, unknown>;
  assert.equal(h["hookEventName"], "PreToolUse");
  assert.equal(h["permissionDecision"], "deny");
  return String(h["permissionDecisionReason"]);
};

/**
 * A rollout JSONL holding a user prompt and then an assistant message, or, with `assistantFirst`,
 * the assistant message of an earlier turn and then the prompt.
 */
const transcript = (user: string, assistant: string, assistantFirst = false): string => {
  const file = path.join(tmp("dev-codex-rollout"), "rollout.jsonl");
  const prompt = [
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: user }] },
      },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] },
    },
  ];
  const reply = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: assistant }],
      phase: "commentary",
    },
  };
  const records = [
    { type: "session_meta", payload: { id: "s" } },
    ...(assistantFirst ? [reply, ...prompt] : [...prompt, reply]),
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return file;
};

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

/** The gate's refusal of review-code when no plan is named. */
const NO_PLAN = /review-code operates on a plan and none was named/;

const FIELDS = {
  Issue: "#12",
  Type: "feature",
  Status: "planning",
  Spec: "-",
  Tip: "-",
  Base: "main",
  Branch: "feat/x",
};

test("SessionStart and SubagentStart inject $DEV_LIB, CORE.md, CODING.md, and codex-agents.md", () => {
  for (const event of ["SessionStart", "SubagentStart"]) {
    const out = runHook({ ...base(ROOT), hook_event_name: event, source: "startup" });
    const h = out?.["hookSpecificOutput"] as Record<string, string>;
    assert.equal(h["hookEventName"], event);
    const text = h["additionalContext"] ?? "";
    assert.ok(text.startsWith(`$DEV_LIB is ${PLUGIN}:`), event);
    for (const name of ["CORE.md", "CODING.md", "codex-agents.md"])
      assert.ok(text.includes(`Contents of ${PLUGIN}/rules/${name}:`), `${event}: ${name}`);
    assert.match(text, /# Codex Delegation/);
  }
});

test("UserPromptSubmit gates a `$dev:<phase>` mention anywhere in the prompt", () => {
  const dir = repo(tmp("dev-codex-prompt"));
  const plan = path.join(dir, "docs/plans/12_x/pr1.spec.md");
  write(plan, planText(FIELDS, BODY));
  const block = (text: string) => {
    const out = prompt(dir, text);
    if (out === undefined) return undefined;
    assert.equal(out["decision"], "block");
    return String(out["reason"]);
  };
  // Codex injects the skill for a mention anywhere, so each one is gated.
  assert.match(block("$dev:review-code please") ?? "", NO_PLAN);
  assert.match(block(`please run $dev:execute-feature on ${plan}`) ?? "", /'planning'/);
  assert.match(block(`$dev:explore then $dev:create-pr ${plan}`) ?? "", /'planning'/);
  // A phase at its entry status, an ungated skill, prose, and another plugin's skill pass.
  assert.equal(block(`$dev:review-feature ${plan}`), undefined);
  assert.equal(block("$dev:explore the gate"), undefined);
  assert.equal(block("how does review-code work?"), undefined);
  assert.equal(block("$other:review-code x"), undefined);
});

test("UserPromptSubmit runs /dev-stack-* commands and shows their result without the model", () => {
  const dir = repo(tmp("dev-codex-cmd"));
  const plan = path.join(dir, "docs/plans/12_cmd/pr1.spec.md");
  write(plan, planText({ Status: "planning", Base: "main", Branch: "p1", PR: "none" }));
  const next = prompt(dir, "/dev-stack-next 12_cmd/pr1.spec.md");
  assert.equal(next?.["decision"], "block");
  assert.match(String(next?.["reason"]), /12_cmd\/pr1\.spec\.md/);
  const usage = prompt(dir, "/dev-stack-next");
  assert.match(String(usage?.["reason"]), /^Usage: \/dev-stack-next /);
  const stop = prompt(dir, `/dev-stack-stop ${plan} waiting on API`);
  assert.match(
    String(stop?.["reason"]),
    /The user stopped .* with dev-stack\.js stop: waiting on API/,
  );
  assert.equal(prompt(dir, "explain /dev-stack-next"), undefined);
  assert.equal(prompt(dir, "/dev-stack-unknown foo"), undefined);
});

test("PreToolUse runs the serial-test check and the record guard on Bash", () => {
  const dir = repo(tmp("dev-codex-bash"));
  const plan = path.join(dir, "docs/plans/1_t/pr1.spec.md");
  write(plan, planText({ Status: "ready", Base: "main", Branch: "p1", PR: "none" }));
  assert.match(denied(pre(dir, "Bash", { command: "npx jest" })) ?? "", /--runInBand/);
  assert.equal(denied(pre(dir, "Bash", { command: "npx jest --runInBand" })), undefined);
  assert.match(
    denied(pre(dir, "Bash", { command: `node bin/dev-stack.js resume ${plan}` })) ?? "",
    /the user's alone/,
  );
  assert.match(
    denied(pre(dir, "Bash", { command: "echo x >> docs/plans/1_t/log" })) ?? "",
    /stack log is written only by dev-stack\.js/,
  );
  assert.equal(denied(pre(dir, "spawn_agent", { task_name: "x" })), undefined);
});

test("PreToolUse gates a shell read of the plugin's phase SKILL.md on the transcript's plan", () => {
  const dir = repo(tmp("dev-codex-skill"));
  const plan = path.join(dir, "docs/plans/12_x/pr1.spec.md");
  write(plan, planText(FIELDS, BODY));
  const skill = (name: string) => path.join(PLUGIN, "skills", name, "SKILL.md");
  const readSkill = (command: string, user: string, assistant: string, assistantFirst = false) =>
    denied(pre(dir, "Bash", { command }, transcript(user, assistant, assistantFirst)));

  // No plan named and none at review-code's entry status.
  assert.match(
    readSkill(`cat ${skill("review-code")}`, "review code", "Reading it.") ?? "",
    NO_PLAN,
  );
  assert.equal(readSkill(`cat ${skill("explore")}`, "explore", "Reading it."), undefined);
  // The assistant's message names the plan; quoting and sed forms are reads too.
  assert.equal(
    readSkill(
      `sed -n '1,200p' "${skill("review-feature")}"`,
      "go",
      `Starting review-feature on ${plan}`,
    ),
    undefined,
  );
  assert.match(
    readSkill(`cat ${skill("execute-feature")}`, "go", `Starting execute-feature on ${plan}`) ?? "",
    /'planning'/,
  );
  // Without a plan in the assistant's message, the user's `$dev:` prompt is the text.
  assert.match(
    readSkill(`cat ${skill("execute-feature")}`, `$dev:execute-feature ${plan}`, "On it.") ?? "",
    /'planning'/,
  );
  // An assistant message from before the latest prompt is an earlier turn's: the prompt is the text.
  assert.match(
    readSkill(
      `cat ${skill("execute-feature")}`,
      `$dev:execute-feature ${plan}`,
      `Starting review-feature on ${plan}`,
      true,
    ) ?? "",
    /'planning'/,
  );
  assert.match(
    readSkill(
      `cat ${skill("review-code")}`,
      "now review the code",
      `Starting review-feature on ${plan}`,
      true,
    ) ?? "",
    NO_PLAN,
  );
  // A subagent's later task arrives as an agent_message: an assistant message before it is stale.
  const sub = path.join(tmp("dev-codex-sub"), "rollout.jsonl");
  fs.writeFileSync(
    sub,
    `${[
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Starting review-feature on ${plan}` }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/reviewer",
          content: [{ type: "input_text", text: "Message Type: NEW_TASK\nreview the code" }],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  );
  assert.match(
    denied(pre(dir, "Bash", { command: `cat ${skill("review-code")}` }, sub)) ?? "",
    NO_PLAN,
  );
  // In the main session, a subagent's reply sent up mid-turn starts no turn: the prompt stays.
  // Its plan is too late for review-feature, which another plan can run.
  const up = repo(tmp("dev-codex-up"));
  write(path.join(up, "docs/plans/12_x/pr1.spec.md"), planText(FIELDS, BODY));
  const done = path.join(up, "docs/plans/13_y/pr1.spec.md");
  write(done, planText({ ...FIELDS, Issue: "#13", Status: "implemented", Branch: "feat/y" }, BODY));
  const mainRollout = (author: string, recipient: string): string => {
    const file = path.join(tmp("dev-codex-main"), "rollout.jsonl");
    const records = [
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            content: [{ type: "text", text: "$dev:autopilot issue 12" }],
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "agent_message",
          author,
          recipient,
          content: [{ type: "input_text", text: `Done with ${done}` }],
        },
      },
    ];
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return file;
  };
  const readUp = (file: string) =>
    denied(pre(up, "Bash", { command: `cat ${skill("review-feature")}` }, file));
  assert.equal(readUp(mainRollout("/root/executor", "/root")), undefined);
  // The same message sent down is the subagent's task, which names the late plan.
  assert.match(readUp(mainRollout("/root", "/root/executor")) ?? "", /review-feature/);
  // An orchestrator names no plan for its phase: a runnable plan lets it read the skill.
  assert.equal(
    readSkill(`cat ${skill("review-feature")}`, "$dev:autopilot issue 12", "Next phase."),
    undefined,
  );
  // `$DEV_LIB` names the plugin's root in a command, as the rules write it.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form, not a template.
  for (const root of ["$DEV_LIB", "${DEV_LIB}"])
    assert.match(
      readSkill(`cat "${root}/skills/review-code/SKILL.md"`, "review", "Reading it.") ?? "",
      NO_PLAN,
      root,
    );
  // A SKILL.md outside the plugin, such as this repository's sources, is no skill load.
  const copy = path.join(tmp("dev-codex-src"), "skills/review-code/SKILL.md");
  write(copy, "x\n");
  assert.equal(readSkill(`cat ${copy}`, "edit the skill", "Reading it."), undefined);
  // No transcript: the gate still runs on the read.
  assert.match(denied(pre(dir, "Bash", { command: `cat ${skill("review-code")}` })) ?? "", NO_PLAN);
});

test("PreToolUse models apply_patch for the record guard", () => {
  const dir = repo(tmp("dev-codex-patch"));
  const plan = path.join(dir, "docs/plans/1_t/pr1.spec.md");
  write(plan, planText({ Status: "ready", Base: "main", Branch: "p1", PR: "none" }));
  const patch = (body: string) =>
    denied(pre(dir, "apply_patch", { command: `*** Begin Patch\n${body}\n*** End Patch` }));

  assert.match(
    patch(`*** Update File: ${plan}\n@@\n-Status: ready\n+Status: approved`) ?? "",
    /Only the user sets 'Status: approved'/,
  );
  // Relative paths resolve from the call's cwd; an @@ header anchors the hunk.
  assert.match(
    patch("*** Update File: docs/plans/1_t/pr1.spec.md\n@@\n-Status: ready\n+Status: approved") ??
      "",
    /Only the user sets 'Status: approved'/,
  );
  assert.equal(
    patch("*** Update File: docs/plans/1_t/pr1.spec.md\n@@ Base: main\n-Branch: p1\n+Branch: p2"),
    undefined,
    "an unapproved plan's other lines may change",
  );
  assert.match(
    patch(
      `*** Add File: docs/plans/2_n/pr1.spec.md\n+${planText({ Status: "approved" }).trimEnd().split("\n").join("\n+")}`,
    ) ?? "",
    /approved/,
  );
  assert.match(
    patch("*** Add File: docs/plans/1_t/log\n+x: resume") ?? "",
    /stack log is written only by dev-stack\.js/,
  );
  assert.equal(patch("*** Add File: src/a.txt\n+hello"), undefined);
  // A non-ASCII edit reaches the guard as written.
  const rb = path.join(dir, "docs/runbook/1_db/rb.md");
  write(rb, "# Move\nStatus: approved\nSpec: abc\nIssue: none\n\n## Phases\nPH-1 — copy\n");
  assert.match(patch(`*** Update File: ${rb}\n@@\n-PH-1 — copy\n+PH-1 — move`) ?? "", /frozen/);
  // An end-of-file hunk matches only at the file's end: elsewhere it cannot be modeled.
  const rb2 = path.join(dir, "docs/runbook/2_db/rb.md");
  write(rb2, "# Move\nStatus: approved\nSpec: abc\nIssue: none\n\n## Phases\nPH-1 — copy\n");
  assert.match(
    patch(`*** Update File: ${rb2}\n@@\n-Issue: none\n+Issue: none\n*** End of File`) ?? "",
    /could not be checked by the record guard/,
  );
  assert.match(
    patch(`*** Update File: ${rb2}\n@@\n-PH-1 — copy\n+PH-1 — move\n*** End of File`) ?? "",
    /frozen/,
  );
  // A move is checked as a write at its target.
  write(path.join(dir, "notes.md"), "PH-1 — copy\n");
  assert.match(
    patch(`*** Update File: notes.md\n*** Move to: ${rb}\n@@\n-PH-1 — copy\n+PH-1 — move`) ?? "",
    /keeps its 'Status:' and 'Spec:' header lines/,
  );
  // Deleting or moving away a guarded file is refused; elsewhere it passes.
  for (const body of [
    `*** Delete File: ${plan}`,
    "*** Delete File: docs/runbook/1_db/rb.md",
    `*** Update File: ${plan}\n*** Move to: docs/plans/1_t/pr2.spec.md\n@@\n-Branch: p1\n+Branch: p1`,
  ])
    assert.match(patch(body) ?? "", /apply_patch never deletes or moves/, body);
  assert.equal(patch("*** Delete File: notes.md"), undefined);
  // A patch it cannot model is refused on a guarded file, and passes elsewhere.
  assert.match(
    patch(`*** Update File: ${plan}\n@@\n-no such line\n+x`) ?? "",
    /could not be checked by the record guard/,
  );
  assert.equal(patch("*** Update File: notes.md\n@@\n-no such line\n+x"), undefined);
});

test("PostToolUse restores what a shell command or apply_patch changed against the record", () => {
  const dir = repo(tmp("dev-codex-post"));
  const plan = path.join(dir, "docs/plans/12_x/pr1.spec.md");
  write(plan, planText(FIELDS, BODY));
  const review = exec([...NODE, STACK, "review", plan, "ready"], { cwd: dir });
  assert.equal(review.code, 0, review.all);
  const original = read(plan);
  for (const [tool, input] of [
    ["Bash", { command: "echo tamper" }],
    ["apply_patch", { command: "*** Begin Patch\n*** Add File: src/x.txt\n+x\n*** End Patch" }],
  ] as const) {
    const id = `exec-post-${tool}`;
    const call = { ...base(dir), tool_name: tool, tool_input: input, tool_use_id: id };
    assert.equal(denied(runHook({ ...call, hook_event_name: "PreToolUse" })), undefined, tool);
    write(plan, planText({ ...FIELDS, Status: "approved" }, BODY));
    const post = runHook({ ...call, hook_event_name: "PostToolUse", tool_response: "ok" });
    assert.equal(post?.["decision"], "block", tool);
    assert.match(String(post?.["reason"]), /Restored from before the command/, tool);
    // Codex has no Edit tool.
    assert.match(String(post?.["reason"]), /Change Status and Tip with apply_patch/, tool);
    assert.equal(read(plan), original, tool);
  }
});

test("input that is not a JSON object passes with a warning", () => {
  assert.equal(runHook("{not-json", { code: 1 }), undefined);
});

test("scripts/build-codex.ts builds a Codex plugin", () => {
  const out = path.join(tmp("dev-codex-dist"), "dev-codex");
  const r = exec([...NODE, path.join(ROOT, "scripts/build-codex.ts"), "--out", out]);
  assert.equal(r.code, 0, r.all);
  const manifest = JSON.parse(read(path.join(out, ".codex-plugin/plugin.json")));
  assert.equal(manifest.name, "dev");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.ok(fs.existsSync(path.join(out, "bin/codex-hook.js")));
  const hooks = JSON.parse(read(path.join(out, "hooks/hooks.json")));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), [
    "PostToolUse",
    "PreToolUse",
    "SessionStart",
    "SubagentStart",
    "UserPromptSubmit",
  ]);
  for (const event of ["PreToolUse", "PostToolUse"])
    assert.equal(hooks.hooks[event][0].matcher, "Bash|apply_patch");
  for (const name of fs.readdirSync(path.join(out, "skills")))
    assert.doesNotMatch(read(path.join(out, "skills", name, "SKILL.md")), /^(?:model|effort):/m);
  for (const name of fs.readdirSync(path.join(out, "agents")))
    assert.doesNotMatch(read(path.join(out, "agents", name)), /^(?:model|effort):/m);
  assert.ok(!fs.existsSync(path.join(out, "rules/agy-swarm.md")));
  assert.ok(!fs.existsSync(path.join(out, ".claude-plugin")));
  const rule = read(path.join(out, "rules/codex-agents.md"));
  assert.doesNotMatch(rule, /\{\{[A-Z_]+\}\}/);
  assert.match(
    rule,
    /`code-reviewer`: `gpt-6\.1-terra` at `high`; `executor`: `gpt-6\.1-terra` at `medium`; `inspector`, `plan-reviewer`, `planner`: `gpt-6\.2-sol` at `medium`/,
  );
  // A reviewer runs on its review skill's model and effort (rules/artifact.md#review).
  assert.match(
    rule,
    /`review-change`, `review-code`, `review-infra`: `gpt-6\.1-terra` at `high`; `review-feature`, `review-system`: `gpt-6\.2-sol` at `medium`/,
  );
  // Each agent is a Codex role that loads its agent file.
  const roles = fs.readdirSync(path.join(out, "codex/agents")).sort();
  assert.deepEqual(
    roles,
    fs
      .readdirSync(path.join(out, "agents"))
      .sort()
      .map((n) => `dev-${n.replace(/\.md$/, ".toml")}`),
  );
  const role = read(path.join(out, "codex/agents/dev-code-reviewer.toml"));
  assert.match(role, /^name = "dev-code-reviewer"$/m);
  assert.match(role, /^description = "Review code independently of its author/m);
  assert.match(role, /^model = "gpt-6\.1-terra"$/m);
  assert.match(role, /^model_reasoning_effort = "high"$/m);
  assert.match(role, /read \$DEV_LIB\/agents\/code-reviewer\.md/);
  // Links and $DEV_LIB CLI paths in the shipped Markdown resolve inside the build.
  const md = fs
    .readdirSync(out, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(out, f));
  for (const f of md) {
    const text = read(f);
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target as string)) continue;
      const to = path.resolve(path.dirname(f), target as string);
      assert.ok(to.startsWith(`${out}/`) && fs.existsSync(to), `${f}: ${target}`);
    }
    for (const [cli] of text.matchAll(/\$DEV_LIB\/bin\/[a-z-]+\.[a-z]+/g))
      assert.ok(fs.existsSync(path.join(out, cli.slice("$DEV_LIB/".length))), `${f}: ${cli}`);
  }
  // The built hook runs from the build alone.
  const ran = exec([...NODE, path.join(out, "bin/codex-hook.js")], {
    env: { ...process.env, PLUGIN_ROOT: out },
    input: JSON.stringify({ ...base(ROOT), hook_event_name: "SessionStart", source: "startup" }),
  });
  assert.equal(ran.code, 0, ran.all);
  assert.match(ran.out, /Codex Delegation/);
});

test("hooks.json runs codex-hook.js under the shipped invocation", () => {
  const hooks = read(path.join(PLUGIN, "codex/hooks.json"));
  const commands = [...hooks.matchAll(/"command": "((?:[^"\\]|\\.)*)"/g)].map((m) =>
    JSON.parse(`"${m[1]}"`),
  );
  assert.equal(commands.length, 5);
  for (const c of commands) assert.equal(c, `${RUN} "$PLUGIN_ROOT/bin/codex-hook.js"`);
});

test("the marketplace lists the Codex build", () => {
  const market = JSON.parse(read(path.join(ROOT, ".agents/plugins/marketplace.json")));
  assert.deepEqual(market.plugins[0].source, { source: "local", path: "./dist/dev-codex" });
  assert.equal(market.plugins[0].name, "dev");
});
