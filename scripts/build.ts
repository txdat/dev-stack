// Builds the installable plugin: plugins/dev compiled to JavaScript, with its rules, skills,
// agents, and manifests copied beside the output. The marketplace, the Pi package, and the DSH
// bundle point at it.
// It builds into a sibling directory and swaps it in only when every step succeeded, so a failed
// or running build never leaves a partial plugin at the output.
// Usage: node scripts/build.ts [--out <dir>]   (default dist/dev)

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const SRC = path.join(ROOT, "plugins/dev");
const COPY = [
  ".claude-plugin/plugin.json",
  ".gitignore",
  "agents",
  "hooks/hooks.json",
  "package.json",
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

const main = (args: string[]): number => {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out")) {
    process.stderr.write("usage: node scripts/build.ts [--out <dir>]\n");
    return 2;
  }
  const t = target(args[1] ?? path.join(ROOT, "dist/dev"));
  if ("refuse" in t) {
    process.stderr.write(`build: refusing to replace ${t.refuse}\n`);
    return 2;
  }
  fs.mkdirSync(path.dirname(t.out), { recursive: true });
  const work = fs.mkdtempSync(`${t.out}.build-`);
  try {
    const tsc = path.join(ROOT, "node_modules/.bin/tsc");
    // Both passes emit hooks/commands.js, which pi/dev.ts and hooks/register.ts import; the
    // output is the same, so the second overwrites the first.
    for (const config of ["tsconfig.build.json", "tsconfig.build-engine.json"]) {
      const ran = spawnSync(tsc, ["-p", path.join(ROOT, config), "--outDir", work], {
        stdio: "inherit",
      });
      if (ran.status !== 0) {
        process.stderr.write(
          `build: tsc -p ${config} failed${ran.error ? `: ${ran.error.message}` : ""}\n`,
        );
        return ran.status ?? 1;
      }
    }
    for (const rel of COPY)
      fs.cpSync(path.join(SRC, rel), path.join(work, rel), { recursive: true });
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

process.exitCode = main(process.argv.slice(2));
