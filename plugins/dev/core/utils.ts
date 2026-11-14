// Mechanics shared by dev phase skills and the gate. Every command is read-only except
// issue-create, the only one that creates an external record; run it only after the owning
// phase's authorization.

import { stripNewlines } from "./bytes.ts";
import { type Command, type Ctx, fail, guard, Output } from "./cli.ts";
import { type Env, git, isDir, isFile, readable, run } from "./sys.ts";

const USAGE = [
  "Usage: dev-utils.ts main-root",
  "       dev-utils.ts diagnostic-base",
  "       dev-utils.ts search-production <literal-symbol> [directory]",
  "       dev-utils.ts issue-create <title> <body-file> [gh issue create options ...]",
  "       dev-utils.ts recent-issues [days]",
  "       dev-utils.ts recent-prs [days]",
  "Paths/refs are printed on stdout; errors go to stderr.",
  "recent-issues and recent-prs list 7 days back by default, newest first, at most 100.",
  "search-production preserves rg status: 0 matches, 1 none, 2 error.",
].join("\n");

/** The main working-tree root from `cwd`; throws Exit with the old messages. */
export const mainRoot = (cwd: string, env: Env, o?: Output): string => {
  const listing = git(["worktree", "list", "--porcelain"], { cwd, env });
  o?.err(listing.stderr);
  if (listing.code !== 0) fail("Cannot resolve the main working-tree root.");
  const first = stripNewlines(listing.stdout).split("\n")[0] ?? "";
  if (!first.startsWith("worktree ")) fail("Cannot resolve the main working-tree root.");
  const root = first.slice("worktree ".length);
  if (root === "" || !isDir(root)) fail("Cannot resolve an existing main working-tree root.");
  const inside = git(["rev-parse", "--is-inside-work-tree"], { cwd: root, env });
  o?.err(inside.stderr);
  if (stripNewlines(inside.stdout) !== "true") fail("The main repository has no working tree.");
  return root;
};

/** The main root, or undefined outside a repository with a working tree. */
export const tryMainRoot = (cwd: string, env: Env): string | undefined => {
  try {
    return mainRoot(cwd, env);
  } catch {
    return undefined;
  }
};

const diagnosticBase = (cwd: string, env: Env): string => {
  const def = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd, env });
  const candidates = [
    def.code === 0 ? stripNewlines(def.stdout) : "",
    "refs/heads/main",
    "refs/remotes/origin/main",
  ];
  for (const ref of candidates) {
    if (ref === "") continue;
    if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, env }).code === 0)
      return ref;
  }
  return fail("Cannot resolve a diagnostic base; provide an existing branch or commit.");
};

/** gh rows listed; one more is fetched so a truncated window is detectable. */
const LIST_LIMIT = 100;

/** The local ISO date `days` days ago, as `date -I -d '<days> days ago'`. */
export const sinceDays = (days: string, now = new Date()): string => {
  if (!/^[0-9]+$/.test(days)) fail(`Need a whole number of days, got '${days}'.`);
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - Number(days));
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 0)
    fail(`Cannot resolve ${days} days ago: the count is too large.`);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Display width of a byte string: its UTF-8 characters. */
const width = (s: string): number => [...Buffer.from(s, "latin1").toString("utf8")].length;

/** Tab-separated rows as a table, as `column -t -s $'\t'` aligns them. */
export const aligned = (rows: readonly string[]): string => {
  const cells = rows.map((r) => r.split("\t"));
  const widths: number[] = [];
  for (const row of cells)
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, width(c));
    });
  return cells
    .map((row) =>
      row
        .map((c, i) => (i === row.length - 1 ? c : c + " ".repeat((widths[i] ?? 0) - width(c) + 2)))
        .join("")
        .replace(/ +$/, ""),
    )
    .map((l) => `${l}\n`)
    .join("");
};

/** Rows trimmed to LIST_LIMIT, announced on stderr only when that hid a match. */
const trimCap = (rows: string[], o: Output): string[] => {
  if (rows.length <= LIST_LIMIT) return rows;
  o.err(`Only the newest ${LIST_LIMIT} are shown; older matches in this window are hidden.\n`);
  return rows.slice(0, LIST_LIMIT);
};

const ISSUES_JQ =
  '.[] | ["#\\(.number)", .createdAt[:10], .state, ([(.labels // [])[].name] | join(", ")), .title] | @tsv';

const PRS_JQ = `
  def bad: (.conclusion // .state // "") as $s
    | ["FAILURE","TIMED_OUT","CANCELLED","ACTION_REQUIRED","STARTUP_FAILURE","ERROR"] | index($s);
  def waiting: (.status // .state // "") as $s
    | ["QUEUED","IN_PROGRESS","PENDING","WAITING","REQUESTED","EXPECTED"] | index($s);
  def checks: if length == 0 then "none"
    elif any(.[]; bad) then "fail"
    elif any(.[]; waiting) then "pending"
    else "pass" end;
  def review: if . == null or . == "" then "-"
    elif . == "APPROVED" then "approved"
    elif . == "CHANGES_REQUESTED" then "changes"
    elif . == "REVIEW_REQUIRED" then "required"
    else ascii_downcase end;
  .[] | ["#\\(.number)", .createdAt[:10], (if .isDraft then "DRAFT" else .state end),
         (.reviewDecision | review), (.statusCheckRollup // [] | checks), .title] | @tsv`;

const recent = (
  ctx: Ctx,
  o: Output,
  kind: {
    args: string[];
    json: string;
    jq: string;
    failText: string;
    none: string;
    title: string;
    header: string;
  },
  days: string,
) => {
  const since = sinceDays(days);
  const ran = run(
    [
      "gh",
      ...kind.args,
      "--search",
      `created:>=${since} sort:created-desc`,
      "--limit",
      String(LIST_LIMIT + 1),
      "--json",
      kind.json,
      "--jq",
      kind.jq,
    ],
    { cwd: ctx.cwd, env: ctx.env },
  );
  o.err(ran.stderr);
  if (ran.code !== 0) fail(kind.failText);
  const text = stripNewlines(ran.stdout);
  if (text === "") {
    o.out(`${kind.none} ${since}.\n`);
    return o.done();
  }
  const rows = trimCap(text.split("\n"), o);
  o.out(`${kind.title} ${since}:\n\n`);
  o.out(aligned([kind.header, ...rows]));
  return o.done();
};

export const devUtils: Command = (ctx) => {
  const o = new Output();
  const [sub, ...rest] = ctx.argv;
  const n = ctx.argv.length;
  return guard(o, () => {
    switch (sub) {
      case "main-root":
        if (n !== 1) fail("main-root takes no arguments.");
        o.out(`${mainRoot(ctx.cwd, ctx.env, o)}\n`);
        return o.done();
      case "diagnostic-base":
        if (n !== 1) fail("diagnostic-base takes no arguments.");
        o.out(`${diagnosticBase(ctx.cwd, ctx.env)}\n`);
        return o.done();
      case "search-production":
        if (!(n >= 2 && n <= 3 && rest[0]))
          fail("search-production requires a literal symbol and optional directory.");
        return o.done(0, [
          "rg",
          "-n",
          "-F",
          "-g",
          "!**/{test,tests,spec,specs,__tests__}/**",
          "-g",
          "!**/*_test.*",
          "-g",
          "!**/*_spec.*",
          "-g",
          "!**/*.test.*",
          "-g",
          "!**/*.spec.*",
          "--",
          rest[0] as string,
          rest[1] ?? ".",
        ]);
      case "issue-create": {
        const [title, body, ...opts] = rest;
        // gh runs in ctx.cwd, so a relative body file is checked there.
        const at = body?.startsWith("/") ? body : `${ctx.cwd}/${body}`;
        if (!(n >= 3 && title && body !== undefined && isReadableFile(at)))
          fail("issue-create requires a nonempty title and a readable body file.");
        return o.done(0, [
          "gh",
          "issue",
          "create",
          "--title",
          title as string,
          "--body-file",
          body as string,
          ...opts,
        ]);
      }
      case "recent-issues":
        if (n > 2) fail("recent-issues takes an optional number of days.");
        return recent(
          ctx,
          o,
          {
            args: ["issue", "list", "--assignee", "@me"],
            json: "number,title,state,createdAt,labels",
            jq: ISSUES_JQ,
            failText: "Cannot list assigned issues.",
            none: "No issues assigned to @me, created since",
            title: "Issues assigned to @me, created since",
            header: "NUMBER\tCREATED\tSTATE\tLABELS\tTITLE",
          },
          rest[0] ?? "7",
        );
      case "recent-prs":
        if (n > 2) fail("recent-prs takes an optional number of days.");
        return recent(
          ctx,
          o,
          {
            args: ["pr", "list", "--author", "@me"],
            json: "number,title,state,createdAt,isDraft,reviewDecision,statusCheckRollup",
            jq: PRS_JQ,
            failText: "Cannot list your pull requests.",
            none: "No pull requests you opened, created since",
            title: "Pull requests you opened, created since",
            header: "NUMBER\tCREATED\tSTATE\tREVIEW\tCHECKS\tTITLE",
          },
          rest[0] ?? "7",
        );
      case "--help":
      case "-h":
        o.out(`${USAGE}\n`);
        return o.done();
      default:
        o.err(`${USAGE}\n`);
        return o.done(2);
    }
  });
};

const isReadableFile = (p: string): boolean => isFile(p) && readable(p);
