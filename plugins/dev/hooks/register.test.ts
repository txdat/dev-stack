import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

// dev-stack.ts as the plugin runs it, its install root cut to bin/ (`engine` below).
const STACK = ["node", "bin/dev-stack.ts"];
// The session's repository, as dev-utils.ts main-root prints it; plans live in its docs/plans.
const MAIN = "/home/u/repo";
// The session's directory, where every CLI runs.
const CWD = "/home/u/repo/sub";
// A repository path with a space; the plan's own name allows none.
const PLAN = "/tmp/my repo/docs/plans/12_s/pr1.spec.md";

type Ran = { exitCode: number; stdout: string; stderr: string };
type HookCall = { input: Record<string, unknown>; cwd: string | undefined };

const binPath = (argv: readonly string[]) => argv.map((a) => a.replace(/^.*\/bin\//, "bin/"));

// Records each dev-stack.ts argv and answers it with `ran`, answers dev-utils.ts main-root with
// `main` (unrecorded), and each bin/hook.ts run with `gate`; nothing sits beneath, so these hooks
// stand for the engine.
function engine(
  on: On,
  ran: Ran = { exitCode: 0, stdout: "ok\n", stderr: "" },
  main: Ran = { exitCode: 0, stdout: `${MAIN}\n`, stderr: "" },
  gate: (input: Record<string, unknown>) => Ran | "throw" = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
) {
  const calls: string[][] = [];
  const hooks: HookCall[] = [];
  const cwds: (string | undefined)[] = [];
  on("env.get", (_, e) => ({ value: e.name === "HOME" ? "/home/u" : undefined }));
  on("session.cwd", () => ({ value: CWD }));
  on("process.run", (_, e) => {
    const argv = binPath(e.argv);
    let answer: Ran;
    if (argv[1] === "bin/hook.ts") {
      const input = JSON.parse(e.init?.stdin ?? "{}") as Record<string, unknown>;
      hooks.push({ input, cwd: e.init?.cwd });
      const g = gate(input);
      if (g === "throw") throw new Error("spawn node ENOENT");
      answer = g;
    } else if (argv[1] === "bin/dev-utils.ts") {
      answer = main;
    } else {
      calls.push(argv);
      cwds.push(e.init?.cwd);
      answer = ran;
    }
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

test("each command runs its dev-stack.ts subcommand in the session directory, a plan path with spaces kept whole", async ($, on) => {
  const calls = engine(on);
  const cases: [string, string, string[]][] = [
    ["dev-stack-next", PLAN, ["next", PLAN]],
    ["dev-stack-next", `${PLAN} --tab`, ["next", PLAN, "--tab"]],
    ["dev-stack-next", `${PLAN} --tree`, ["next", PLAN, "--tree"]],
    ["dev-stack-next", `${PLAN} --md`, ["next", PLAN, "--md"]],
    ["dev-stack-list", PLAN, ["stack", PLAN]],
    ["dev-stack-check", PLAN, ["check", PLAN]],
    ["dev-stack-review", `${PLAN} needs-changes`, ["review", PLAN, "needs-changes"]],
    [
      "dev-stack-stop",
      `${PLAN}  Failed fixes: 3/3 — flaky test`,
      ["stop", PLAN, "Failed fixes: 3/3 — flaky test"],
    ],
    ["dev-stack-resume", PLAN, ["resume", PLAN]],
    ["dev-stack-reopen", PLAN, ["reopen", PLAN]],
  ];
  for (const [command, args, argv] of cases) {
    await $.command.run(typed(command, args));
    expect(calls.pop()).toEqual([...STACK, ...argv]);
  }
  expect(new Set(calls.cwds)).toEqual(new Set([CWD]));
});

test("a missing argument shows usage and runs nothing", async ($, on) => {
  const calls = engine(on);
  const cases: [string, string][] = [
    ["dev-stack-next", ""],
    ["dev-stack-review", PLAN],
    ["dev-stack-review", `${PLAN} approved`],
    ["dev-stack-review", "notaplan ready"],
    ["dev-stack-stop", PLAN],
    ["dev-stack-resume", "  "],
    ["dev-stack-reopen", `${PLAN} extra`],
    ["dev-stack-next", `${PLAN} --json`],
    ["dev-stack-check", `${PLAN} extra`],
  ];
  for (const [command, args] of cases) {
    const out = await $.command.run(typed(command, args));
    expect(out.text?.startsWith(`Usage: /${command} `)).toBe(true);
  }
  expect(calls.length).toBe(0);
});

test("only a successful write tells the model", async ($, on) => {
  engine(on);
  const resumed = await $.command.run(typed("dev-stack-resume", PLAN));
  expect(resumed.context?.[0]).toContain(`cleared the stop on ${PLAN}`);
  const listed = await $.command.run(typed("dev-stack-list", PLAN));
  expect(listed.context ?? []).toEqual([]);
});

test("a failed write tells the model nothing", async ($, on) => {
  engine(on, { exitCode: 1, stdout: "", stderr: "Plan not found: x" });
  const out = await $.command.run(typed("dev-stack-resume", PLAN));
  expect(out.text).toBe("Plan not found: x");
  expect(out.context ?? []).toEqual([]);
});

test("check's blocked report on stdout is shown", async ($, on) => {
  engine(on, { exitCode: 1, stdout: `PASS a\nBLOCK b\nreason\n`, stderr: "" });
  const out = await $.command.run(typed("dev-stack-check", PLAN));
  expect(out.text).toBe("\nPASS a\nBLOCK b\nreason");
});

test("a plan outside the repository gets a hint", async ($, on) => {
  engine(on, { exitCode: 1, stdout: "", stderr: "Plan must be ~/repo/docs/plans/..." });
  const out = await $.command.run(typed("dev-stack-next", PLAN));
  expect(out.text).toContain("Run it from the plan's repository");
});

test("plan paths show without the repository's docs/plans prefix", async ($, on) => {
  engine(on, {
    exitCode: 0,
    stdout:
      "/home/u/repo/docs/plans/12_s/pr1.spec.md\tplanning\t-\treview-feature\t-\n~/repo/docs/plans/12_s/pr2.spec.md\n",
    stderr: "",
  });
  const out = await $.command.run(typed("dev-stack-next", PLAN));
  expect(out.text).toBe("\n12_s/pr1.spec.md\tplanning\t-\treview-feature\t-\n12_s/pr2.spec.md");
});

test("outside a repository a plan path passes through as typed and nothing is shortened", async ($, on) => {
  const calls = engine(
    on,
    { exitCode: 1, stdout: "", stderr: "Plan not found: /home/u/repo/docs/plans/12_s/pr9.spec.md" },
    { exitCode: 1, stdout: "", stderr: "Cannot resolve the main working-tree root." },
  );
  const out = await $.command.run(typed("dev-stack-resume", "12_s/pr9.spec.md"));
  expect(calls.pop()).toEqual([...STACK, "resume", "12_s/pr9.spec.md"]);
  expect(out.text).toContain("Plan not found: /home/u/repo/docs/plans/12_s/pr9.spec.md");
});

test("the format hint keeps its prefix", async ($, on) => {
  engine(on, {
    exitCode: 1,
    stdout: "",
    stderr:
      "Plan must be ~/repo/docs/plans/<issue>_<slug>/pr<N>.spec.md: /home/u/repo/docs/plans/x/pr1.spec.md",
  });
  const out = await $.command.run(typed("dev-stack-next", PLAN));
  expect(out.text?.split("\n")[1]).toBe(
    "Plan must be ~/repo/docs/plans/<issue>_<slug>/pr<N>.spec.md: x/pr1.spec.md",
  );
});

test("a leading @ file mention is not part of the plan path", async ($, on) => {
  const calls = engine(on);
  await $.command.run(typed("dev-stack-next", "@12_s/pr1.spec.md"));
  expect(calls.pop()).toEqual([...STACK, "next", "/home/u/repo/docs/plans/12_s/pr1.spec.md"]);
});

test("a write runs only from the user, at the terminal or through Remote Control", async ($, on) => {
  const calls = engine(on);
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

test("a plan path as shown, relative to the repository's docs/plans, is read back from it", async ($, on) => {
  const calls = engine(on);
  const out = await $.command.run(typed("dev-stack-resume", "12_s/pr1.spec.md"));
  expect(calls.pop()).toEqual([...STACK, "resume", "/home/u/repo/docs/plans/12_s/pr1.spec.md"]);
  expect(out.context?.[0]).toContain("/home/u/repo/docs/plans/12_s/pr1.spec.md");
});

test("a usage error from dev-stack.ts shows the usage line", async ($, on) => {
  engine(on, { exitCode: 2, stdout: "", stderr: "Usage: dev-stack.ts ..." });
  const out = await $.command.run(typed("dev-stack-review", `${PLAN} ready`));
  expect(out.text).toBe("Usage: /dev-stack-review <spec file> ready|needs-changes");
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
  engine(on, { exitCode: 0, stdout: "pr1 🟢 reviewed\n└─ pr2 🔵 approved\n", stderr: "" });
  for (const view of ["", " --tab", " --tree", " --md"]) {
    const out = await $.command.run(typed("dev-stack-next", PLAN + view));
    expect(out.text).toBe("\npr1 🟢 reviewed\n└─ pr2 🔵 approved");
  }
  const listed = await $.command.run(typed("dev-stack-list", PLAN));
  expect(listed.text).toBe("\npr1 🟢 reviewed\n└─ pr2 🔵 approved");
});

test("one-line output stays on the label line", async ($, on) => {
  engine(on, { exitCode: 0, stdout: "Status: ready\n", stderr: "" });
  const out = await $.command.run(typed("dev-stack-review", `${PLAN} ready`));
  expect(out.text).toBe("Status: ready");
  const usage = await $.command.run(typed("dev-stack-next", ""));
  expect(usage.text?.startsWith("Usage: ")).toBe(true);
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
  const calls = engine(on, undefined, undefined, (i) =>
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
  const calls = engine(on, undefined, undefined, (i) =>
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
  engine(on, undefined, undefined, () => "throw");
  let ran = false;
  on("tool.call", () => {
    ran = true;
    return { result: { stdout: "", stderr: "", interrupted: false } };
  });
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(ran).toBe(true);
});

test("a Skill call is gated on its skill and args; an Edit gets no post check", async ($, on) => {
  const calls = engine(on, undefined, undefined, (i) =>
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

test("a typed phase command is dropped when its gate blocks; other prompts never spawn", async ($, on) => {
  const calls = engine(on, undefined, undefined, (i) =>
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
