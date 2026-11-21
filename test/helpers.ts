// Shared fixtures: scratch Git repositories under /tmp, in-process runs of the core commands, and
// bin/hook.ts runs. Every repo ignores its docs/plans through .git/info/exclude, Git reads no
// global or system config, and AI_WORKTREES_ROOT keeps worktrees out of ~/wt.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { b, utf8 } from "../plugins/dev/core/bytes.ts";
import type { Command } from "../plugins/dev/core/cli.ts";
import { type GateResult, gateCheck, gateDesign } from "../plugins/dev/core/gate-check.ts";
import type { HookInput } from "../plugins/dev/core/hook-input.ts";
import { NODE } from "../plugins/dev/hooks/commands.ts";

/** The shipped CLI invocation, as argv and as a shell prefix. */
export { NODE };
export const RUN = NODE.join(" ");

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/dev");

// Child processes (git, gh) inherit this; core reads its own env from the ctx a test passes.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_AUTHOR_NAME"] = "dev-test";
process.env["GIT_AUTHOR_EMAIL"] = "dev-test@example.test";
process.env["GIT_COMMITTER_NAME"] = "dev-test";
process.env["GIT_COMMITTER_EMAIL"] = "dev-test@example.test";
// Git's default excludes file is under XDG_CONFIG_HOME; the user's must decide nothing here.
process.env["XDG_CONFIG_HOME"] = fs.mkdtempSync("/tmp/dev-test-xdg.");
// Every child, such as a dev CLI a shell command runs, keeps worktrees out of ~/wt; a test
// passes its own AI_WORKTREES_ROOT to in-process runs.
process.env["AI_WORKTREES_ROOT"] = fs.mkdtempSync("/tmp/dev-test-worktrees.");

/** A fresh directory under /tmp, its realpath. */
export const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join("/tmp", `${prefix}.`)));

export type Ran = { code: number; out: string; err: string; all: string };

/** Runs argv without a shell; text is UTF-8. */
export const exec = (
  argv: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Ran => {
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd as string, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};

/** git in cwd; its stdout without the trailing newline. A failure throws. */
export const git = (cwd: string, ...args: string[]): string => {
  const r = exec(["git", "-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.err}`);
  return r.out.replace(/\n$/, "");
};

/** Whether git in cwd succeeds. */
export const gitOk = (cwd: string, ...args: string[]): boolean =>
  exec(["git", "-C", cwd, ...args]).code === 0;

/** A repository on main with one commit, docs/plans ignored. */
export const repo = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
  fs.appendFileSync(path.join(dir, ".git/info/exclude"), "/docs/plans/\n");
  return fs.realpathSync(dir);
};

export const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

export const read = (file: string): string => fs.readFileSync(file, "utf8");

/** A plan's text from header fields, in order, then the body. */
export const planText = (fields: Record<string, string>, body = "## Goal\ng\n"): string =>
  `# plan\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("")}\n${body}`;

export type Env = Record<string, string | undefined>;

/**
 * Runs a core command in-process as its bin/ CLI would, with UTF-8 text in and out. `env` adds to
 * this process's. A command that hands off (`exec`) runs that program, as the CLI does.
 */
export const run = (
  command: Command,
  argv: readonly string[],
  opts: { cwd: string; env?: Env },
): Ran => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env }))
    env[k] = v === undefined ? undefined : b(v);
  const res = command({ argv: argv.map(b), env, cwd: b(opts.cwd) });
  let out = utf8(res.stdout);
  let err = utf8(res.stderr);
  let all = (res.chunks ?? []).map(([, t]) => utf8(t)).join("") || out + err;
  let code = res.code;
  if (res.exec) {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = utf8(v);
    const r = exec(res.exec.map(utf8), { cwd: opts.cwd, env: childEnv });
    out += r.out;
    err += r.err;
    all += r.all;
    code = r.code;
  }
  return { code, out, err, all };
};

const byteEnv = (env: Env = {}): Env => {
  const out: Env = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env }))
    out[k] = v === undefined ? undefined : b(v);
  return out;
};

const reason = (r: GateResult): string =>
  r === undefined ? "" : utf8("block" in r ? r.block : r.postBlock);

/** The gate's verdict on a hook call, in-process: its reason, or "" when it passes. */
export const gate = (input: HookInput, opts: { cwd: string; env?: Env }): string =>
  reason(gateCheck(input, { cwd: b(opts.cwd), env: byteEnv(opts.env) }));

/** design-feature's stack check on a plan: its reason, or "" when it passes. */
export const design = (plan: string, opts: { cwd: string; env?: Env }): string =>
  reason(gateDesign(b(plan), { cwd: b(opts.cwd), env: byteEnv(opts.env) }));

/** Runs a bin/ CLI under node, for the entry points themselves. */
export const cli = (
  name: string,
  argv: readonly string[],
  opts: { cwd: string; env?: Env; input?: string },
): Ran =>
  exec([...NODE, path.join(PLUGIN, "bin", `${name}.ts`), ...argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });

/** Sets process.env keys for the body, then restores them. */
export const withEnv = <T>(vars: Env, body: () => T): T => {
  const saved: Env = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  const set = (v: Env) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  set(vars);
  try {
    return body();
  } finally {
    set(saved);
  }
};
