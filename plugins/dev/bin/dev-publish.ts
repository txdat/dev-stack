#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { main } from "../core/cli.ts";
import { devPublish } from "../core/publish.ts";

main(devPublish);
