// The shape every core command shares: it takes argv, env, and cwd as byte strings and returns
// its exit code and output, so bin/ CLIs, tests, and the Pi extension run it the same way. A
// command that hands off to another program (`exec` in the old scripts) returns `exec` instead.

import { spawnSync } from "node:child_process";
import { b, utf8 } from "./bytes.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type Ctx = { argv: readonly string[]; env: Env; cwd: string };

export type Out = {
  code: number;
  stdout: string;
  stderr: string;
  /** Run this argv with inherited stdio after writing the output, and exit with its status. */
  exec?: readonly string[];
};

export type Command = (ctx: Ctx) => Out;

/** Accumulates output; `fail` and friends end a command the way the old scripts' fail() did. */
export class Output {
  stdout = "";
  stderr = "";
  out(text: string): void {
    this.stdout += text;
  }
  err(text: string): void {
    this.stderr += text;
  }
  done(code = 0, exec?: readonly string[]): Out {
    return exec === undefined
      ? { code, stdout: this.stdout, stderr: this.stderr }
      : { code, stdout: this.stdout, stderr: this.stderr, exec };
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

/** The process's context as byte strings. */
export const processCtx = (): Ctx => {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = v === undefined ? undefined : b(v);
  return { argv: process.argv.slice(2).map(b), env, cwd: b(process.cwd()) };
};

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
  if (res.stdout) process.stdout.write(Buffer.from(res.stdout, "latin1"));
  if (res.stderr) process.stderr.write(Buffer.from(res.stderr, "latin1"));
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
