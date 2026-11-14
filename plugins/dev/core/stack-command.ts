// Runs one /dev-stack-* command (hooks/commands.ts) with dev-stack.ts in-process: the Pi extension
// calls it directly, the Claude Code module through bin/dev-stack-command.ts.

import { COMMANDS, type CommandResult, runCommand } from "../hooks/commands.ts";
import { b, utf8 } from "./bytes.ts";
import { byteEnv } from "./cli.ts";
import { devStack } from "./stack.ts";
import { tryMainRoot } from "./utils.ts";

/** `cwd` and `env` are UTF-8 text; undefined when no command has that name. */
export const stackCommand = (
  name: string,
  args: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): CommandResult | undefined => {
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) return undefined;
  return runCommand(command, args, {
    cwd,
    plansRoot: () => {
      const main = tryMainRoot(b(cwd));
      return main === undefined ? "" : `${utf8(main)}/docs/plans`;
    },
    home: env["HOME"] ?? "",
    devStack: (argv) => {
      const ran = devStack({ argv: argv.map(b), env: byteEnv(env), cwd: b(cwd) });
      return { code: ran.code, stdout: utf8(ran.stdout), stderr: utf8(ran.stderr) };
    },
  });
};
