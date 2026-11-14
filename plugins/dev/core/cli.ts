// The shape every core command shares: it takes argv, env, and cwd as byte strings and returns
// its exit code and output, so bin/ CLIs, tests, and the Pi extension run it the same way. A
// command that hands off to another program (`exec` in the old scripts) returns `exec` instead.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { b, utf8 } from "./bytes.ts";
import { type Ran, type RunOptions, run } from "./sys.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type Ctx = { argv: readonly string[]; env: Env; cwd: string };

export type Out = {
  code: number;
  stdout: string;
  stderr: string;
  /** Run this argv with inherited stdio after writing the output, and exit with its status. */
  exec?: readonly string[];
  /** stdout (1) and stderr (2) text in the order it was written, so `2>&1` reads as it did. */
  chunks?: readonly (readonly [1 | 2, string])[];
};

export type Command = (ctx: Ctx) => Out;

/** Accumulates output; `fail` and friends end a command the way the old scripts' fail() did. */
export class Output {
  stdout = "";
  stderr = "";
  readonly chunks: [1 | 2, string][] = [];
  out(text: string): void {
    this.stdout += text;
    if (text !== "") this.chunks.push([1, text]);
  }
  err(text: string): void {
    this.stderr += text;
    if (text !== "") this.chunks.push([2, text]);
  }
  done(code = 0, exec?: readonly string[]): Out {
    const res: Out = { code, stdout: this.stdout, stderr: this.stderr, chunks: this.chunks };
    return exec === undefined ? res : { ...res, exec };
  }
}

/** Thrown to end a command with a message on stderr and an exit code. */
export class Exit extends Error {
  readonly code: number;
  readonly text: string;
  constructor(code: number, text = "") {
    super(text);
    this.code = code;
    this.text = text;
  }
}

export function fail(text: string, code = 1): never {
  throw new Exit(
    code,
    `${text}
`,
  );
}

/** Runs a command body, turning Exit into its output. */
export const guard = (o: Output, body: () => Out): Out => {
  try {
    return body();
  } catch (e) {
    if (e instanceof Exit) {
      o.err(e.text);
      return o.done(e.code);
    }
    throw e;
  }
};

/** An env of UTF-8 text, such as process.env, as byte strings. */
export const byteEnv = (env: NodeJS.ProcessEnv): Env => {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === undefined ? undefined : b(v);
  return out;
};

/** The process's context as byte strings. */
export const processCtx = (): Ctx => ({
  argv: process.argv.slice(2).map(b),
  env: byteEnv(process.env),
  cwd: b(process.cwd()),
});

/** The env a child gets back from a byte-string Env. */
export const childEnv = (env: Env): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = utf8(v);
  return out;
};

/** Entry point for a bin/ CLI. */
export const main = (command: Command): void => {
  const ctx = processCtx();
  const res = command(ctx);
  if (res.chunks)
    for (const [fd, text] of res.chunks) fs.writeSync(fd, Buffer.from(text, "latin1"));
  else {
    if (res.stdout) fs.writeSync(1, Buffer.from(res.stdout, "latin1"));
    if (res.stderr) fs.writeSync(2, Buffer.from(res.stderr, "latin1"));
  }
  if (res.exec) {
    const [cmd, ...args] = res.exec.map(utf8);
    if (cmd === undefined) {
      process.exitCode = res.code;
      return;
    }
    const ran = spawnSync(cmd, args, {
      stdio: "inherit",
      cwd: utf8(ctx.cwd),
      env: childEnv(ctx.env),
    });
    if (ran.error) {
      process.stderr.write(`${cmd}: ${ran.error.message}\n`);
      process.exitCode = 127;
      return;
    }
    process.exitCode = ran.status ?? 1;
    return;
  }
  process.exitCode = res.code;
};

/**
 * Runs a command as a `set -e` script line does: its stderr passes through, its stdout goes to
 * `stdout` ("out", "err" for `>&2`, or "drop" for `>/dev/null`), and a failure ends the command
 * with the same status. Returns the result for a caller that reads stdout ("keep").
 */
export const sh = (
  o: Output,
  argv: readonly string[],
  opts: RunOptions & { stdout?: "out" | "err" | "drop" | "keep" } = {},
): Ran => {
  const { stdout = "out", ...rest } = opts;
  const r = run(argv, rest);
  o.err(r.stderr);
  if (stdout === "out") o.out(r.stdout);
  else if (stdout === "err") o.err(r.stdout);
  if (r.code !== 0) throw new Exit(r.code);
  return r;
};
