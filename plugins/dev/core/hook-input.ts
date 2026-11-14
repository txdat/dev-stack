// What the gate reads from a hook call: Claude Code's hook JSON, which the Pi extension builds the
// same shape of, and the block a check throws. JSON values are UTF-8 text; the accessors return
// byte strings (bytes.ts).

import { b } from "./bytes.ts";
import type { Env } from "./cli.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type HookInput = { [key: string]: Json };

/** Where a hook call runs: its working directory and environment, as byte strings. */
export type GateCtx = { cwd: string; env: Env };

/** An object member, or undefined. */
export const member = (v: Json | undefined, key: string): Json | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v[key] : undefined;

/** A string value as a byte string, or undefined for any other value. */
export const str = (v: Json | undefined): string | undefined =>
  typeof v === "string" ? b(v) : undefined;

/** Thrown with the reason a check refuses the call. */
export class Block extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function block(reason: string): never {
  throw new Block(reason);
}
