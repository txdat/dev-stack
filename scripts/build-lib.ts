// Shared by build.ts and build-agy.ts: compiles plugins/dev to JavaScript, copies its rules,
// skills, agents, and package files beside the output, and lets the caller add its harness's files.
// It builds into a sibling directory and swaps it in only when every step succeeded, so a failed
// or running build never leaves a partial plugin at the output.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
export const SRC = path.join(ROOT, "plugins/dev");
const COMMON_COPY = [
  ".gitignore",
  "agents",
  "package.json",
  "opencode/package.json",
  "rules",
  "skills",
];
// The build writes this into its output; only a directory holding it is replaced.
const MARK = ".dev-stack-build";

/** Whether `p` is strictly inside `dir`. */
const inside = (p: string, dir: string) => {
  const r = path.relative(dir, p);
  return r !== "" && r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
};

/** `p` with its nearest existing ancestor resolved to its real path; the rest is joined back. */
const realish = (p: string): string => {
  const rest: string[] = [];
  let at = p;
  while (!fs.existsSync(at)) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(fs.realpathSync(at), ...rest);
};

/** The output's real path, or why the build refuses to replace it. */
const target = (arg: string): { out: string } | { refuse: string } => {
  const real = realish(path.resolve(arg));
  const dist = path.join(ROOT, "dist");
  if (real === ROOT || inside(ROOT, real) || (inside(real, ROOT) && !inside(real, dist)))
    return { refuse: `${real} is the checkout, above it, or in it outside dist/` };
  if (fs.existsSync(real)) {
    if (!fs.statSync(real).isDirectory()) return { refuse: `${real} is not a directory` };
    if (!fs.existsSync(path.join(real, MARK)) && fs.readdirSync(real).length > 0)
      return { refuse: `${real} is not empty and holds no earlier build` };
  }
  return { out: real };
};

export interface Harness {
  /** The tsconfig files, relative to ROOT, compiled into the output. */
  configs: readonly string[];
  /** Adds and adapts the harness's files in the work directory after the common copy. */
  finish: (work: string) => void;
}

/** Builds `harness` into `outArg`; returns the exit code. */
export const build = (outArg: string, harness: Harness): number => {
  const t = target(outArg);
  if ("refuse" in t) {
    process.stderr.write(`build: refusing to replace ${t.refuse}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  const work = fs.mkdtempSync(`${t.out}.build-`);
  try {
    // tsc's own script under this runtime: node_modules/.bin/tsc names node in its shebang.
    const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
    for (const config of harness.configs) {
      const args = [tsc, "-p", path.join(ROOT, config), "--outDir", work];
      const ran = spawnSync(process.execPath, args, { stdio: "inherit" });
      if (ran.status !== 0) {
        process.stderr.write(
          `build: tsc -p ${config} failed${ran.error ? `: ${ran.error.message}` : ""}\n`,
        );
        return ran.status ?? 1;
      }
    }
    for (const rel of COMMON_COPY)
      fs.cpSync(path.join(SRC, rel), path.join(work, rel), { recursive: true });
    harness.finish(work);
    fs.writeFileSync(path.join(work, MARK), "");
    // mkdtemp creates the directory 0700.
    fs.chmodSync(work, 0o755);
    fs.rmSync(t.out, { recursive: true, force: true });
    fs.renameSync(work, t.out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`built ${path.relative(process.cwd(), t.out) || "."}\n`);
  return 0;
};

/** Runs a build script's CLI: `[--out <dir>]`, defaulting to `dist/<defaultOut>`. */
export const main = (script: string, defaultOut: string, harness: Harness): void => {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, "dist", defaultOut);
  if (args.length === 2 && args[0] === "--out" && args[1] !== undefined) out = args[1];
  else if (args.length !== 0) {
    process.stderr.write(`usage: node scripts/${script} [--out <dir>]\n`);
    process.exitCode = 2;
    return;
  }
  process.exitCode = build(out, harness);
};
