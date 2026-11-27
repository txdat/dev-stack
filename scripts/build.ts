// Builds dist/dev, the plugin for Claude Code, Pi, DSH, and OpenCode: the common build plus the
// Claude Code manifest, hooks.json, and the engine-side hooks module.
// Usage: node scripts/build.ts [--out <dir>]

import * as fs from "node:fs";
import * as path from "node:path";
import { main, SRC } from "./build-lib.ts";

const CLAUDE_COPY = [".claude-plugin/plugin.json", "hooks/hooks.json"];

main("build.ts", "dev", {
  configs: ["tsconfig.build.json", "tsconfig.build-engine.json"],
  finish: (work) => {
    // Antigravity-only rule.
    fs.rmSync(path.join(work, "rules/agy-swarm.md"), { force: true });
    for (const rel of CLAUDE_COPY)
      fs.cpSync(path.join(SRC, rel), path.join(work, rel), { recursive: true });
  },
});
