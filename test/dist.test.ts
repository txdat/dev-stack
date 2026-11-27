// The built plugin (scripts/build.ts): built into /tmp, it is self-contained JavaScript whose
// manifests, rule and skill links, and CLI paths resolve, and whose record guard trusts its own
// .js CLIs.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { exec, NODE, PLUGIN, RUN, tmp } from "./helpers.ts";

const ROOT = path.resolve(PLUGIN, "../..");
const OUT = path.join(tmp("dev-dist-test"), "dev");
const built = exec([...NODE, path.join(ROOT, "scripts/build.ts"), "--out", OUT]);

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());

test("the build replaces only an earlier build or an empty directory outside the checkout", () => {
  const build = (out: string) =>
    exec([...NODE, path.join(ROOT, "scripts/build.ts"), "--out", out], { cwd: ROOT });
  const other = tmp("dev-dist-other");
  fs.writeFileSync(path.join(other, "keep"), "");
  // A plugin of the same shape without the build's marker is not an earlier build.
  const lookalike = tmp("dev-dist-lookalike");
  for (const f of [".claude-plugin/plugin.json", "hooks/register.js"]) {
    fs.mkdirSync(path.dirname(path.join(lookalike, f)), { recursive: true });
    fs.writeFileSync(path.join(lookalike, f), "");
  }
  const file = path.join(other, "keep");
  const outs = [ROOT, path.dirname(ROOT), path.join(ROOT, "plugins"), "test", other, lookalike];
  for (const out of [...outs, file]) {
    const r = build(out);
    assert.equal(r.code, 2, `${out}: ${r.all}`);
    assert.match(r.err, /refusing to replace/, out);
  }
  assert.ok(fs.existsSync(path.join(other, "keep")));
  assert.ok(fs.existsSync(path.join(ROOT, "test/dist.test.ts")));
  const again = build(OUT);
  assert.equal(again.code, 0, again.all);
  // On a fresh clone dist/ does not exist yet: missing parents are created.
  const fresh = path.join(tmp("dev-dist-fresh"), "missing/dev");
  const first = build(fresh);
  assert.equal(first.code, 0, first.all);
  assert.ok(fs.existsSync(path.join(fresh, "hooks/register.js")));
  assert.deepEqual(
    fs.readdirSync(path.dirname(OUT)).filter((f) => f.includes(".build-")),
    [],
  );
});

test("the build emits JavaScript and copies the plugin's files", () => {
  assert.equal(built.code, 0, built.all);
  const all = files(OUT).map((f) => path.relative(OUT, f));
  assert.deepEqual(
    all.filter((f) => f.endsWith(".ts")),
    [],
  );
  assert.ok(!all.includes("rules/agy-swarm.md"), "dist/dev excludes Antigravity-only agy-swarm.md");
  for (const want of [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/register.js",
    "pi/dev.js",
    "dsh/index.js",
    "opencode/index.js",
    "opencode/package.json",
    "bin/hook.js",
    "rules/CORE.md",
    "skills/run-stack/SKILL.md",
    "agents/planner.md",
    "agents/plan-reviewer.md",
    "agents/code-reviewer.md",
  ])
    assert.ok(all.includes(want), want);
  for (const f of all.filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(OUT, f), "utf8");
    assert.doesNotMatch(
      text,
      /(from|import)\s*\(?\s*"\.{1,2}\/[^"]*\.ts"/,
      `${f} imports a .ts module`,
    );
  }
});

test("the manifests point at the built plugin", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(OUT, "hooks/hooks.json"), "utf8"));
  for (const m of hooks.modules as string[])
    assert.ok(fs.existsSync(path.join(OUT, "hooks", m)), m);
  const market = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  assert.deepEqual(
    market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [
      ["dev", "./dist/dev"],
      ["typescript-lsp", "./plugins/typescript-lsp"],
    ],
  );
  const lsp = JSON.parse(
    fs.readFileSync(path.join(ROOT, "plugins/typescript-lsp/.claude-plugin/plugin.json"), "utf8"),
  );
  assert.equal(lsp.name, "typescript-lsp");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const entry of [...pkg.pi.extensions, ...pkg.pi.skills] as string[]) {
    assert.ok(entry.startsWith("./dist/dev/"), entry);
    assert.ok(fs.existsSync(path.join(OUT, entry.slice("./dist/dev/".length))), entry);
  }
  // The DSH bundle manifest points at its patch and at the Host plugin the build emits.
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch);
  const dshEntry = pkg.exports["."] as string;
  assert.ok(dshEntry.startsWith("./dist/dev/"), dshEntry);
  assert.ok(fs.existsSync(path.join(OUT, dshEntry.slice("./dist/dev/".length))), dshEntry);
});

test("the rules' and skills' links and CLI paths resolve in the built plugin", () => {
  for (const f of files(OUT).filter((f) => f.endsWith(".md"))) {
    const text = fs.readFileSync(f, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target as string)) continue;
      const to = path.resolve(path.dirname(f), target as string);
      assert.ok(to.startsWith(`${OUT}/`), `${f}: ${target} leaves the plugin`);
      assert.ok(fs.existsSync(to), `${f}: ${target} does not exist`);
    }
    for (const [cli] of text.matchAll(/\$DEV_LIB\/bin\/[a-z-]+\.[a-z]+/g))
      assert.ok(fs.existsSync(path.join(OUT, cli.slice("$DEV_LIB/".length))), `${f}: ${cli}`);
  }
});

test("the built hook guards the user's commands and trusts its own .js CLIs", () => {
  const cwd = tmp("dev-dist-cwd");
  const plans = `${cwd}/docs/plans/1_dist`;
  const hook = (command: string) => {
    const r = exec([...NODE, path.join(OUT, "bin/hook.js")], {
      cwd,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    });
    assert.equal(r.code, 0, r.all);
    return r.out.trim() === "" ? "" : JSON.parse(r.out).hookSpecificOutput.permissionDecision;
  };
  assert.equal(hook(`${RUN} '${OUT}/bin/dev-stack.js' resume ${plans}/pr1.spec.md`), "deny");
  assert.equal(
    hook(`${RUN} '${OUT}/bin/dev-stack.js' next ${plans}/pr1.spec.md; cat ${plans}/log`),
    "",
  );
  const fake = tmp("dev-dist-fake");
  assert.equal(hook(`node ${fake}/dev-stack.js ${plans}/log`), "deny");
});

test("the built Pi extension loads", async () => {
  // Pi's package resolves from the checkout's node_modules, as dist/dev's does.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(path.dirname(OUT), "node_modules"));
  const mod = await import(pathToFileURL(path.join(OUT, "pi/dev.js")).href);
  assert.equal(typeof mod.default, "function");
});

test("the built DSH Host plugin loads", async () => {
  const mod = await import(pathToFileURL(path.join(OUT, "dsh/index.js")).href);
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject), "the plugin declares no inject list");
  for (const service of ["commands", "skills", "systemPrompt", "tools", "workingDirectory"])
    assert.ok(mod.inject.includes(service), `inject lacks ${service}`);
});

test("the built OpenCode plugin loads", async () => {
  const mod = await import(pathToFileURL(path.join(OUT, "opencode/index.js")).href);
  assert.equal(mod.default.id, "dev-stack");
  assert.equal(typeof mod.default.setup, "function");
});
