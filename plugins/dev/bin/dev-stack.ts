#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { main } from "../core/cli.ts";
import { devStack } from "../core/stack.ts";

main(devStack);
