// Before a shell command: refuses one that runs a test runner listed in SERIAL_FLAG without that
// runner's serial flag, as ../rules/CODING.md#tests requires. Each simple-command segment is
// tokenized to its invoked command (skipping env assignments and wrapper commands such as npx,
// pnpm exec, or bash -c), so non-execution mentions such as git commit messages, cat, or grep
// pass. Unreadable input passes.

import { type HookInput, member, str } from "./hook-input.ts";

/** A command that runs a runner must pass its serial flag. */
const SERIAL_FLAG: readonly (readonly [string, string])[] = [
  ["jest", "--runInBand"],
  ["vitest", "--no-file-parallelism"],
];

/** Wrapper commands and subcommands that precede a runner in command position. */
const WRAPPERS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "yarn",
  "pnpm",
  "npm",
  "bun",
  "node",
  "exec",
  "run",
  "dlx",
  "env",
  "time",
  "timeout",
  "command",
  "nohup",
  "sudo",
  "bash",
  "sh",
]);

/** Wrapper flags that consume the next token as their argument. */
const FLAG_WITH_ARG = new Set([
  "-c",
  "-C",
  "--cwd",
  "--dir",
  "--filter",
  "--prefix",
  "--workspace",
  "-w",
  "-u",
  "-p",
  "--package",
]);

/** A word: not preceded or followed by a letter, digit, _, or -. */
const hasWord = (cmd: string, word: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_-])${word}([^A-Za-z0-9_-]|$)`).test(cmd);

/** Strips one outer layer of matching single or double quotes. */
const unquote = (token: string): string =>
  (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
    ? token.slice(1, -1)
    : token;

/** Splits a shell string into top-level command segments on separators outside quotes. */
const splitSegments = (cmd: string): string[] => {
  const flat = cmd.replace(/\\\r?\n/g, " ");
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "" = "";
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i] as string;
    if (quote !== "") {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < flat.length) {
        cur += flat[++i] as string;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < flat.length) {
      cur += ch + (flat[++i] as string);
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") {
      if (cur.trim() !== "") segments.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&" && flat[i + 1] === "&") {
      if (cur.trim() !== "") segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") segments.push(cur);
  return segments;
};

/** Splits one segment into shell tokens, keeping quoted strings intact. */
const tokenize = (segment: string): string[] => {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | "" = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== "") {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        cur += segment[++i] as string;
      } else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/[ \t\r\n]/.test(ch)) {
      if (cur !== "") {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur !== "") tokens.push(cur);
  return tokens;
};

/** Whether token invokes `runner`: bare, `runner@ver`, or a path ending in `/runner(.js|.mjs|.cjs)?`. */
const matchesRunner = (token: string, runner: string): boolean => {
  const clean = unquote(token);
  const slash = clean.lastIndexOf("/");
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  return new RegExp(`^${runner}(?:@[^/\\s]+|\\.(?:[cm]?js|ts))?$`, "i").test(base);
};

/**
 * Checks one shell command string (recursing into `sh -c` / `bash -c` arguments) and returns the
 * first refusal reason, or undefined when every runner invocation carries its serial flag.
 */
const checkCommand = (cmd: string, depth = 0): string | undefined => {
  if (depth > 3) return undefined;
  for (const seg of splitSegments(cmd)) {
    const tokens = tokenize(seg);
    let i = 0;
    let inShell = false;
    while (i < tokens.length) {
      const raw = tokens[i] as string;
      const tok = unquote(raw);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
        i++;
        continue;
      }
      if (tok === "--") {
        i++;
        continue;
      }
      if (inShell && tok === "-c" && i + 1 < tokens.length) {
        const inner = checkCommand(unquote(tokens[i + 1] as string), depth + 1);
        if (inner !== undefined) return inner;
        break;
      }
      if (WRAPPERS.has(tok)) {
        inShell = tok === "bash" || tok === "sh";
        i++;
        if (tok === "timeout" && i < tokens.length && /^[0-9]/.test(unquote(tokens[i] as string)))
          i++;
        continue;
      }
      if (tok.startsWith("-")) {
        i++;
        if (FLAG_WITH_ARG.has(tok) && i < tokens.length) i++;
        continue;
      }
      for (const [runner, flag] of SERIAL_FLAG) {
        if (matchesRunner(tok, runner) && !hasWord(seg, flag))
          return `This command names ${runner} without ${flag}. Run tests serially (rules/CODING.md#tests): add ${flag}, after -- for npm (npm test -- ${flag}).`;
      }
      break;
    }
  }
  return undefined;
};

/** Why a Bash call must not run; undefined to pass. */
export const serialCheck = (input: HookInput): string | undefined => {
  if (input["tool_name"] !== "Bash") return undefined;
  const cmd = str(member(input["tool_input"], "command")) ?? "";
  return checkCommand(cmd);
};

/**
 * A serial-check refusal as Claude Code reads it. Claude Code accepts only approve or block as a
 * top-level decision and drops output it cannot validate, so the deny goes in hookSpecificOutput
 * only.
 */
export const claudeSerialDeny = (reason: string): string =>
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`;
