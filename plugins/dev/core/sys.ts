// Process and file-system primitives over byte strings (bytes.ts). Synchronous: each CLI or hook
// call is one short pass, and Pi calls core in-process the same way.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utf8 } from "./bytes.ts";

// Paths and argv are byte strings; fs takes them as Buffers, spawn as UTF-8 text.
/** A byte-string path as the Buffer fs takes. */
export const P = (p: string): Buffer => Buffer.from(p, "latin1");

export type Ran = { code: number; stdout: string; stderr: string };

export type RunOptions = {
  cwd?: string;
  /** Bytes for stdin, as a byte string. */
  input?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Runs argv without a shell. A command that cannot start reads as exit 127, one killed by a signal
 * as 128 plus its number, and one stopped for passing the output limit as a failure with the
 * reason on stderr, never as a success with the output it had written.
 */
export const run = (argv: readonly string[], opts: RunOptions = {}): Ran => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("run: empty argv");
  const res = spawnSync(utf8(cmd), args.map(utf8), {
    cwd: opts.cwd === undefined ? undefined : utf8(opts.cwd),
    env: opts.env,
    input: opts.input === undefined ? undefined : Buffer.from(opts.input, "latin1"),
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error && !res.pid) return { code: 127, stdout: "", stderr: String(res.error.message) };
  const killed = res.signal ? 128 + (os.constants.signals[res.signal] ?? 0) : 1;
  const code = res.status ?? killed;
  return {
    code: res.error && code === 0 ? 1 : code,
    stdout: res.stdout?.toString("latin1") ?? "",
    stderr: (res.stderr?.toString("latin1") ?? "") + (res.error ? `${res.error.message}\n` : ""),
  };
};

/** Runs git; `cwd` is passed as `-C` when given. */
export const git = (args: readonly string[], opts: RunOptions = {}): Ran => {
  const { cwd, ...rest } = opts;
  return run(["git", ...(cwd === undefined ? [] : ["-C", cwd]), ...args], rest);
};

/** fs.lstat, undefined when the path is missing. */
export const lstat = (p: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(P(p));
  } catch {
    return undefined;
  }
};

/** fs.stat, undefined when the path is missing. */
export const stat = (p: string): fs.Stats | undefined => {
  try {
    return fs.statSync(P(p));
  } catch {
    return undefined;
  }
};

/** `[[ -f p ]]`: a regular file, following links. */
export const isFile = (p: string): boolean => stat(p)?.isFile() ?? false;
/** `[[ -d p ]]`. */
export const isDir = (p: string): boolean => stat(p)?.isDirectory() ?? false;
/** `[[ -e p ]]`. */
export const exists = (p: string): boolean => stat(p) !== undefined;
/** `[[ -L p ]]`. */
export const isLink = (p: string): boolean => lstat(p)?.isSymbolicLink() ?? false;
/** `[[ -s p ]]`: exists with a size above zero. */
export const nonEmpty = (p: string): boolean => (stat(p)?.size ?? 0) > 0;
/** `[[ -r p ]]`. */
export const readable = (p: string): boolean => {
  try {
    fs.accessSync(P(p), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** A file's bytes as a byte string; undefined when it cannot be read. */
export const readBytes = (p: string): string | undefined => {
  try {
    return fs.readFileSync(P(p)).toString("latin1");
  } catch {
    return undefined;
  }
};

/** Writes a byte string. */
export const writeBytes = (p: string, bytes: string, mode?: number): void => {
  fs.writeFileSync(P(p), Buffer.from(bytes, "latin1"), mode === undefined ? {} : { mode });
};

/**
 * `realpath -m`: links resolved where components exist, `..` applied after resolving. A relative
 * `p` resolves against `cwd`, the caller's directory.
 */
export const realpathM = (p: string, cwd: string): string => {
  let hops = 0;
  const walk = (base: string, rel: string): string => {
    let cur = base;
    for (const part of rel.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        cur = path.dirname(cur);
        continue;
      }
      const next = cur === "/" ? `/${part}` : `${cur}/${part}`;
      const st = lstat(next);
      if (st?.isSymbolicLink()) {
        if (++hops > 40) return next;
        const target = fs.readlinkSync(P(next), { encoding: "latin1" });
        cur = target.startsWith("/") ? walk("/", target) : walk(cur, target);
      } else {
        cur = next;
      }
    }
    return cur;
  };
  return p.startsWith("/") ? walk("/", p) : walk(walk("/", cwd), p);
};

/** `dirname --`. */
export const dirname = (p: string): string => {
  const s = p.replace(/\/+$/, "");
  if (s === "") return p.startsWith("/") ? "/" : ".";
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  const d = s.slice(0, i).replace(/\/+$/, "");
  return d === "" ? "/" : d;
};

/** `basename --`. */
export const basename = (p: string): string => {
  const s = p.replace(/\/+$/, "");
  if (s === "") return p.startsWith("/") ? "/" : "";
  return s.slice(s.lastIndexOf("/") + 1);
};

/** Files `dir/<prefix>*<suffix>`, as a glob lists them: existing names only, unsorted. */
export const globNames = (dir: string, prefix: string, suffix: string): string[] => {
  let names: string[];
  try {
    names = fs.readdirSync(P(dir), { encoding: "latin1" });
  } catch {
    return [];
  }
  return names
    .filter(
      (n) =>
        !n.startsWith(".") &&
        n.length >= prefix.length + suffix.length &&
        n.startsWith(prefix) &&
        n.endsWith(suffix),
    )
    .map((n) => `${dir}/${n}`);
};
