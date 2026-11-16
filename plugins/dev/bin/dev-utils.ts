#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { main } from "../core/cli.ts";
import { devUtils } from "../core/utils.ts";

main(devUtils);
