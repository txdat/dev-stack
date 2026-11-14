import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

// The session's directory, where every CLI runs.
const CWD = "/home/u/repo/sub";
// A repository path with a space; the plan's own name allows none.
const PLAN = "/tmp/my repo/docs/plans/12_s/pr1.spec.md";

type Ran = { exitCode: number; stdout: string; stderr: string };
type HookCall = { input: Record<string, unknown>; cwd: string | undefined };

const binPath = (argv: readonly string[]) => argv.map((a) => a.replace(/^.*\/bin\//, "bin/"));

/** bin/dev-stack-command.ts's answer: its result as JSON. */
const result = (text: string, note?: string): Ran => ({
  exitCode: 0,
  stdout: `${JSON.stringify(note === undefined ? { text } : { text, note })}\n`,
  stderr: "",
});

// Records each bin/dev-stack-command.ts argv and answers it with `ran`, and each bin/hook.ts run
// with `gate`; nothing sits beneath, so these hooks stand for the engine.
function engine(
  on: On,
  ran: Ran | "throw" = result("ok"),
  gate: (input: Record<string, unknown>) => Ran | "throw" = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
) {
  const calls: string[][] = [];
  const hooks: HookCall[] = [];
  const cwds: (string | undefined)[] = [];
  on("session.cwd", () => ({ value: CWD }));
  on("process.run", (_, e) => {
    const argv = binPath(e.argv);
    let answer: Ran | "throw";
    if (argv[1] === "bin/hook.ts") {
      const input = JSON.parse(e.init?.stdin ?? "{}") as Record<string, unknown>;
      hooks.push({ input, cwd: e.init?.cwd });
      answer = gate(input);
    } else {
      calls.push(argv);
      cwds.push(e.init?.cwd);
      answer = ran;
    }
    if (answer === "throw") throw new Error("spawn node ENOENT");
    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return Object.assign(calls, { hooks, cwds });
}

// A command the person typed at the prompt; the engine stamps origin and presentation.
const typed = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: "composer" as const },
  presentation: { isFullscreen: false, columns: 120 },
});

// Parsing, plan paths, and output shaping are commands.ts's, tested in test/commands.test.ts.

test("a command runs bin/dev-stack-command.ts once, in the session directory", async ($, on) => {
  const calls = engine(on);
  await $.command.run(typed("dev-stack-stop", `${PLAN}  flaky test`));
  await $.command.run(typed("dev-stack-next", `${PLAN} --md`));
  expect(calls).toEqual([
    ["node", "bin/dev-stack-command.ts", "dev-stack-stop", `${PLAN}  flaky test`],
    ["node", "bin/dev-stack-command.ts", "dev-stack-next", `${PLAN} --md`],
  ]);
  expect(new Set(calls.cwds)).toEqual(new Set([CWD]));
});

test("a missing argument shows usage and runs nothing", async ($, on) => {
  const calls = engine(on);
  for (const [command, args] of [
    ["dev-stack-next", ""],
    ["dev-stack-review", PLAN],
    ["dev-stack-resume", "  "],
  ] as const) {
    const out = await $.command.run(typed(command, args));
    expect(out.text?.startsWith(`Usage: /${command} `)).toBe(true);
  }
  expect(calls.length).toBe(0);
});

test("a write's note reaches the model; a read's result carries none", async ($, on) => {
  engine(on, result("Resumed", "The user cleared the stop"));
  const resumed = await $.command.run(typed("dev-stack-resume", PLAN));
  expect(resumed.text).toBe("Resumed");
  expect(resumed.context).toEqual(["The user cleared the stop"]);
});

test("a read's result carries no note", async ($, on) => {
  engine(on, result("pr1"));
  const listed = await $.command.run(typed("dev-stack-list", PLAN));
  expect(listed.context ?? []).toEqual([]);
});

test("a CLI that fails or cannot start is reported", async ($, on) => {
  engine(on, { exitCode: 2, stdout: "", stderr: "dev-stack-command.ts: no command x" });
  const failed = await $.command.run(typed("dev-stack-list", PLAN));
  expect(failed.text).toBe("dev-stack.ts failed: dev-stack-command.ts: no command x");
});

test("a CLI that cannot start is reported", async ($, on) => {
  engine(on, "throw");
  const out = await $.command.run(typed("dev-stack-list", PLAN));
  expect(out.text?.startsWith("dev-stack.ts failed: ")).toBe(true);
});

test("a write runs only from the user, at the terminal or through Remote Control", async ($, on) => {
  const calls = engine(on, result("ok", "note"));
  const others = [
    { kind: "plugin", name: "other" },
    { kind: "sdk" },
    { kind: "scheduled-trigger" },
    { kind: "peer" },
    { kind: "task-notification" },
  ] as const;
  const writes: [string, string][] = [
    ["dev-stack-review", `${PLAN} ready`],
    ["dev-stack-stop", `${PLAN} reason`],
    ["dev-stack-resume", PLAN],
    ["dev-stack-reopen", PLAN],
  ];
  for (const origin of others) {
    for (const [command, args] of writes) {
      const out = await $.command.run({ ...typed(command, args), origin });
      expect(out.text).toContain("runs only from the user's own input");
      expect(out.context ?? []).toEqual([]);
    }
    await $.command.run({ ...typed("dev-stack-list", PLAN), origin });
  }
  expect(calls.length).toBe(others.length);
  for (const origin of [{ kind: "composer" }, { kind: "bridge" }] as const) {
    const out = await $.command.run({ ...typed("dev-stack-resume", PLAN), origin });
    expect(out.context?.length).toBe(1);
  }
  expect(calls.length).toBe(others.length + 2);
});

test("reads run mid-turn and writes wait for the turn", async ($, on) => {
  const specs: { name: string; immediate: true | undefined }[] = [];
  on("command.register", (_, e) => {
    specs.push({ name: e.name, immediate: e.immediate });
    return { value: { command: e.name } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  expect(specs).toEqual([
    { name: "dev-stack-next", immediate: true },
    { name: "dev-stack-list", immediate: true },
    { name: "dev-stack-check", immediate: true },
    { name: "dev-stack-review", immediate: undefined },
    { name: "dev-stack-stop", immediate: undefined },
    { name: "dev-stack-resume", immediate: undefined },
    { name: "dev-stack-reopen", immediate: undefined },
  ]);
});

test("multi-line output starts below the plugin name the engine labels it with", async ($, on) => {
  engine(on, result("pr1 🟢 reviewed\n└─ pr2 🔵 approved"));
  const out = await $.command.run(typed("dev-stack-next", PLAN));
  expect(out.text).toBe("\npr1 🟢 reviewed\n└─ pr2 🔵 approved");
});

test("one-line output stays on the label line", async ($, on) => {
  engine(on, result("Status: ready"));
  const out = await $.command.run(typed("dev-stack-review", `${PLAN} ready`));
  expect(out.text).toBe("Status: ready");
});

// ── gates ──────────────────────────────────────────────────────────────

const deny = (reason: string): Ran => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`,
  stderr: "",
});
const report = (reason: string): Ran => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ decision: "block", reason })}\n`,
  stderr: "",
});
const pass: Ran = { exitCode: 0, stdout: "", stderr: "" };

test("a refused Bash call never runs, and nothing checks it after", async ($, on) => {
  const calls = engine(on, undefined, (i) =>
    i["hook_event_name"] === "PreToolUse" ? deny("add --runInBand") : pass,
  );
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  const out = await $.tool.call({ tool: "Bash", command: "npx jest" });
  expect(ran).toBe(false);
  expect(out.text ?? out.deny).toContain("add --runInBand");
  expect(calls.hooks.length).toBe(1);
  expect(calls.hooks[0]?.input).toMatchObject({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npx jest" },
  });
  expect(calls.hooks[0]?.cwd).toBe(CWD);
});

test("a Bash call's post check shares its id, and its report reaches the model", async ($, on) => {
  const calls = engine(on, undefined, (i) =>
    i["hook_event_name"] === "PostToolUse" ? report("restored pr1.spec.md") : pass,
  );
  on("tool.call", () => ({ result: { stdout: "hi", stderr: "", interrupted: false } }));
  const out = await $.tool.call({ tool: "Bash", command: "echo hi" });
  expect(out.context).toEqual(["restored pr1.spec.md"]);
  const [pre, post] = calls.hooks;
  expect(pre?.input["hook_event_name"]).toBe("PreToolUse");
  expect(post?.input["hook_event_name"]).toBe("PostToolUse");
  expect(post?.input["tool_use_id"]).toBe(pre?.input["tool_use_id"]);
  expect(typeof pre?.input["tool_use_id"]).toBe("string");
});

test("a failed Bash call is checked as PostToolUseFailure", async ($, on) => {
  const calls = engine(on);
  on("tool.call", () => {
    throw new Error("boom");
  });
  await $.tool.call({ tool: "Bash", command: "false" }).catch(() => undefined);
  expect(calls.hooks.map((h) => h.input["hook_event_name"])).toEqual([
    "PreToolUse",
    "PostToolUseFailure",
  ]);
});

test("hook.ts that cannot run passes the call", async ($, on) => {
  engine(on, undefined, () => "throw");
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(ran).toBe(true);
});

test("a Skill call is gated on its skill and args; an Edit gets no post check", async ($, on) => {
  const calls = engine(on, undefined, (i) =>
    i["tool_name"] === "Skill" ? deny("Plan is not approved") : pass,
  );
  on("tool.call", () => ({ result: {} as never }));
  const out = await $.tool.call({ tool: "Skill", skill: "dev:execute-feature", args: PLAN });
  expect(out.text ?? out.deny).toContain("Plan is not approved");
  expect(calls.hooks[0]?.input["tool_input"]).toEqual({ skill: "dev:execute-feature", args: PLAN });
  calls.hooks.length = 0;
  await $.tool.call({ tool: "Edit", file_path: "/x", old_string: "a", new_string: "b" });
  expect(calls.hooks.map((h) => h.input["hook_event_name"])).toEqual(["PreToolUse"]);
});

test("other tools pass unchecked", async ($, on) => {
  const calls = engine(on);
  on("tool.call", () => ({ result: {} as never }));
  await $.tool.call({ tool: "Read", file_path: "/x" });
  expect(calls.hooks.length).toBe(0);
});

test("the rules block defines $DEV_LIB and carries CORE.md and CODING.md", async ($, on) => {
  engine(on);
  on("fs.read", (_, e) => ({ value: `text of ${e.path.replace(/^.*\/rules\//, "")}` }));
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));
  const out = await $.prompt.context({ blocks: [{ name: "currentDate", text: "today" }] });
  expect(out.blocks[0]?.name).toBe("currentDate");
  const rules = out.blocks.find((b) => b.name === "devRules");
  expect(rules?.text).toMatch(/^\$DEV_LIB is \/\S+: /);
  expect(rules?.text).toContain("text of CORE.md");
  expect(rules?.text).toContain("text of CODING.md");
});

test("the rules are read once; a failed read is retried", async ($, on) => {
  engine(on);
  const reads: string[] = [];
  let fail = true;
  on("fs.read", (_, e) => {
    reads.push(e.path);
    if (fail && e.path.endsWith("CODING.md")) throw new Error("EACCES");
    return { value: "text" };
  });
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));
  const first = await $.prompt.context({ blocks: [] });
  expect(first.blocks[0]?.text).toContain("could not be read (");
  fail = false;
  await $.prompt.context({ blocks: [] });
  await $.prompt.context({ blocks: [] });
  expect(reads.length).toBe(4);
});

test("hook.ts runs with a timeout, so a hung gate passes with a warning", async ($, on) => {
  let timeout: number | undefined;
  on("session.cwd", () => ({ value: CWD }));
  on("process.run", (_, e) => {
    timeout = e.init?.timeoutMs;
    throw new Error("timed out");
  });
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(timeout).toBe(30_000);
  expect(ran).toBe(true);
});

test("a typed phase command is dropped when its gate blocks; other prompts never spawn", async ($, on) => {
  const calls = engine(on, undefined, (i) =>
    String(i["prompt"]).includes("review-feature") ? deny("Plan has no Spec") : pass,
  );
  let entered = 0;
  on("prompt.submit", (_, e) => {
    entered++;
    return { text: e.text };
  });
  const origin = { kind: "composer" } as const;
  const blocked = await $.prompt.submit({
    text: `/dev:review-feature ${PLAN}`,
    command: { name: "dev:review-feature", args: PLAN },
    wait: false,
    origin,
  });
  expect(blocked.drop).toBe("Plan has no Spec");
  expect(calls.hooks[0]?.input).toEqual({
    hook_event_name: "UserPromptSubmit",
    prompt: `/dev:review-feature ${PLAN}`,
  });
  await $.prompt.submit({ text: "hello", wait: false, origin });
  expect(calls.hooks.length).toBe(1);
  expect(entered).toBe(1);
});
