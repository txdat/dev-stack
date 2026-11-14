// Mechanical checks for the dev phases: a test-first proof commit, a diff's artifacts, and a
// plan's PC Checks (../rules/plan.md#verification, ../skills/design-feature/SKILL.md#6-finish).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { b, stripNewlines, utf8 } from "./bytes.ts";
import { type Command, Exit, Output } from "./cli.ts";
import { git, isDir, isFile, readable, readBytes } from "./sys.ts";

const USAGE =
  "usage: dev-check.ts proof <commit> [--test path] [--stub path] | artifacts <base> [head] | pcs <plan> [--cwd dir] [PC-<n> ...]";

const block = (text: string): never => {
  throw new Exit(1, `BLOCK ${text}\n`);
};
const usage = (): never => block(USAGE);

/** rg's [[:space:]] inside a line. */
const S = "[ \\t\\v\\f\\r]";

const TEST_DECL = new RegExp(
  `#\\[(test|cfg\\(test\\))|\\bmod tests\\b|\\bdef test|\\bclass Test|\\bfunc (Test|Benchmark|Fuzz)|@(Test|ParameterizedTest|Nested)\\b|\\[(Test|Fact|Theory)\\]|\\b(it|test|describe)(\\.(each|only|skip))?${S}*\\(|\\bTEST(_F|_P|_CASE)?${S}*\\(|\\bfunction test`,
);
const THROWING = new RegExp(
  `(=>|return)${S}*(throw\\b|panic!|todo!|unimplemented!|unreachable!|raise\\b)`,
);
const VALUE = new RegExp(`return${S}+[^; \\t\\v\\f\\r]|=>${S}*[^;{ \\t\\v\\f\\r]`);
const BODYLESS = new RegExp(
  `^${S}*(pass|\\.\\.\\.)${S}*$|:${S}*(pass|\\.\\.\\.)${S}*$|\\)[^{]*\\{${S}*\\}${S}*$|^${S}*return${S}*;?${S}*$|:${S}*return${S}*$`,
);

/** Lines as a here-string feeds them to a line tool: `$(...)` output plus one newline. */
const hereLines = (text: string): string[] => stripNewlines(text).split("\n");

/** Added lines of a commit's diff for one path: `sed -n 's/^+\([^+]\)/\1/p'`. */
const additions = (cwd: string, commit: string, path: string): string =>
  stripNewlines(
    git(["show", "--format=", "--unified=0", commit, "--", path], { cwd })
      .stdout.split("\n")
      .filter((l) => /^\+[^+]/.test(l))
      .map((l) => `${l.slice(1)}\n`)
      .join(""),
  );

const TEST_DIRS =
  /^(test|tests|spec|specs|__tests__|fixtures|testdata)\/|\/(test|tests|spec|specs|__tests__|fixtures|testdata)\//i;

const proof = (cwd: string, argv: readonly string[], o: Output): Out2 => {
  if (argv.length < 2) usage();
  const commit = argv[1] as string;
  if (git(["rev-parse", "--verify", `${commit}^{commit}`], { cwd }).code !== 0)
    block(`unknown proof commit: ${commit}`);
  const tests: string[] = [];
  const stubs: string[] = [];
  for (let i = 2; i < argv.length; i += 2) {
    const kind = argv[i];
    const value = argv[i + 1];
    if (value === undefined) usage();
    if (kind === "--test") tests.push(value as string);
    else if (kind === "--stub") stubs.push(value as string);
    else usage();
  }
  let found = false;
  const tree = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit], { cwd });
  for (const path of tree.stdout.split("\n")) {
    if (path === "") continue;
    found = true;
    if (TEST_DIRS.test(path) || /_test\.|_spec\.|\.test\.|\.spec\./i.test(path)) continue;
    if (/Test\.|Spec\./.test(path)) continue;
    if (tests.includes(path)) {
      // --test exempts a path that does not look like a test, so it is the one way past the
      // non-test-path block below. Require the claim to be backed by test code: the commit adds a
      // test declaration, or the file held one before the commit.
      const added = hereLines(additions(cwd, commit, path));
      const before = git(["show", `${commit}^:${path}`], { cwd });
      const beforeLines = before.code === 0 ? before.stdout.split("\n") : [];
      if (!added.some((l) => TEST_DECL.test(l)) && !beforeLines.some((l) => TEST_DECL.test(l)))
        block(
          `--test path adds no test code: ${path} (declare a real stub with --stub, or commit the test)`,
        );
      continue;
    }
    if (!stubs.includes(path)) block(`proof touches non-test path: ${path}`);
    const added = hereLines(additions(cwd, commit, path));
    // Throwing expression bodies are the permitted stub form (../rules/plan.md#verification).
    if (added.filter((l) => !THROWING.test(l)).some((l) => VALUE.test(l)))
      block(`stub contains value implementation: ${path}`);
    // A body-less stub returns no value, so the check above never sees it, but it still returns
    // None/null/zero implicitly; plan.md#verification permits only a throwing stub.
    if (added.some((l) => BODYLESS.test(l)))
      block(
        b(
          `stub has a body-less implementation (pass / ... / empty block / bare return): ${utf8(path)} — a stub must throw (rules/plan.md#verification)`,
        ),
      );
  }
  if (!found) block(`proof commit is empty: ${commit}`);
  o.out(`PASS proof commit ${commit}\n`);
  return { code: 0 };
};

const artifacts = (cwd: string, argv: readonly string[], o: Output): Out2 => {
  if (argv.length < 2 || argv.length > 3) usage();
  const base = argv[1] as string;
  if (base === "") block("invalid ref: empty base");
  if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd }).code !== 0)
    block(`invalid ref: ${base}`);
  const end = argv[2] || "HEAD";
  if (git(["rev-parse", "--verify", "--quiet", `${end}^{commit}`], { cwd }).code !== 0)
    block(`invalid ref: ${end}`);
  const range = `${base}..${end}`;
  const added = hereLines(
    git(["diff", range], { cwd })
      .stdout.split("\n")
      .filter((l) => !l.startsWith("+++ ") && l.startsWith("+"))
      .map((l) => `${l}\n`)
      .join(""),
  );
  const numbered = (re: RegExp) =>
    added
      .map((l, i) => (re.test(l) ? `${i + 1}:${l}` : undefined))
      .filter((x): x is string => x !== undefined)
      .join("\n");
  // Conflict markers are never legitimate; debug-like output may be (a CLI's print), so
  // review-code judges those lines instead of the scan blocking.
  const markers = numbered(/^\+(<{7}|>{7})( |$)|^\+={7}$/);
  if (markers !== "") block(`conflict markers in ${range}\n${markers}`);
  o.out(`PASS artifact scan ${range}\n`);
  const findings = numbered(/System\.out|console\.log|\/\/ DEBUG|\bprint\(/);
  if (findings !== "")
    o.out(`REVIEW debug-like lines; remove leftovers, keep intended output:\n${findings}\n`);
  return { code: 0 };
};

/** "<id> TAB <command>" per PC declared under ## Implementation Steps, outside fences. */
export const planPcs = (text: string): [string, string][] => {
  const out: [string, string][] = [];
  let fenced = false;
  let sec: string | undefined;
  const rows = text.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  for (const row of rows) {
    if (/^[ \t\n\v\f\r]*(```|~~~)/.test(row)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (row.startsWith("## ")) {
      sec = row.slice(3).replace(/[ \t\n\v\f\r]+$/, "");
      continue;
    }
    if (sec !== "Implementation Steps") continue;
    const lead = row.replace(/^[ \t\n\v\f\r]*([-*][ \t\n\v\f\r]*)?/, "");
    const m = /^PC-[1-9][0-9]*/.exec(lead);
    if (!m || /[A-Za-z0-9_]/.test(lead.charAt(m[0].length))) continue;
    const at = lead.indexOf("Check:");
    let cmd = at >= 0 ? lead.slice(at + 6) : "";
    cmd = cmd.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
    if (/^`[^`]*`/.test(cmd)) {
      cmd = cmd.slice(1);
      cmd = cmd.slice(0, cmd.indexOf("`"));
    }
    // `read` with IFS=TAB strips the command's leading and trailing tabs.
    out.push([m[0], cmd.replace(/^\t+|\t+$/g, "")]);
  }
  return out;
};

/** Runs a Check as `timeout 120 bash -c "$cmd" </dev/null 2>&1` does: status and merged output. */
const runCheck = (cmd: string, cwd: string): { code: number; out: string } => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/dev-check-`);
  const file = `${dir}/out`;
  const fd = fs.openSync(file, "w");
  try {
    const r = spawnSync("bash", ["-c", utf8(cmd)], {
      cwd: utf8(cwd),
      stdio: ["ignore", fd, fd],
      timeout: 120_000,
      killSignal: "SIGTERM",
    });
    fs.closeSync(fd);
    const out = readBytes(file) ?? "";
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    // As bash reports them: 127 when bash cannot start, 128 plus the number for a signal.
    const killed = r.signal ? 128 + (os.constants.signals[r.signal] ?? 0) : 1;
    const code = timedOut ? 124 : r.error && !r.pid ? 127 : (r.status ?? killed);
    return { code, out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const pcs = (cwd0: string, argv: readonly string[], o: Output): Out2 => {
  if (argv.length < 2) usage();
  const plan = argv[1] as string;
  let cwd = ".";
  const only: string[] = [];
  for (let i = 2; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === "--cwd") {
      if (i + 1 >= argv.length) usage();
      cwd = argv[i + 1] as string;
      i += 2;
    } else if (/^PC-[1-9]/.test(a)) {
      only.push(a);
      i++;
    } else usage();
  }
  const abs = (p: string) => (p.startsWith("/") ? p : `${cwd0}/${p}`);
  if (!isFile(abs(plan)) || !readable(abs(plan))) block(`plan not found: ${plan}`);
  if (!isDir(abs(cwd))) block(`no directory: ${cwd}`);
  const list = planPcs(readBytes(abs(plan)) ?? "");
  if (list.length === 0 && only.length === 0) {
    o.out("PASS no PCs\n");
    return { code: 0 };
  }
  let failed = false;
  let ran = false;
  for (const [id, cmd] of list.length > 0 ? list : [["", ""] as [string, string]]) {
    if (only.length > 0 && !only.includes(id)) continue;
    ran = true;
    if (cmd === "") {
      o.out(`FAIL ${id}: no Check command\n`);
      failed = true;
      continue;
    }
    const r = runCheck(cmd, abs(cwd));
    if (r.code === 0) o.out(`PASS ${id}: ${cmd}\n`);
    else {
      failed = true;
      o.out(`FAIL ${id} (exit ${r.code}): ${cmd}\n`);
      const text = stripNewlines(r.out);
      if (text !== "") for (const l of text.split("\n").slice(-5)) o.out(`  ${l}\n`);
    }
  }
  if (!ran) block(`none of the named PCs is in ${plan}`);
  for (const id of only)
    if (!list.some(([pid]) => pid === id)) {
      o.out(`FAIL ${id}: not in ${plan}\n`);
      failed = true;
    }
  return { code: failed ? 1 : 0 };
};

type Out2 = { code: number };

export const devCheck: Command = (ctx) => {
  const o = new Output();
  try {
    const sub = ctx.argv[0];
    const r =
      sub === "proof"
        ? proof(ctx.cwd, ctx.argv, o)
        : sub === "artifacts"
          ? artifacts(ctx.cwd, ctx.argv, o)
          : sub === "pcs"
            ? pcs(ctx.cwd, ctx.argv, o)
            : usage();
    return o.done(r.code);
  } catch (e) {
    if (e instanceof Exit) {
      o.err(e.text);
      return o.done(e.code);
    }
    throw e;
  }
};
