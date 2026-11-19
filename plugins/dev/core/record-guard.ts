// The record guard (../rules/plan.md#changes): resume and reopen are the user's, only dev-stack
// writes the stack log, only the user sets `approved` and only dev-stack approve `auto-approved`
// (no unapproved plan reaches a later Status otherwise), and an approved plan's Status never
// returns to planning nor its spec changes; a runbook's or architecture document's Status and Spec
// lines and frozen body hold, and a runbook's log only grows after approval
// (../rules/plan.md#documents), checked for edit tools only. An edit tool's call is simulated and
// refused before it lands. A shell command is matched as text only for resume, reopen, and log
// writes; its plan writes are judged after it runs, against a snapshot. Anything it cannot read
// passes: it never gates a phase. It is a guardrail against an agent's mistakes and shortcuts, not
// a sandbox.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { b, byteCompare, rowsOf, stripNewlines } from "./bytes.ts";
import { type DocKind, docKind, FROZEN, parseDoc, runbookOfLog } from "./doc.ts";
import { block, type GateCtx, type HookInput, type Json, member, str } from "./hook-input.ts";
import { PlanLib, statusRank } from "./plan-lib.ts";
import {
  basename,
  dirname,
  isDir,
  isFile,
  isLink,
  lstat,
  P,
  readBytes,
  realpathM,
  replaceBytes,
  stat,
} from "./sys.ts";
import { tryMainRoot } from "./utils.ts";

const LOG_BLOCK =
  "The stack log is written only by dev-stack.js (review, code-review, approve, stop, and autopilot's claim and auto-reopen; resume and reopen are the user's). Read it, never write it (rules/plan.md#changes).";

// ── shell commands, before they run ──────────────────────────────────

const SP = "[ \\t\\n\\v\\f\\r]";
const NSP = "[^ \\t\\n\\v\\f\\r]";

// dev-stack resume or reopen in command position: at the start, after a separator or newline, or
// after a runner such as bash, env, or bun run, and its single-token options, such as
// --config=x but not --config x; also dev-stack-command dev-stack-resume or -reopen, the same
// writes as the Claude Code module runs them. Either extension matches: the sources are .ts, the
// built plugin .js. A mention inside an argument, such as a grep pattern or a message, passes.
const USER_RE = new RegExp(
  `(^|[;&|(]|\\n)${SP}*((bash|sh|exec|env|command|sudo|time|nohup|node|bun|run|-${NSP}*)${SP}+|[A-Za-z_][A-Za-z0-9_]*=${NSP}*${SP}+)*['"]?[^ \\t\\n\\v\\f\\r;&|'"]*(dev-stack(\\.(sh|ts|js))?['"]?${SP}+|dev-stack-command\\.(ts|js)['"]?${SP}+['"]?dev-stack-)(resume|reopen)([^A-Za-z0-9_-]|$)`,
);

// A stack log path under a repository's docs/plans (a worktree's log/ directory is not one): under
// plans/, or relative from a word's start (cd'd into docs/plans or a stack directory's parent);
// never followed by "/", as a log/ directory is.
const LOG_PATH = "plans/[0-9]+_[a-z0-9-]+/log";
const REL_PATH = `((\\.\\./)*|\\./)?([^/ \\t\\n\\v\\f\\r'"]+/)?[0-9]+_[a-z0-9-]+/log`;
const END = "([^A-Za-z0-9_./-]|$)";
const LOG_RE = new RegExp(`${LOG_PATH}${END}|(^|[ \\t\\n\\v\\f\\r'"=<>])${REL_PATH}${END}`);
const REDIR_RE = new RegExp(
  `[0-9]*(>>?\\|?|>&|&>>?)${SP}*['"]?([^ \\t\\n\\v\\f\\r'"]*${LOG_PATH}|${REL_PATH})${END}`,
);
const WRITE_RE = new RegExp(
  `(^|[^A-Za-z0-9_-])(tee|rm|mv|cp|truncate|dd|install|ln|perl|python3?|ruby|node|bun)(${SP}|$)|sed${SP}+(-[A-Za-z]+${SP}+)*-[A-Za-z]*i|sed${SP}.*--in-place`,
  "s",
);

/**
 * `node <path>` or `bun <path>` in command position, the path's quote, and the path. Bun may carry
 * only the flags the plugin runs it with; any other option, such as a preload, makes it any script.
 */
const RUNTIME_RE = new RegExp(
  `(^|[;&|(\\n])${SP}*(?:node|bun(?:${SP}+(?:--no-env-file|--config=/dev/null))*)${SP}+(['"]?)([^ \\t\\n\\v\\f\\r;&|'"]*)\\2(?=[ \\t\\n\\v\\f\\r;&|)]|$)`,
  "g",
);
// The CLIs carry this module's own extension: .ts run from the sources, .js in the built plugin.
const EXT = import.meta.url.slice(import.meta.url.lastIndexOf("."));
const DEV_CLIS = new Set(
  [
    "dev-stack-command",
    "dev-stack",
    "dev-publish",
    "dev-check",
    "dev-utils",
    "dev-worktree",
    "handoff-path",
  ].map((n) => `${n}${EXT}`),
);

/**
 * Whether `path`, as a shell command names it from `cwd`, is one of this plugin's own dev CLIs: a
 * known name in the bin/ directory this module ships beside. A copy elsewhere, or a path the shell
 * would expand, is any other script.
 */
const isDevCli = (path: string, ctx: GateCtx): boolean => {
  if (!DEV_CLIS.has(basename(path)) || /[$`*?[\\]/.test(path)) return false;
  const home = ctx.env["HOME"] ?? "";
  const named = path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
  if (named.startsWith("~")) return false;
  const real = (p: string): string => {
    try {
      return fs.realpathSync(P(p), { encoding: "latin1" });
    } catch {
      return "";
    }
  };
  const bin = real(b(fileURLToPath(new URL("../bin", import.meta.url))));
  return bin !== "" && real(realpathM(dirname(named), ctx.cwd)) === bin;
};

const shellGuard = (input: HookInput, ctx: GateCtx): void => {
  const cmd = str(member(input["tool_input"], "command")) ?? "";
  const user = USER_RE.exec(cmd);
  if (user) {
    const verb = user[0].includes("reopen") ? "reopen" : "resume";
    block(
      `dev-stack.js ${verb} is the user's alone: it clears a stop, grants more rounds or fix attempts, or reopens an approved plan. Report the stop and what the user would decide (skills/run-stack/SKILL.md#stops).`,
    );
  }
  // Redirections to /dev/null or another descriptor write nothing.
  const probe = stripNewlines(
    cmd
      .split("\n")
      .map((l) =>
        l.replace(new RegExp(`[0-9]*>>?${SP}*/dev/null`, "g"), "").replace(/[0-9]*>&[0-9-]/g, ""),
      )
      .join("\n"),
  );
  // The dev CLIs run under node or bun write the log only through dev-stack, so the runtime in that
  // position is no writing tool; node -e, bun -e, and other scripts still are.
  const tools = probe.replace(RUNTIME_RE, (all, lead: string, _q, path: string) =>
    isDevCli(path, ctx) ? lead : all,
  );
  if (REDIR_RE.test(probe) || (LOG_RE.test(probe) && WRITE_RE.test(tools))) block(LOG_BLOCK);
  snapshotPlans(input, ctx);
};

// ── edit tools, before they run ──────────────────────────────────────

/** The cache keys the simulated plan texts are held under; no path contains a NUL. */
const NEW = "\u0000new";
const OLD_LF = "\u0000old";

const lf = (text: string): string => text.replace(/\r\n?/g, "\n");

/**
 * Edit's or MultiEdit's replacements applied as literal strings, each string passed through
 * `norm` first; undefined when one cannot apply.
 */
const applyEdits = (
  text: string,
  t: Json | undefined,
  norm = (x: string) => x,
): string | undefined => {
  const edits = member(t, "edits");
  const list: (Json | undefined)[] =
    edits === undefined || edits === null || edits === false
      ? [t]
      : Array.isArray(edits)
        ? edits
        : [];
  if (list.length === 0) return undefined;
  let out = text;
  for (const e of list) {
    const pick = (key: string): Json | undefined => {
      const v = member(e, key);
      return v === null || v === false ? undefined : v;
    };
    const oldS = pick("old_string") ?? "";
    const newS = pick("new_string") ?? "";
    if (typeof oldS !== "string" || typeof newS !== "string") return undefined;
    const o = norm(str(oldS) as string);
    const n = norm(str(newS) as string);
    const parts = out.split(o);
    if (o === "" || parts.length < 2) return undefined;
    out = pick("replace_all") ? parts.join(n) : `${parts[0]}${n}${parts.slice(1).join(o)}`;
  }
  return out;
};

/**
 * An edit tool's call on a runbook or architecture document (../rules/plan.md#documents): its Status
 * and Spec lines change only through dev-stack doc-review or the user, except a runbook's approved
 * to executed; a new document starts at draft with Spec -; a frozen one keeps its body. A file
 * that is no document before or after the call passes.
 */
const docGuard = (kind: DocKind, real: string, tool: string, t: Json | undefined): void => {
  let text: string | undefined;
  let cur: string | undefined;
  if (isFile(real)) cur = readBytes(real);
  if (tool === "Write") {
    const c = member(t, "content");
    text = c === undefined || c === null ? "" : (str(c) ?? undefined);
  } else {
    if (cur === undefined) return;
    text = applyEdits(cur, t);
    if (text === undefined && cur.includes("\r")) {
      text = applyEdits(lf(cur), t, lf);
      cur = lf(cur);
    }
  }
  if (text === undefined) return;
  const now = parseDoc(text, kind);
  const was = cur === undefined ? undefined : parseDoc(cur, kind);
  const owner = "(rules/plan.md#documents)";
  if (!was?.isDoc) {
    if (now.isDoc && (now.status !== "draft" || now.spec !== "-"))
      block(
        `${real} starts as 'Status: draft' and 'Spec: -'; dev-stack.js doc-review records a verdict, and only the user approves ${owner}.`,
      );
    if (now.isDoc && now.dupes.length > 0)
      block(`${real} keeps each header key once: ${now.dupes.join("; ")} ${owner}.`);
    return;
  }
  if (!now.isDoc) block(`${real} keeps its 'Status:' and 'Spec:' header lines ${owner}.`);
  if (now.dupes.length > was.dupes.length)
    block(`${real} keeps each header key once: ${now.dupes.join("; ")} ${owner}.`);
  const reset = was.status === "draft" && now.status === "draft" && now.spec === "-";
  if (now.spec !== was.spec && !reset)
    block(
      `Only dev-stack.js doc-review sets ${real}'s 'Spec:', other than a draft's reset to '-' ${owner}.`,
    );
  if (now.status !== was.status) {
    const executed = kind === "runbook" && was.status === "approved" && now.status === "executed";
    if (!executed)
      block(
        now.status === "approved"
          ? `Only the user sets 'Status: approved' on ${real} ${owner}.`
          : `${real}'s Status changes only through dev-stack.js doc-review or the user, except a runbook's approved to executed after its audit ${owner}.`,
      );
  }
  if (FROZEN.has(was.status) && now.body !== was.body)
    block(
      `${real} is '${was.status}' and frozen: only its Status line changes. A needed change goes to the user, who returns it to draft ${owner}.`,
    );
};

/**
 * An edit tool's call on a runbook's log (../rules/plan.md#documents): it takes entries only while
 * the runbook beside it is approved or executed, and only by appending. A log whose runbook is no
 * document passes.
 */
const runbookLogGuard = (rb: string, real: string, tool: string, t: Json | undefined): void => {
  const text = isFile(rb) ? readBytes(rb) : undefined;
  const doc = text === undefined ? undefined : parseDoc(text, "runbook");
  if (!doc?.isDoc) return;
  const owner = "(rules/plan.md#documents)";
  if (!FROZEN.has(doc.status))
    block(`${real} takes execution entries only once ${rb} is approved ${owner}.`);
  let cur = isFile(real) ? readBytes(real) : undefined;
  if (cur === undefined || cur === "") return;
  let next: string | undefined;
  if (tool === "Write") {
    const c = member(t, "content");
    next = c === undefined || c === null ? "" : str(c);
  } else {
    next = applyEdits(cur, t);
    if (next === undefined && cur.includes("\r")) {
      next = applyEdits(lf(cur), t, lf);
      cur = lf(cur);
    }
  }
  // An entry starts on its own line: text joined to the last line would change that entry.
  const joined =
    !cur.endsWith("\n") &&
    next !== undefined &&
    next.length > cur.length &&
    next[cur.length] !== "\n";
  if (next !== undefined && (!next.startsWith(cur) || joined))
    block(`${real} only grows: append an entry, never change or remove one ${owner}.`);
};

const editGuard = (tool: string, input: HookInput, ctx: GateCtx): void => {
  const t = input["tool_input"];
  const path = str(member(t, "file_path")) ?? "";
  if (path === "") return;
  const real = realpathM(path, ctx.cwd);
  const kind = docKind(real);
  if (kind !== undefined) {
    docGuard(kind, real, tool, t);
    return;
  }
  const rb = runbookOfLog(real);
  if (rb !== undefined) {
    runbookLogGuard(rb, real, tool, t);
    return;
  }
  const m = /^(\/.*)\/docs\/plans\/[0-9]+_[a-z0-9-]+\/[^/]+$/s.exec(real);
  if (!m?.[1]) return;
  const name = basename(real);
  if (name === "log") block(LOG_BLOCK);
  if (!/^pr[1-9].*\.spec\.md$/s.test(name)) return;
  // The plan's own repository root serves: no Git call follows.
  const lib = libFor(m[1], ctx);
  let text: string | undefined;
  // The plan text the new one is compared with.
  let old = real;
  if (tool === "Write") {
    const c = member(t, "content");
    text = c === undefined || c === null ? "" : (str(c) ?? undefined);
  } else {
    if (!isFile(real)) return;
    const cur = readBytes(real);
    if (cur === undefined) return;
    text = applyEdits(cur, t);
    // Pi matches an edit against the file with its line breaks read as LF; pi/dev.ts sends such an
    // edit here where it cannot model Pi's result. Where only that matches, both sides are
    // compared with LF line breaks.
    if (text === undefined && cur.includes("\r")) {
      text = applyEdits(lf(cur), t, lf);
      lib.loadText(OLD_LF, lf(cur));
      old = OLD_LF;
    }
  }
  if (text === undefined) return;
  lib.loadText(NEW, text);
  // Raw Status values: a reviewed plan whose Tip comes later ranks reviewed.
  const newStatus = lib.fieldOr(NEW, "Status");
  const oldStatus = isFile(real) ? lib.fieldOr(old, "Status") : "";
  if (oldStatus === "published")
    block(`Plan ${real} is published; no phase resumes or edits it (rules/plan.md#sequence).`);
  if (newStatus === "approved" && oldStatus !== "approved")
    block(
      "Only the user sets 'Status: approved' (rules/plan.md#sequence). Under autopilot, run-stack --auto-approve runs dev-stack.js approve, which sets auto-approved.",
    );
  if (newStatus === "auto-approved" && oldStatus !== "auto-approved")
    block(
      "Only dev-stack.js approve sets 'Status: auto-approved', under run-stack --auto-approve (rules/plan.md#sequence).",
    );
  const oldRank = statusRank(oldStatus);
  const newRank = statusRank(newStatus);
  if (!oldRank && (!isFile(real) || lib.approvedHash(real) === "")) {
    if (newRank)
      block(
        `Plan ${real} is '${oldStatus || "new"}'; it reaches '${newStatus}' only through approval: the user's 'Status: approved' or dev-stack.js approve (rules/plan.md#sequence).`,
      );
    return;
  }
  if (!newRank)
    block(
      `Plan ${real} is '${oldStatus}'; an approved plan's Status never returns to planning or to an unknown value. Leave it as it is: a change goes where rules/plan.md#changes says, or the user reopens it with dev-stack.js reopen.`,
    );
  if (lib.spec(NEW) !== lib.spec(old))
    block(
      `Plan ${real} is '${oldStatus}' and frozen: after approval only its Status and Tip lines change. Leave it as it is: a change goes where rules/plan.md#changes says, or the user reopens it with dev-stack.js reopen.`,
    );
};

const libFor = (root: string, ctx: GateCtx): PlanLib => new PlanLib(root, ctx);

/** Before a shell or edit call: throws Block when the call breaks the record. */
export const recordGuard = (tool: string, input: HookInput, ctx: GateCtx): void => {
  if (tool === "Bash") shellGuard(input, ctx);
  else editGuard(tool, input, ctx);
};

// ── snapshots ────────────────────────────────────────────────────────

const rmrf = (p: string): boolean => {
  try {
    fs.rmSync(P(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * A shell call's snapshot directory, keyed by its tool_use_id. Undefined without one: a key shared
 * by parallel calls would let one call's check delete or replace another's snapshot. The parent
 * directory must be the user's own.
 */
const snapDir = (input: HookInput, ctx: GateCtx): string | undefined => {
  // Each other byte becomes "." and two hex digits, and "." appears nowhere else, so distinct ids,
  // such as Pi's nested "X/1/1" and "X/11", never share a directory.
  const id = (str(input["tool_use_id"]) ?? "").replace(
    /[^A-Za-z0-9_-]/g,
    (c) => `.${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  if (id === "") return undefined;
  const uid = process.getuid?.() ?? 0;
  const base = `${ctx.env["XDG_RUNTIME_DIR"] || ctx.env["TMPDIR"] || "/tmp"}/dev-gate-check-${uid}`;
  try {
    fs.mkdirSync(P(base), { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(P(base));
    if (!st.isDirectory() || st.uid !== uid) return undefined;
    fs.chmodSync(P(base), 0o700);
  } catch {
    return undefined;
  }
  return `${base}/${id}`;
};

/**
 * The main root of the repository the hook input's cwd belongs to; undefined when cwd resolves to
 * no repository. A command that changes another repository's plans goes unchecked.
 */
const snapScope = (input: HookInput, ctx: GateCtx): string | undefined => {
  const cwd = str(input["cwd"]) ?? "";
  return tryMainRoot(cwd !== "" && isDir(cwd) ? cwd : ctx.cwd, ctx.env);
};

const PLAN_NAME = /^pr[1-9].*\.spec\.md$/s;

/**
 * Plan specs and stack logs at `depth` under dir, relative to it, in directory order. Follows
 * symlinks, so a stack directory linked elsewhere is still covered.
 */
const planFiles = (dir: string, depth: number): string[] => {
  const out: string[] = [];
  const walk = (abs: string, rel: string, d: number): void => {
    let names: string[];
    try {
      names = fs.readdirSync(P(abs), { encoding: "latin1" });
    } catch {
      return;
    }
    for (const n of names) {
      const a = `${abs}/${n}`;
      const r = rel === "" ? n : `${rel}/${n}`;
      const st = stat(a);
      if (!st) continue;
      if (d === depth) {
        if (st.isFile() && (n === "log" || PLAN_NAME.test(n))) out.push(r);
      } else if (st.isDirectory()) walk(a, r, d + 1);
    }
  };
  walk(dir, "", 1);
  return out;
};

const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort(byteCompare);

/** Copies a file with its mode and timestamps, as `cp -p` does. */
const copyFile = (src: string, dst: string): void => {
  const st = fs.statSync(P(src));
  fs.copyFileSync(P(src), P(dst));
  fs.chmodSync(P(dst), st.mode & 0o7777);
  fs.utimesSync(P(dst), st.atime, st.mtime);
};

/** `cp -rpL`: a dereferenced recursive copy. */
const copyTree = (src: string, dst: string): void => {
  const st = fs.statSync(P(src));
  if (!st.isDirectory()) {
    copyFile(src, dst);
    return;
  }
  fs.mkdirSync(P(dst));
  for (const n of fs.readdirSync(P(src), { encoding: "latin1" }))
    copyTree(`${src}/${n}`, `${dst}/${n}`);
  fs.chmodSync(P(dst), st.mode & 0o7777);
  fs.utimesSync(P(dst), st.atime, st.mtime);
};

/** The store's name beside the snapshots; an encoded id never starts with "." and a letter. */
const STORE = ".store";

/**
 * A file's store entry name. Ctime is in it because no write, chmod, or touch leaves ctime
 * unchanged, so a file whose name matches holds the bytes the entry holds.
 */
const storeKey = (st: fs.BigIntStats): string =>
  `${st.dev}-${st.ino}-${st.size}-${st.mtimeNs}-${st.ctimeNs}`;

/** Timestamp granularity margin: a file changed this recently may change again at the same ctime. */
const RACY_NS = 2_000_000_000n;

/**
 * Snapshots src at dst. A file unchanged since well before start links its write-once store
 * entry, so the published plans kept as records cost a link, not a copy; otherwise it is copied,
 * and the copy becomes the entry when src did not change during it and is not racy. An entry is
 * never written after it is created, so each snapshot keeps the bytes it linked even after the
 * entry goes. Any failure of the store falls back to the copy.
 */
const snapFile = (src: string, dst: string, store: string | undefined, start: bigint): void => {
  let st: fs.BigIntStats | undefined;
  try {
    st = fs.statSync(P(src), { bigint: true });
  } catch {}
  const stale = store !== undefined && st !== undefined && st.ctimeNs + RACY_NS < start;
  const entry = stale && st !== undefined ? `${store}/${storeKey(st)}` : undefined;
  if (entry !== undefined)
    try {
      fs.linkSync(P(entry), P(dst));
      return;
    } catch {}
  copyFile(src, dst);
  if (entry === undefined || st === undefined) return;
  try {
    if (storeKey(fs.statSync(P(src), { bigint: true })) === storeKey(st))
      fs.linkSync(P(dst), P(entry));
  } catch {}
};

/** The store beside the snapshots in parent, created if missing; undefined when unusable. */
const storeDir = (parent: string): string | undefined => {
  const store = `${parent}/${STORE}`;
  try {
    fs.mkdirSync(P(store), { mode: 0o700 });
  } catch {}
  return lstat(store)?.isDirectory() ? store : undefined;
};

/**
 * Before a shell call: snapshots every plan spec and stack log in the docs/plans of the cwd's
 * repository. A file it cannot read is skipped, and the check after treats it as new. Snapshots
 * older than a day, left by calls that never finished, go, as do store entries no snapshot linked
 * or unlinked for a day.
 */
const snapshotPlans = (input: HookInput, ctx: GateCtx): void => {
  const scope = snapScope(input, ctx);
  if (scope === undefined) return;
  const base = `${scope}/docs/plans`;
  const snap = snapDir(input, ctx);
  if (snap === undefined) return;
  const parent = dirname(snap);
  const start = BigInt(Date.now()) * 1_000_000n;
  const cutoff = Date.now() - 1440 * 60_000;
  try {
    for (const n of fs.readdirSync(P(parent), { encoding: "latin1" })) {
      if (n === STORE) continue;
      const st = lstat(`${parent}/${n}`);
      if (st && st.mtimeMs < cutoff) rmrf(`${parent}/${n}`);
    }
  } catch {}
  const store = storeDir(parent);
  // Linking or unlinking an entry updates its ctime; its mtime is the plan's own.
  if (store !== undefined)
    try {
      for (const n of fs.readdirSync(P(store), { encoding: "latin1" })) {
        const st = lstat(`${store}/${n}`);
        if (st && st.ctimeMs < cutoff) rmrf(`${store}/${n}`);
      }
    } catch {}
  rmrf(snap);
  try {
    fs.mkdirSync(P(snap), { mode: 0o700 });
  } catch {
    return;
  }
  fs.writeFileSync(P(`${snap}/.scope`), P(`${scope}\n`));
  fs.mkdirSync(P(`${snap}/files`));
  if (isDir(base))
    for (const rel of planFiles(base, 2)) {
      try {
        fs.mkdirSync(P(dirname(`${snap}/files/${rel}`)), { recursive: true });
        snapFile(`${base}/${rel}`, `${snap}/files/${rel}`, store, start);
      } catch {}
    }
  fs.writeFileSync(P(`${snap}/.complete`), "");
};

// ── shell commands, after they run ───────────────────────────────────

/** A file's lines; none when it is missing or unreadable. */
const fileRows = (file: string): string[] => (isFile(file) ? rowsOf(readBytes(file) ?? "") : []);

/** How many of `lines` match re. */
const count = (lines: readonly string[], re: RegExp): number =>
  lines.filter((l) => re.test(l)).length;

/** Restores dst from snapshot copy src, replacing whatever stands at dst with a new file. */
const restoreFile = (src: string, dst: string): boolean => {
  try {
    fs.mkdirSync(P(dirname(dst)), { recursive: true });
    fs.rmSync(P(dst), { recursive: true, force: true });
    copyFile(src, dst);
    return true;
  } catch {
    return false;
  }
};

const sameBytes = (a: string, b2: string): boolean => {
  const x = readBytes(a);
  return x !== undefined && x === readBytes(b2);
};

const LOG_VERBS = [/: stop /, /: review /, /: code-review /, /: approve /, /: auto-reopened$/];

/**
 * After a shell call: compares the cwd repository's plans with the snapshot and restores any
 * change only dev-stack or the user may make: a frozen or published plan changed, moved, or
 * deleted, an approved plan back below approved, a plan moved or deleted while the stack log holds
 * its lines, an unapproved plan moved to approved or later except by dev-stack approve, an approved
 * plan back to planning except by dev-stack auto-reopen, or a stack log that lost a stop, review,
 * or auto-reopen line, or gained a resume or reopen. A plan auto-approved during the command over a
 * parent it restores below approved is restored too. A plan it restores loses the approve and
 * auto-reopened lines the command added for it, so its header and log agree. A command still
 * running after the call returns (a background job) is never compared, a forged log line it cannot
 * tell from dev-stack's passes, and a change the user makes during the call to the same
 * repository's plans is restored as the agent's.
 *
 * Returns the report, or undefined when nothing was restored.
 */
export const bashPostCheck = (input: HookInput, ctx: GateCtx): string | undefined => {
  const snap = snapDir(input, ctx);
  if (snap === undefined || !isFile(`${snap}/.complete`)) return undefined;
  const msgs: string[] = [];
  let failed = "";
  try {
    postCheck(snap, ctx, msgs);
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  } finally {
    rmrf(snap);
  }
  // What was restored before a failure is still reported, and the failure with it.
  const report =
    msgs.length === 0
      ? []
      : [
          `A shell command changed plans in a way only dev-stack.js or the user may (rules/plan.md#changes):\n${msgs.map((m) => `- ${m}`).join("\n")}\nChange Status and Tip with the Edit tool; any other change goes where rules/plan.md#changes says, or the user reopens the plan with dev-stack.js reopen.`,
        ];
  if (failed !== "")
    report.push(
      `The plan check after this shell command failed (${failed}) before it compared every plan; plans it did not reach went unchecked. Tell the user.`,
    );
  return report.length === 0 ? undefined : report.join("\n");
};

/** Compares the plans with the snapshot, restoring what the command may not change; adds to msgs. */
const postCheck = (snap: string, ctx: GateCtx, msgs: string[]): void => {
  const scope = stripNewlines(readBytes(`${snap}/.scope`) ?? "");
  const base = `${scope}/docs/plans`;
  const files = `${snap}/files`;
  const lib = libFor(scope, ctx);
  const undone: string[] = [];
  const all = uniqSorted([...planFiles(files, 2), ...planFiles(base, 2)]);

  // Stack logs first: a lost stop or review line acts as the user's resume, and a resume or reopen
  // line is the user's alone (refused before the call).
  for (const rel of all) {
    if (!rel.endsWith("/log")) continue;
    const old = `${files}/${rel}`;
    const now = `${base}/${rel}`;
    let why = "";
    const user = /: (cleared|reopened)$/;
    const [before, after] = [fileRows(old), fileRows(now)];
    if (count(after, user) > count(before, user))
      why = "it gained a resume or reopen line, which only the user's dev-stack.js writes";
    else if (LOG_VERBS.some((re) => count(after, re) < count(before, re)))
      why = "it lost a line only dev-stack.js writes";
    if (why === "") continue;
    if (!isFile(old)) {
      msgs.push(
        rmrf(now) && !isFile(now)
          ? `${now}: ${why}. Removed: it did not exist before the command.`
          : `${now}: ${why}. Could not remove it; tell the user.`,
      );
    } else if (restoreFile(old, now))
      msgs.push(`${now}: ${why}. Restored from before the command.`);
    else msgs.push(`${now}: ${why}. Could not restore it; tell the user.`);
  }

  // Restores plan rel from its snapshot copy, or sets a plan new to the command to planning; a plan
  // undone joins undone, whose log lines the check then clears.
  const undo = (rel: string, why: string): void => {
    const old = `${files}/${rel}`;
    const now = `${base}/${rel}`;
    if (isFile(old)) {
      if (restoreFile(old, now)) {
        msgs.push(`${now}: ${why}. Restored from before the command.`);
        undone.push(rel);
      } else msgs.push(`${now}: ${why}. Could not restore it; tell the user.`);
    } else if (lib.setHeader(now, [["Status", "planning"]])) {
      msgs.push(`${now}: ${why}. Set to 'Status: planning'.`);
      undone.push(rel);
    } else msgs.push(`${now}: ${why}. Could not set it to planning; tell the user.`);
  };

  const logCount = (plan: string, re: RegExp): number =>
    lib.logLines(plan).filter((l) => re.test(l)).length;
  const AUTO = /^approve auto-approved at /;

  for (const rel of all) {
    if (!/(^|\/)pr[1-9][0-9]*\.spec\.md$/.test(rel)) continue;
    const old = `${files}/${rel}`;
    const now = `${base}/${rel}`;
    const hasOld = isFile(old);
    const hasNew = isFile(now);
    if (hasOld && hasNew && sameBytes(old, now)) continue;
    if (hasOld) lib.reload([old]);
    if (hasNew) lib.reload([now]);
    let os = "";
    let ns = "";
    let or: number | undefined;
    let nr: number | undefined;
    let ob = "";
    let frozen = false;
    let why = "";
    // Raw Status values: a reviewed plan whose Tip comes later ranks reviewed.
    if (hasOld) {
      os = lib.fieldOr(old, "Status");
      or = statusRank(os);
      ob = lib.spec(old);
      frozen = os === "published" || (or ?? 0) >= 1 || lib.approvedHash(old) !== "";
    }
    if (hasNew) {
      ns = lib.fieldOr(now, "Status");
      nr = statusRank(ns);
    }
    if (frozen) {
      if (!hasNew) why = `it is '${os}' and was moved or deleted`;
      else if (os === "published") why = "it is published and changed";
      else if (lib.spec(now) !== ob)
        why = `it is '${os}' and its spec changed; after approval only its Status and Tip lines change`;
      else if (!nr) {
        // dev-stack auto-reopen's step: an approval of its own, never auto-reopened before, back
        // to planning with an auto-reopened line.
        const autoReopen =
          ns === "planning" &&
          os !== "approved" &&
          lib.approvalKind(old) === "auto-approved" &&
          lib.autoReopens(old) === 0 &&
          lib.autoReopens(now) === 1;
        if (!autoReopen)
          why = `it is '${os}' and its Status went to '${ns}'; an approved plan never returns below approved`;
      }
    } else if (!hasNew) {
      // A plan removed with its log lines left would hand its rounds and stops to the next plan
      // written at its number; dev-stack renumber and drop relabel them.
      const f = basename(rel).replace(/\.spec\.md$/, "");
      if (count(fileRows(`${dirname(now)}/log`), new RegExp(`^${f}: `)) !== 0)
        why =
          "it was moved or deleted while the stack log still holds its lines; dev-stack.js renumber moves a plan and drop removes one";
    } else if ((nr ?? 0) >= 1) {
      // Unapproved (or new) and now approved or later: only dev-stack approve's step passes:
      // auto-approved at the plan's hash with its review still holding and logged by dev-stack
      // review, as approve requires. The snapshot may predate the review, as when one call runs
      // dev-stack review and then approve.
      if (ns === "approved") why = "its Status was set to approved, which only the user sets";
      else if (ns !== "auto-approved")
        why = `its Status went from '${os || "none"}' to '${ns}', skipping approval`;
      else {
        const autos = lib.logLines(now).filter((l) => AUTO.test(l));
        if (
          lib.reviewState(now) !== "ready" ||
          !lib.reviewLogged(now) ||
          autos.length <= logCount(old, AUTO) ||
          autos[autos.length - 1] !== `approve auto-approved at ${lib.planHash(now) ?? ""}`
        )
          why =
            "its Status was set to auto-approved, which only dev-stack.js approve sets, on a ready plan whose review still holds";
      }
    }
    if (why !== "") undo(rel, why);
  }

  // A plan auto-approved during the command over a parent undone above to below approved is undone
  // too, as dev-stack approve takes a child only after its parent; repeated for the plans stacked
  // above it.
  const undoneDirs = (): string[] =>
    uniqSorted(undone.filter((r) => r.includes("/")).map((r) => r.slice(0, r.lastIndexOf("/"))));
  let again = true;
  while (again) {
    again = false;
    const list = undoneDirs().flatMap((d) =>
      planFiles(`${base}/${d}`, 1)
        .filter((n) => /^pr[1-9][0-9]*\.spec\.md$/.test(n))
        .map((n) => `${d}/${n}`),
    );
    for (const rel of list) {
      if (undone.includes(rel)) continue;
      const old = `${files}/${rel}`;
      const now = `${base}/${rel}`;
      if (!isFile(now)) continue;
      lib.reload([now]);
      if (lib.fieldOr(now, "Status") !== "auto-approved") continue;
      if (isFile(old)) {
        lib.reload([old]);
        if (statusRank(lib.fieldOr(old, "Status"))) continue;
      }
      const parent = lib.parent(now);
      if (
        !parent ||
        !undone.includes(parent.startsWith(`${base}/`) ? parent.slice(base.length + 1) : parent)
      )
        continue;
      lib.reload([parent]);
      if (statusRank(lib.fieldOr(parent, "Status"))) continue;
      undo(rel, "it was auto-approved over its parent, which this command left below approved");
      again = true;
    }
  }

  // A plan undone above keeps no approve or auto-reopened line the command added for it: left in,
  // one would disagree with the restored header, and an approve line would freeze the plan below
  // approved with no verb left but the user's reopen. Its review, code-review, and stop lines stay:
  // a dropped one would grant a round or clear a stop.
  const fail =
    "could not remove the approve and auto-reopened lines the command added for a plan undone above; tell the user.";
  for (const d of undoneDirs()) {
    const prefixes = undone
      .filter((r) => r.slice(0, r.lastIndexOf("/")) === d)
      .map((r) => `${basename(r).replace(/\.spec\.md$/, "")}: `);
    const old = `${files}/${d}/log`;
    const now = `${base}/${d}/log`;
    if (!isFile(now)) continue;
    const hasOld = isFile(old);
    const oldB = hasOld ? (readBytes(old) ?? "") : "";
    const newB = readBytes(now) ?? "";
    if (hasOld && oldB === newB) continue;
    if (hasOld && newB.slice(0, oldB.length) !== oldB) {
      // Rewritten, as by renumber or drop: added lines cannot be told apart, and restoring it
      // would drop other plans' rounds and stops.
      msgs.push(
        `${now}: the command rewrote it alongside a change undone above, so its lines were left as they are; tell the user.`,
      );
      continue;
    }
    const tail = rowsOf(newB.slice(oldB.length));
    const kept = tail
      .filter((l) => {
        const p = prefixes.find((x) => l.startsWith(x));
        if (p === undefined) return true;
        const r = l.slice(p.length);
        return !(r.startsWith("approve ") || r === "auto-reopened");
      })
      .map((l) => `${l}\n`)
      .join("");
    const content = oldB + kept;
    if (content === newB) continue;
    try {
      if (!hasOld && content === "") fs.rmSync(P(now), { force: true });
      // One rename replaces the log, or a symlink standing at its path, so no moment leaves it
      // missing.
      else replaceBytes(now, content);
    } catch {
      msgs.push(`${now}: ${fail}`);
      continue;
    }
    msgs.push(
      `${now}: removed the approve and auto-reopened lines the command added for the plans undone above.`,
    );
  }

  // A symlink or hard link to a plan file or stack directory lets an edit tool change a plan
  // through a path outside docs/plans: each gets its own copy again.
  for (const f of linkCandidates(base)) {
    const p = `${base}/${f}`;
    const st = stat(p);
    if (!(isLink(p) || (st?.isFile() && st.nlink > 1))) continue;
    const tmp = `${p}.gate.${process.pid}`;
    try {
      copyTree(p, tmp);
      fs.rmSync(P(p), { recursive: true, force: true });
      fs.renameSync(P(tmp), P(p));
    } catch {
      rmrf(tmp);
      msgs.push(`${p}: a link to a plan that could not be replaced with a copy; tell the user.`);
    }
  }
};

/**
 * Stack directories and plan files one or two levels under base, links followed, deepest names
 * first (`find -L … | sort -r`).
 */
const linkCandidates = (base: string): string[] => {
  const out: string[] = [];
  const keep = (name: string, st: fs.Stats): boolean =>
    (st.isDirectory() && /^[0-9].*_/s.test(name)) ||
    (st.isFile() && (name === "log" || PLAN_NAME.test(name)));
  let top: string[];
  try {
    top = fs.readdirSync(P(base), { encoding: "latin1" });
  } catch {
    return out;
  }
  for (const n of top) {
    const st = stat(`${base}/${n}`);
    if (!st) continue;
    if (keep(n, st)) out.push(n);
    if (!st.isDirectory()) continue;
    let sub: string[] = [];
    try {
      sub = fs.readdirSync(P(`${base}/${n}`), { encoding: "latin1" });
    } catch {}
    for (const c of sub) {
      const cst = stat(`${base}/${n}/${c}`);
      if (cst && keep(c, cst)) out.push(`${n}/${c}`);
    }
  }
  return out.sort(byteCompare).reverse();
};
