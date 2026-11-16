#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { devCheck } from "../core/check.ts";
import { main } from "../core/cli.ts";

main(devCheck);
