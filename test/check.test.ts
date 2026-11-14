import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { devCheck } from "../plugins/dev/core/check.ts";
import { git, repo, run, tmp, write } from "./helpers.ts";

const setup = () => {
  const dir = repo(`${tmp("dev-check-test")}/r`);
  write(`${dir}/README.md`, "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "readme");
  const check = (...argv: string[]) => run(devCheck, argv, { cwd: dir });
  const ok = (...argv: string[]) => {
    const r = check(...argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.all}`);
    return r;
  };
  const bad = (...argv: string[]) => {
    const r = check(...argv);
    assert.notEqual(r.code, 0, `expected a block: ${argv.join(" ")}: ${r.all}`);
    return r;
  };
  const commit = (msg: string, files: Record<string, string> = {}) => {
    for (const [f, t] of Object.entries(files)) write(`${dir}/${f}`, t);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "--allow-empty", "-m", msg);
  };
  const reset = (to: string) => git(dir, "reset", "-q", "--hard", to);
  return { dir, check, ok, bad, commit, reset };
};

test("proof: test-first commits, test paths, inline tests, and stubs", () => {
  const { dir, ok, bad, commit, reset } = setup();
  commit("test(red): unit", { "tests/unit_test.py": "assert behavior\n" });
  ok("proof", git(dir, "rev-parse", "HEAD"));

  commit("test(red): empty");
  bad("proof", "HEAD");
  reset("HEAD~1");

  commit("test(red): bad stub", { "src/unit.py": "return 1\n" });
  bad("proof", "HEAD", "--stub", "src/unit.py");
  reset("HEAD~1");

  commit("test(red): inline rust test", { "src/lib.rs": "#[test]\nfn behavior() {}\n" });
  ok("proof", "HEAD", "--test", "src/lib.rs");

  // --test is the only way past the non-test-path block, so it must be backed by test code:
  // declaring a plain implementation file as a test cannot launder it.
  reset("HEAD~1");
  commit("test(red): smuggled impl", { "src/impl.py": "def f():\n    return 42\n" });
  bad("proof", "HEAD", "--test", "src/impl.py");
  bad("proof", "HEAD", "--stub", "src/impl.py");
  bad("proof", "HEAD");

  reset("HEAD~1");
  commit("test(red): inline rust test again", { "src/lib.rs": "#[test]\nfn behavior() {}\n" });
  ok("proof", "HEAD", "--test", "src/lib.rs");

  // A revised plan's test(update) edits or deletes existing in-source test code.
  commit("test(update): change an inline rust test", {
    "src/lib.rs": "#[test]\nfn behavior() { assert_eq!(1, 2); }\n",
  });
  ok("proof", "HEAD", "--test", "src/lib.rs");
  commit("test(update): delete an inline rust test", { "src/lib.rs": "fn lib() {}\n" });
  ok("proof", "HEAD", "--test", "src/lib.rs");
  reset("HEAD~2");

  // Files past the pipe buffer.
  let big = "#[cfg(test)]\nmod tests {\n#[test]\nfn behavior() {}\n}\n";
  for (let i = 1; i <= 2000; i++) big += `// padding line ${i} for a file past the pipe buffer\n`;
  commit("test(red): large inline rust test", { "src/big.rs": big });
  ok("proof", "HEAD", "--test", "src/big.rs");
  commit("test(update): edit a large inline rust test", {
    "src/big.rs": `${big}// edited at the end\n`,
  });
  ok("proof", "HEAD", "--test", "src/big.rs");
  reset("HEAD~2");

  commit("test(red): throwing stubs", {
    "src/stub.rs": 'fn stub() -> u32 { match 0 { _ => todo!("later") } }\n',
    "src/Stub.cs": "int Foo() => throw new NotImplementedException();\n",
  });
  ok("proof", "HEAD", "--stub", "src/stub.rs", "--stub", "src/Stub.cs");

  // A body-less stub returns None/null/zero implicitly: no `return` for the value-implementation
  // scan to catch, but enough to turn a RED test green.
  const stubs: [string, string, boolean][] = [
    ["src/stub.py", "def apply(tx):\n    pass\n", false],
    ["src/stub.go", "func Apply(tx Tx) Receipt {}\n", false],
    ["src/stub.py", "def apply(tx):\n    return\n", false],
    ["src/stub.py", "def apply(tx):\n    raise NotImplementedError\n", true],
  ];
  for (const [file, text, passes] of stubs) {
    reset("HEAD~1");
    commit("test(red): stub", { [file]: text });
    (passes ? ok : bad)("proof", "HEAD", "--stub", file);
  }
});

test("artifacts: conflict markers block, debug-like lines are listed, bad refs block", () => {
  const { check, ok, bad, commit } = setup();
  commit("test(red): unit", { "tests/unit_test.py": "assert behavior\n" });
  ok("artifacts", "HEAD~1", "HEAD");

  // Debug-like lines are listed for review-code to judge; they do not block.
  commit("debug", { "src/unit.js": 'console.log("debug")\n' });
  assert.match(ok("artifacts", "HEAD~1", "HEAD").out, /REVIEW[\s\S]*console\.log\("debug"\)/);

  // Conflict markers block, and the report renders newlines.
  commit("conflict", { "src/conflict.txt": "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n" });
  const blocked = bad("artifacts", "HEAD~1", "HEAD").all;
  assert.ok(!blocked.includes("\\n"), blocked);
  assert.match(blocked, /\n.*<<<<<<</);
  commit("resolve conflict", { "src/conflict.txt": "a\n" });
  ok("artifacts", "HEAD~1", "HEAD");

  // Marker-like text that is not a whole marker does not block.
  commit("marker-like text", { "src/notes.md": "Title\n==========\n>>>>>>>>> quoted\n" });
  ok("artifacts", "HEAD~1", "HEAD");

  // An unresolvable ref must block, not scan an empty diff and pass.
  bad("artifacts", "nonexistent-ref", "HEAD");
  bad("artifacts", "HEAD", "nonexistent-ref");
  bad("artifacts", "", "HEAD");

  // `print(` inside a longer identifier is not a debug print.
  commit("identifiers containing print", { "src/names.py": "pprint(x)\nbuild_blueprint(y)\n" });
  assert.ok(!check("artifacts", "HEAD~1", "HEAD").out.includes("REVIEW"));

  // Scanned code is echoed verbatim: a `\c` must not truncate the report.
  commit("escape in finding", { "src/escape.py": 'print("a\\cb")\n' });
  assert.ok(check("artifacts", "HEAD~1", "HEAD").out.includes("a\\cb"));
});

test("pcs: every PC Check under Implementation Steps in one batch", () => {
  const { dir, check, bad } = setup();
  const plan = `${dir}/pr1.spec.md`;
  write(`${dir}/src/gate.py`, "def gate():\n  pass\n");
  const steps = [
    "# PCs",
    "Status: planning",
    "## Implementation Steps",
    "ST-1 — change — satisfies TC-1",
    '  PC-1 — gate() exists — Check: `grep -q "def gate" src/gate.py` (the definition)',
    '  PC-2 — no caller of old() — Check: ! grep -rq "old(" src',
    "```",
    "  PC-9 — fenced — Check: false",
    "```",
  ].join("\n");
  write(plan, `${steps}\n## Test Cases\nPC-8 — elsewhere — Check: false\n`);
  const all = check("pcs", plan);
  assert.equal(
    all.out,
    'PASS PC-1: grep -q "def gate" src/gate.py\nPASS PC-2: ! grep -rq "old(" src\n',
  );

  write(
    plan,
    `${steps}\n  PC-3 — a missing file — Check: test -f src/missing.py\n  PC-4 — no check\n`,
  );
  const failing = check("pcs", plan);
  assert.equal(failing.code, 1);
  assert.ok(failing.out.includes("FAIL PC-3 (exit 1): test -f src/missing.py"), failing.out);
  assert.ok(failing.out.includes("FAIL PC-4: no Check command"), failing.out);

  const named = run(devCheck, ["pcs", plan, "--cwd", dir, "PC-1"], { cwd: "/" });
  assert.equal(named.out, 'PASS PC-1: grep -q "def gate" src/gate.py\n');

  bad("pcs", plan, "PC-7");
  const unknown = check("pcs", plan, "PC-1", "PC-7");
  assert.equal(unknown.code, 1);
  assert.ok(unknown.out.includes("FAIL PC-7: not in"), unknown.out);

  // A Check that reads its input does not swallow later PCs.
  const stdinPlan = `${dir}/pr2.spec.md`;
  write(
    stdinPlan,
    "# S\nStatus: planning\n## Implementation Steps\n  PC-1 — reads input — Check: `cat >/dev/null`\n  PC-2 — fails — Check: false\n",
  );
  const stdin = check("pcs", stdinPlan);
  assert.equal(stdin.code, 1);
  assert.ok(stdin.out.includes("FAIL PC-2"), stdin.out);

  // A Check killed by a signal reads as bash reports it: 128 plus the signal's number.
  const killedPlan = `${dir}/pr3.spec.md`;
  write(
    killedPlan,
    "# S\nStatus: planning\n## Implementation Steps\n  PC-1 — killed — Check: kill -KILL $$\n",
  );
  const killed = check("pcs", killedPlan);
  assert.equal(killed.code, 1);
  assert.ok(killed.out.includes("FAIL PC-1 (exit 137)"), killed.out);

  assert.equal(check("pcs", `${dir}/README.md`).out, "PASS no PCs\n");
  bad("pcs", `${dir}/README.md`, "PC-1");
  assert.ok(!fs.existsSync(`${dir}/nowhere`));
  bad("pcs", plan, "--cwd", `${dir}/nowhere`);
});
