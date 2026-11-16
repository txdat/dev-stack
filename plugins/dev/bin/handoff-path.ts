#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { main } from "../core/cli.ts";
import { handoffPath } from "../core/handoff-path.ts";

main(handoffPath);
