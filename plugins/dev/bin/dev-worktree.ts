#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { main } from "../core/cli.ts";
import { devWorktree } from "../core/worktree.ts";

main(devWorktree);
