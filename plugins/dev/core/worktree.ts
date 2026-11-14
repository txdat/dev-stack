// Main-agent-only worktree setup and cleanup, except that a reviewer may run scratch-diff on its
// scratch; never edits, copies, or removes a plan.

import * as fs from "node:fs";
import * as os from "node:os";
import { b, byteCompare, stripNewlines } from "./bytes.ts";
import { type Command, fail, guard, Output, sh } from "./cli.ts";
import { PlanLib } from "./plan-lib.ts";
import {
  basename,
  exists,
  git,
  isDir,
  isFile,
  isLink,
  nonEmpty,
  P,
  readBytes,
  realpathM,
  writeBytes,
} from "./sys.ts";
import { mainRoot } from "./utils.ts";

const USAGE = [
  "Usage: dev-worktree.ts create <slug> <branch> <parent>",
  "       dev-worktree.ts link-deps <worktree> [dependency-name ...]",
  "       dev-worktree.ts isolate-dep <worktree> <dependency-name>",
  "       dev-worktree.ts remove <worktree>",
  "       dev-worktree.ts scratch <name> <ref> [patch ...]",
  "       dev-worktree.ts scratch-diff <scratch> [-- <path> ...]",
  "       dev-worktree.ts scratch-remove <scratch>",
  "create makes <repo>-<slug> under $AI_WORKTREES_ROOT, or $HOME/work/wt, on <branch> from <parent>,",
  "or on <branch> as it is when it exists, and prints the new path.",
  "link-deps defaults to node_modules vendor .venv venv Pods.",
  "Dependencies must be direct-child directory names. Existing local content is preserved.",
  "remove unlinks link-deps links, deletes a clean worktree, then its local branch only when origin/<branch> has the same tip;",
  'it prints "deleted <branch>" or "kept <branch>", with the reason for keeping on stderr.',
  "scratch makes a detached <repo>-<name> under <worktrees root>/scratch at <ref>, applies the patches three-way",
  "(removing it if one fails), links dependencies, and prints its path. scratch-diff prints the changes since <ref>,",
  "new unignored files included, as a patch limited to the paths given; it omits dependency links, isolated",
  "dependencies (default link-deps names <ref> does not track, including ones a patch created), and submodule changes.",
  "A ref resolves where the command runs. scratch-remove deletes the scratch, never a link target.",
  "Scratch commands refuse other worktrees; run them from inside the repository or a worktree, not a dependency link.",
  "Requires the owning phase authorization; does not approve a plan or install dependencies.",
].join("\n");

const DEFAULT_DEPS = ["node_modules", "vendor", ".venv", "venv", "Pods"];

const validName = (name: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
    fail(`Invalid directory name: ${name}`);
};

export const devWorktree: Command = (ctx) => {
  const o = new Output();
  return guard(o, () => {
    const argv = ctx.argv;
    if (argv[0] === "--help" || argv[0] === "-h") {
      o.out(`${USAGE}\n`);
      return o.done();
    }
    if (argv.length === 0) {
      o.err(`${USAGE}\n`);
      return o.done(2);
    }
    const MAIN = mainRoot(ctx.cwd, ctx.env, o);
    const lib = new PlanLib(MAIN, ctx);
    const SCRATCH = `${lib.worktreesRoot}/scratch`;
    const env = ctx.env;
    const abs = (p: string): string => (p.startsWith("/") ? p : `${ctx.cwd}/${p}`);

    const registered = (requested: string): string => {
      if (!isDir(abs(requested))) fail(`Worktree directory does not exist: ${requested}`);
      const wt = realpathM(requested, ctx.cwd);
      if (wt === MAIN) fail("Dependency operations may not target the main working tree.");
      const listing = stripNewlines(
        sh(o, ["git", "-C", MAIN, "worktree", "list", "--porcelain"], { env, stdout: "keep" })
          .stdout,
      );
      if (!listing.startsWith(`worktree ${wt}\n`) && !listing.includes(`\nworktree ${wt}\n`))
        fail("Target is not a registered worktree.");
      return wt;
    };

    const linkDeps = (worktree: string, names: readonly string[]): void => {
      const deps = names.length > 0 ? names : DEFAULT_DEPS;
      for (const d of deps) validName(d);
      for (const d of deps)
        if (isDir(`${MAIN}/${d}`) && !exists(`${worktree}/${d}`) && !isLink(`${worktree}/${d}`))
          fs.symlinkSync(P(`${MAIN}/${d}`), P(`${worktree}/${d}`));
    };

    const depLinks = (worktree: string): string[] => {
      let names: string[];
      try {
        names = fs.readdirSync(P(worktree), { encoding: "latin1" });
      } catch {
        return [];
      }
      const plain = names.filter((n) => !n.startsWith(".")).sort(byteCompare);
      const dot = names.filter((n) => /^\.[^.]/.test(n)).sort(byteCompare);
      return [...plain, ...dot]
        .map((n) => `${worktree}/${n}`)
        .filter((e) => {
          if (!isLink(e)) return false;
          try {
            return fs.readlinkSync(P(e), { encoding: "latin1" }) === `${MAIN}/${basename(e)}`;
          } catch {
            return false;
          }
        });
    };

    const scratchWorktree = (requested: string): { wt: string; base: string } => {
      const wt = registered(requested);
      if (!wt.startsWith(`${SCRATCH}/`)) fail(`Not a scratch worktree: ${wt}`);
      const gitDir = stripNewlines(
        sh(o, ["git", "-C", wt, "rev-parse", "--absolute-git-dir"], { env, stdout: "keep" }).stdout,
      );
      const baseFile = `${gitDir}/scratch-base`;
      if (!isFile(baseFile)) fail(`Scratch worktree has no recorded base: ${wt}`);
      return { wt, base: stripNewlines(readBytes(baseFile) ?? "") };
    };

    const n = argv.length;
    switch (argv[0]) {
      case "create": {
        if (n !== 4) fail("create takes slug, branch, and parent.");
        const [, slug = "", branch = "", parent = ""] = argv;
        validName(slug);
        sh(o, ["git", "check-ref-format", "--branch", branch], {
          cwd: ctx.cwd,
          env,
          stdout: "drop",
        });
        if (parent === "") fail("An explicit parent is required.");
        if (
          git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${parent}^{commit}`], {
            cwd: MAIN,
            env,
          }).code !== 0
        )
          fail(`Parent does not resolve: ${parent}`);
        const dest = lib.worktreePath(slug);
        if (`${dest}/`.startsWith(`${MAIN}/`))
          fail("Worktrees must be outside the main working tree.");
        if (exists(dest) || isLink(dest)) fail(`Destination already exists: ${dest}`);
        // A plan whose worktree went missing gets it back on its existing branch; prune drops the
        // registration a deleted directory leaves behind.
        sh(o, ["git", "-C", MAIN, "worktree", "prune"], { env });
        if (
          git(["show-ref", "--verify", "-q", `refs/heads/${branch}`], { cwd: MAIN, env }).code === 0
        )
          sh(o, ["git", "-C", MAIN, "worktree", "add", dest, branch], { env, stdout: "err" });
        else
          sh(o, ["git", "-C", MAIN, "worktree", "add", dest, "-b", branch, parent], {
            env,
            stdout: "err",
          });
        o.out(`${dest}\n`);
        return o.done();
      }
      case "link-deps": {
        if (n < 2) fail("link-deps requires a registered worktree.");
        linkDeps(registered(argv[1] as string), argv.slice(2));
        return o.done();
      }
      case "isolate-dep": {
        if (n !== 3) fail("isolate-dep requires a registered worktree and a dependency name.");
        const wt = registered(argv[1] as string);
        validName(argv[2] as string);
        const dep = `${wt}/${argv[2]}`;
        // Unlink only the directory entry; never traverse into the shared target.
        if (isLink(dep)) fs.unlinkSync(P(dep));
        else if (exists(dep) && !isDir(dep)) fail(`Dependency path is not a directory: ${dep}`);
        fs.mkdirSync(P(dep), { recursive: true });
        if (!isDir(dep) || isLink(dep)) fail("Dependency isolation failed.");
        return o.done();
      }
      case "remove": {
        if (n !== 2) fail("remove requires a registered worktree.");
        const wt = registered(argv[1] as string);
        const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: wt, env });
        o.err(head.stderr);
        if (head.code !== 0) fail("Worktree HEAD is detached; its branch cannot be identified.");
        const branch = stripNewlines(head.stdout);
        // An unignored dependency link would otherwise block removal; its main-root target stays.
        for (const e of depLinks(wt)) fs.unlinkSync(P(e));
        const status = git(["status", "--porcelain", "--untracked-files=all"], { cwd: wt, env });
        o.err(status.stderr);
        if (stripNewlines(status.stdout) !== "")
          fail(`Worktree has uncommitted or untracked changes: ${wt}`);
        sh(o, ["git", "-C", MAIN, "worktree", "remove", wt], { env, stdout: "err" });
        // Delete the branch only when a fresh fetch shows origin at the same tip, so no unpushed
        // commit is lost. A failed fetch keeps it rather than trusting a stale tracking ref.
        const fetched = git(
          ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
          {
            cwd: MAIN,
            env,
          },
        );
        if (fetched.code !== 0) {
          o.err(
            `Cannot fetch origin/${branch} (never pushed, deleted on origin, or origin unreachable); keeping the branch.\n`,
          );
          o.out(`kept ${branch}\n`);
          return o.done();
        }
        const local = git(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: MAIN, env });
        const remote = git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
          cwd: MAIN,
          env,
        });
        o.err(local.stderr + remote.stderr);
        if (stripNewlines(local.stdout) !== stripNewlines(remote.stdout)) {
          o.err(`Local ${branch} differs from origin/${branch}; keeping the branch.\n`);
          o.out(`kept ${branch}\n`);
          return o.done();
        }
        sh(o, ["git", "-C", MAIN, "branch", "-D", branch], { env, stdout: "err" });
        o.out(`deleted ${branch}\n`);
        return o.done();
      }
      case "scratch": {
        if (n < 3) fail("scratch requires a name, a ref, and optional patches.");
        const [, name = "", ref = "", ...patchArgs] = argv;
        validName(name);
        // Resolved where the caller runs, so HEAD in a worktree is that worktree's.
        const rb = git(
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
          { cwd: ctx.cwd, env },
        );
        o.err(rb.stderr);
        if (rb.code !== 0) fail(`Ref does not resolve: ${ref}`);
        const base = stripNewlines(rb.stdout);
        const patches = patchArgs.map((p) => {
          if (!isFile(abs(p))) fail(`Patch does not exist: ${p}`);
          return realpathM(p, ctx.cwd);
        });
        const dest = `${SCRATCH}/${basename(MAIN)}-${name}`;
        if (`${dest}/`.startsWith(`${MAIN}/`))
          fail("Scratch worktrees must be outside the main working tree.");
        if (exists(dest) || isLink(dest)) fail(`Scratch worktree already exists: ${dest}`);
        // A scratch deleted by hand leaves a registration that would block this path.
        sh(o, ["git", "-C", MAIN, "worktree", "prune"], { env });
        fs.mkdirSync(P(SCRATCH), { recursive: true });
        sh(o, ["git", "-C", MAIN, "worktree", "add", "--detach", dest, base], {
          env,
          stdout: "err",
        });
        const gitDir = stripNewlines(
          sh(o, ["git", "-C", dest, "rev-parse", "--absolute-git-dir"], { env, stdout: "keep" })
            .stdout,
        );
        writeBytes(`${gitDir}/scratch-base`, `${base}\n`);
        // Patches go in before the links, so none writes through one into the main root;
        // three-way, so a repro whose test the ref already has still applies.
        for (const patch of patches) {
          if (!nonEmpty(patch)) continue;
          const applied = git(["apply", "--3way", "--binary", "--whitespace=nowarn", "--", patch], {
            cwd: dest,
            env,
          });
          o.err(applied.stderr + applied.stdout);
          if (applied.code !== 0) {
            sh(o, ["git", "-C", MAIN, "worktree", "remove", "--force", dest], {
              env,
              stdout: "err",
            });
            fail(`Patch does not apply at ${ref}: ${patch}; removed ${dest}.`);
          }
        }
        linkDeps(dest, []);
        o.out(`${dest}\n`);
        return o.done();
      }
      case "scratch-diff": {
        if (n < 2) fail("scratch-diff requires a scratch worktree.");
        const { wt, base } = scratchWorktree(argv[1] as string);
        let paths = argv.slice(2);
        if (paths.length > 0) {
          if (!(paths[0] === "--" && paths.length > 1)) fail("Paths follow --.");
          paths = paths.slice(1);
        }
        // A private index from the base, so the scratch's own index stays as it is and the patch
        // holds the paths asked for; plumbing ignores diff config.
        const index = fs.mkdtempSync(`${os.tmpdir()}/dev-worktree-`);
        const indexFile = `${index}/index`;
        fs.writeFileSync(indexFile, "");
        try {
          const ienv = { ...env, GIT_INDEX_FILE: b(indexFile) };
          const g = (args: string[], stdout: "out" | "keep" = "out") =>
            sh(o, ["git", "-C", wt, ...args], { env: ienv, stdout });
          g(["read-tree", base]);
          g(paths.length > 0 ? ["add", "-A", "--", ...paths] : ["add", "-A"]);
          for (const dep of DEFAULT_DEPS) {
            const tracked = sh(o, ["git", "-C", wt, "ls-tree", "--name-only", base, "--", dep], {
              env,
              stdout: "keep",
            });
            if (stripNewlines(tracked.stdout) === "")
              g(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", dep]);
          }
          g(["diff-index", "--cached", "-p", "--binary", base]);
        } finally {
          fs.rmSync(index, { recursive: true, force: true });
        }
        return o.done();
      }
      case "scratch-remove": {
        if (n !== 2) fail("scratch-remove requires a scratch worktree.");
        const { wt } = scratchWorktree(argv[1] as string);
        // Forced removal deletes dependency links without following them.
        sh(o, ["git", "-C", MAIN, "worktree", "remove", "--force", wt], { env, stdout: "err" });
        return o.done();
      }
      default:
        o.err(`${USAGE}\n`);
        return o.done(2);
    }
  });
};
