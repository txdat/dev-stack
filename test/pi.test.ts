// The Pi extension (pi/dev.ts) driven through a stand-in ExtensionAPI: its handlers run with fake
// events and contexts against a scratch repository. The extension reads its env from process.env,
// so each call runs under withEnv.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { devStack } from "../plugins/dev/core/stack.ts";
import devExtension from "../plugins/dev/pi/dev.ts";
import { exec, PLUGIN, planText, read, repo, run, tmp, withEnv, write } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
let branch: unknown[] = [];
const handlers = new Map<string, Handler>();
const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
const sent: { customType: string; content: string; display: boolean }[] = [];
const fakePi = {
  on: (name: string, h: Handler) => handlers.set(name, h),
  registerCommand: (
    name: string,
    opts: { handler: (args: string, ctx: unknown) => Promise<void> },
  ) => commands.set(name, opts),
  sendMessage: (m: { customType: string; content: string; display: boolean }) => sent.push(m),
  // A custom entry joins the active branch, as Pi's session manager appends it.
  appendEntry: (customType: string, data: unknown) =>
    branch.push({ type: "custom", customType, data }),
};
devExtension(fakePi as never);

const ROOT = tmp("dev-pi-test");
const ENV = { AI_WORKTREES_ROOT: `${ROOT}/worktrees` };
const REPO = repo(`${ROOT}/repo`);
const P = `${REPO}/docs/plans/12_pi/pr1.spec.md`;
const GRAPH =
  "## Acceptance Criteria\nAC-1 — outcome\n## Test Cases\nTC-1 — scenario\n  Proves: AC-1\n## Implementation Steps\nST-1 — change — satisfies TC-1\n";
write(
  P,
  planText(
    {
      Status: "planning",
      Spec: "-",
      Tip: "-",
      Type: "feature",
      Base: "main",
      Branch: "feat/pi",
      Issue: "#12",
    },
    GRAPH,
  ),
);
const stack = (...argv: string[]) =>
  assert.equal(run(devStack, argv, { cwd: REPO, env: ENV }).code, 0, argv.join(" "));
stack("review", P, "ready");
stack("approve", P);

let notes: [string, string][] = [];
const ctx = {
  cwd: REPO,
  ui: { notify: (m: string, level: string) => notes.push([m, level]) },
  sessionManager: { getBranch: () => branch },
  waitForIdle: async () => {},
};
/** Runs a handler the extension registered, under the test env. */
const fire = async (name: string, event: unknown): Promise<unknown> => {
  notes = [];
  const h = handlers.get(name);
  assert.ok(h, `no ${name} handler`);
  const saved = process.env["AI_WORKTREES_ROOT"];
  process.env["AI_WORKTREES_ROOT"] = ENV.AI_WORKTREES_ROOT;
  try {
    return await h(event, ctx);
  } finally {
    if (saved === undefined) delete process.env["AI_WORKTREES_ROOT"];
    else process.env["AI_WORKTREES_ROOT"] = saved;
  }
};
const userSaid = (text: string) => [
  { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
];

test("before_agent_start adds the rules once", async () => {
  const added = (await fire("before_agent_start", { systemPrompt: "base" })) as {
    systemPrompt: string;
  };
  assert.ok(added.systemPrompt.startsWith("base\n\n$DEV_LIB is "), added.systemPrompt.slice(0, 80));
  assert.ok(added.systemPrompt.includes(`Contents of ${PLUGIN}/rules/CORE.md:`));
  assert.ok(added.systemPrompt.includes(`Contents of ${PLUGIN}/rules/CODING.md:`));
  assert.equal(await fire("before_agent_start", { systemPrompt: added.systemPrompt }), undefined);
});

test("input: the /dev: alias and the gate on typed skills", async () => {
  // An auto-approved plan does not re-enter review-feature, typed either way.
  for (const text of [`/dev:review-feature ${P}`, `/skill:review-feature ${P}`]) {
    assert.deepEqual(await fire("input", { text }), { action: "handled" }, text);
    assert.equal(notes[0]?.[1], "error");
    assert.match(notes[0]?.[0] ?? "", /^\[dev\] .*already auto-approved/);
  }
  assert.deepEqual(await fire("input", { text: "/dev:explore where is auth" }), {
    action: "transform",
    text: "/skill:explore where is auth",
  });
  assert.deepEqual(await fire("input", { text: "  /dev:explore" }), {
    action: "transform",
    text: "  /skill:explore",
  });
  assert.deepEqual(await fire("input", { text: "/DEV:Explore x" }), {
    action: "transform",
    text: "/skill:explore x",
  });
  // A name that is not one of this plugin's skills passes through untouched.
  assert.equal(await fire("input", { text: "/dev:nosuch x" }), undefined);
  // Another package's skill, though its name reads as a phase, is not gated.
  assert.equal(await fire("input", { text: `/skill:dev-review-feature ${P}` }), undefined);
  assert.equal(await fire("input", { text: "/skill:explore x" }), undefined);
  assert.equal(await fire("input", { text: `please /dev:review-feature ${P}` }), undefined);
  assert.equal(await fire("input", { text: "hello" }), undefined);
});

test("tool_call: reading a gated skill's SKILL.md runs its gate", async () => {
  const skill = `${PLUGIN}/skills/review-feature/SKILL.md`;
  assert.ok(fs.existsSync(skill));
  branch = userSaid(`review ${P}`);
  const blocked = (await fire("tool_call", {
    toolName: "read",
    toolCallId: "c1",
    input: { path: skill },
  })) as {
    block: boolean;
    reason: string;
  };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /already auto-approved/);
  // The issuing assistant message names the plan when the user's prompt does not.
  branch = [
    ...userSaid("go on"),
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `Reviewing ${P}` },
          { type: "toolCall", id: "c2", name: "read" },
        ],
      },
    },
  ];
  const fromIssuer = (await fire("tool_call", {
    toolName: "read",
    toolCallId: "c2/1",
    input: { path: skill },
  })) as {
    reason: string;
  };
  assert.match(fromIssuer.reason, /already auto-approved/);
  // Other files, and ungated skills, are not gated.
  assert.equal(
    await fire("tool_call", { toolName: "read", toolCallId: "c3", input: { path: `${REPO}/x` } }),
    undefined,
  );
  assert.equal(
    await fire("tool_call", {
      toolName: "read",
      toolCallId: "c4",
      input: { path: `${PLUGIN}/skills/explore/SKILL.md` },
    }),
    undefined,
  );
  branch = [];
});

test("tool_call: reading the skill of the phase in progress again is not gated", async () => {
  const skill = (name: string) => `${PLUGIN}/skills/${name}/SKILL.md`;
  const read = (name: string, id: string) =>
    fire("tool_call", { toolName: "read", toolCallId: id, input: { path: skill(name) } });
  const phase = (name: string, plans: string[]) => ({
    type: "custom",
    customType: "dev-phase",
    data: { skill: name, plans },
  });
  // review-feature was entered on this plan, which has since moved past it.
  branch = [phase("review-feature", ["12_pi/pr1.spec.md"]), ...userSaid("go on")];
  assert.equal(await read("review-feature", "p1"), undefined, "no plan named continues it");
  branch = [phase("review-feature", ["12_pi/pr1.spec.md"]), ...userSaid(`review ${P}`)];
  assert.equal(await read("review-feature", "p2"), undefined, "the same plan continues it");
  branch = [phase("review-feature", ["12_pi/pr9.spec.md"]), ...userSaid(`review ${P}`)];
  assert.match(
    ((await read("review-feature", "p3")) as { reason: string }).reason,
    /already auto-approved/,
    "another plan enters the phase",
  );
  // Entering another skill records it, so review-feature is entered again, and gated.
  branch = [phase("review-feature", ["12_pi/pr1.spec.md"]), ...userSaid("go on")];
  assert.equal(await read("explore", "p4"), undefined);
  assert.deepEqual(branch.at(-1), phase("explore", []));
  assert.equal(await read("explore", "p5"), undefined);
  assert.equal(branch.length, 3, "a repeated entry is recorded once");
  assert.match(
    ((await read("review-feature", "p6")) as { reason: string }).reason,
    /none was named/,
    "after another skill, review-feature is an entry, gated",
  );
  branch = [];
});

test("tool_call: the serial-test check and the record guard", async () => {
  const jest = (await fire("tool_call", {
    toolName: "bash",
    toolCallId: "b1",
    input: { command: "npx jest" },
  })) as {
    reason: string;
  };
  assert.match(jest.reason, /^\[dev\] .*jest without --runInBand/);
  const log = (await fire("tool_call", {
    toolName: "bash",
    toolCallId: "b2",
    input: { command: `echo x >> ${path.dirname(P)}/log` },
  })) as { reason: string };
  assert.match(log.reason, /written only by dev-stack\.ts/);
  const edited = (await fire("tool_call", {
    toolName: "edit",
    toolCallId: "e1",
    input: { path: P, edits: [{ oldText: "## Test Cases", newText: "## Tests" }] },
  })) as { reason: string };
  assert.match(edited.reason, /frozen/);
  // Pi matches every edit in the original file: this swap changes the spec, though applying the
  // second edit to the first one's output would put the original back.
  const swapped = (await fire("tool_call", {
    toolName: "edit",
    toolCallId: "e2",
    input: {
      path: P,
      edits: [
        { oldText: "AC-1 — outcome", newText: "TC-1 — scenario" },
        { oldText: "TC-1 — scenario", newText: "AC-1 — outcome" },
      ],
    },
  })) as { reason: string } | undefined;
  assert.match(swapped?.reason ?? "", /frozen/, "a swap of two spec lines is a spec change");
  const written = (await fire("tool_call", {
    toolName: "write",
    toolCallId: "w1",
    input: { path: "docs/plans/12_pi/log", content: "x" },
  })) as { reason: string };
  assert.match(
    written.reason,
    /written only by dev-stack\.ts/,
    "a relative path resolves against the cwd",
  );
  assert.equal(
    await fire("tool_call", { toolName: "bash", toolCallId: "b3", input: { command: "ls" } }),
    undefined,
  );
});

test("tool_result and tool_execution_end: a shell rollback is restored and reported", async () => {
  const before = read(P);
  const command = `sed -i 's/^Status: auto-approved/Status: planning/' ${P}`;
  assert.equal(
    await fire("tool_call", { toolName: "bash", toolCallId: "r1", input: { command } }),
    undefined,
  );
  exec(["bash", "-c", command], { cwd: REPO });
  const result = (await fire("tool_result", {
    toolName: "bash",
    toolCallId: "r1",
    content: [{ type: "text", text: "out" }],
  })) as { content: { text: string }[] };
  assert.equal(result.content[0]?.text, "out");
  assert.match(result.content[1]?.text ?? "", /^\[dev\] [\s\S]*never returns below approved/);
  assert.equal(read(P), before);
  // The call was post-checked, so its end compares nothing again.
  assert.equal(await fire("tool_execution_end", { toolName: "bash", toolCallId: "r1" }), undefined);
  assert.deepEqual(notes, []);

  // A call that never reached tool_result is compared at its end, and the report goes to the user.
  assert.equal(
    await fire("tool_call", { toolName: "bash", toolCallId: "r2", input: { command } }),
    undefined,
  );
  exec(["bash", "-c", command], { cwd: REPO });
  await fire("tool_execution_end", { toolName: "bash", toolCallId: "r2" });
  assert.equal(notes[0]?.[1], "warning");
  assert.match(notes[0]?.[0] ?? "", /never returns below approved/);
  assert.equal(read(P), before);
});

test("/dev-stack-* commands run dev-stack in-process", async () => {
  assert.deepEqual([...commands.keys()].sort(), [
    "dev-stack-check",
    "dev-stack-list",
    "dev-stack-next",
    "dev-stack-reopen",
    "dev-stack-resume",
    "dev-stack-review",
    "dev-stack-stop",
  ]);
  sent.length = 0;
  await withEnv(ENV, () => commands.get("dev-stack-next")?.handler("12_pi/pr1.spec.md --md", ctx));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.customType, "dev-stack");
  assert.ok(sent[0]?.content.includes("| pr1 | 🔷 auto-approved |"), sent[0]?.content);
  sent.length = 0;
  await withEnv(ENV, () => commands.get("dev-stack-next")?.handler("--md", ctx));
  assert.match(sent[0]?.content ?? "", /^Usage: \/dev-stack-next /);
  // A write records the user's decision and tells the model in a hidden note.
  sent.length = 0;
  await withEnv(ENV, () => commands.get("dev-stack-reopen")?.handler(P, ctx));
  assert.match(sent[0]?.content ?? "", /Reopened to planning/);
  assert.equal(sent[1]?.customType, "dev-stack-note");
  assert.equal(sent[1]?.display, false);
  assert.ok(read(P).includes("Status: planning"));
});
