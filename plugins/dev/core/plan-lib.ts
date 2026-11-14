// Plan reading shared by the gate, dev-stack, and dev-publish: plan paths, header fields, the
// Stacks On tree, and the stack log (../rules/plan.md). Construct one PlanLib per invocation with
// the main working-tree root; it caches what it reads, so a caller reads a plan before changing it,
// never after. Methods return values and status; callers decide how to fail. All text is byte
// strings (bytes.ts).

import * as fs from "node:fs";
import {
  asciiLower,
  b,
  byteCompare,
  lines,
  stripNewlines,
  trimSpace,
  versionCompare,
} from "./bytes.ts";
import {
  basename,
  dirname,
  git,
  globNames,
  isDir,
  isFile,
  isLink,
  readable,
  readBytes,
  realpathM,
} from "./sys.ts";

/** A plan path relative to the repository's docs/plans. */
export const PLAN_REL_RE = /^[0-9]+_[a-z0-9-]+\/pr[1-9][0-9]*\.spec\.md$/;

/** Stop characters around a plan mention: whitespace and the punctuation messages put around it. */
const MENTION_RE = new RegExp(
  `[^\\][ \\t\\n\\v\\f\\r@\`"'()<>{}|${b("│")}*,;:!?]*pr[0-9]+\\.spec\\.md`,
  "g",
);

/** Every pr<N>.spec.md mention in `text`, in order (text is a byte string). */
export const planMentions = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split("\n")) for (const m of line.matchAll(MENTION_RE)) out.push(m[0]);
  return out;
};

/** The rank of a status in the sequence; undefined for an unknown status. */
export const statusRank = (status: string): number | undefined =>
  ({
    planning: 0,
    "needs-changes": 0,
    ready: 0,
    approved: 1,
    "auto-approved": 1,
    implemented: 2,
    reviewed: 3,
    published: 4,
  })[status];

/** The N of pr<N>.spec.md. */
export const planNumber = (plan: string): string => {
  const i = plan.lastIndexOf("/pr");
  const n = i < 0 ? plan : plan.slice(i + 3);
  return n.endsWith(".spec.md") ? n.slice(0, -".spec.md".length) : n;
};

/** The stack's log path. */
export const stackLog = (plan: string): string => `${dirname(plan)}/log`;

/** awk's default field splitting. */
const fields = (line: string): string[] => line.split(/[ \t\n]+/).filter((f) => f !== "");

type Parsed = { head: string; stacks: string; spec: string };

/** One plan file as the header reader sees it (dev-plan-lib.sh PLAN_AWK). */
const parsePlan = (text: string): Parsed | undefined => {
  if (text === "") return undefined;
  const rows = text.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  let head = "";
  let line = "";
  let spec = "";
  let fenced = false;
  let body = false;
  let n = 0;
  let bad = false;
  const seen = new Set<string>();
  for (const row of rows) {
    let record = false;
    if (!fenced && !body) {
      const m = /^[A-Z][A-Za-z ]*:/.exec(row);
      if (m) {
        const key = m[0].slice(0, -1);
        if (!seen.has(key)) {
          seen.add(key);
          head += `${row}\n`;
          record = key === "Status" || key === "Spec" || key === "Tip";
        }
      }
    }
    if (!record) spec += `${row}\n`;
    if (/^[ \t\n\v\f\r]*(```|~~~)/.test(row)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (row.startsWith("## ")) body = true;
    const l = row.replace(/^[ \t\n\v\f\r>*_-]+/, "");
    if (/^stacks[ \t\n\v\f\r]+on/.test(asciiLower(l))) {
      n++;
      if (body || !row.startsWith("Stacks On:")) bad = true;
      line = row.replace(/^Stacks On:[ \t\n\v\f\r]*/, "").replace(/[ \t\n\v\f\r]+$/, "");
    }
  }
  const stacks = fenced || n > 1 || bad || (n > 0 && line === "") ? "!" : line;
  return { head: `\n${head}`, stacks, spec };
};

export class PlanLib {
  readonly repoRoot: string;
  readonly home: string;
  readonly worktreesRoot: string;
  readonly repoPlans: string;
  readonly planFormat: string;
  /** Whether childPlans keeps published plans. */
  includePublished = false;

  private readonly plans = new Map<string, Parsed>();
  private readonly planFiles = new Map<string, string[]>();
  private worktreeList: string | undefined;
  private localBranches: string | undefined;

  /** `repoRoot`, `home`, and `worktreesRoot` are byte strings; worktreesRoot is AI_WORKTREES_ROOT. */
  constructor(repoRoot: string, env: { home: string; worktreesRoot?: string | undefined }) {
    this.repoRoot = repoRoot;
    this.home = env.home;
    this.worktreesRoot = realpathM(env.worktreesRoot || `${env.home}/work/wt`);
    this.repoPlans = realpathM(`${repoRoot}/docs/plans`);
    const format = `${this.repoPlans}/<issue>_<slug>/pr<N>.spec.md`;
    this.planFormat = format.startsWith(`${this.home}/`)
      ? `~/${format.slice(this.home.length + 1)}`
      : format;
  }

  // ── paths ────────────────────────────────────────────────────────────

  /** The absolute path of a plan of this repository, or undefined (dev-plan-lib.sh canonical_plan). */
  canonicalPlan(input: string): string | undefined {
    let p = input;
    if (p.startsWith("~/")) p = `${this.home}/${p.slice(2)}`;
    if (!p.startsWith("/") || p.endsWith("/")) return undefined;
    const real = `${realpathM(dirname(p))}/${basename(p)}`;
    if (!real.startsWith(`${this.repoPlans}/`)) return undefined;
    return PLAN_REL_RE.test(real.slice(this.repoPlans.length + 1)) ? real : undefined;
  }

  /** Whether Git ignores docs/plans in the main root. */
  plansIgnored(): boolean {
    return (
      git(["check-ignore", "-q", "--no-index", "--", "docs/plans/0_x/pr1.spec.md"], {
        cwd: this.repoRoot,
      }).code === 0
    );
  }

  /** A plan path as shown to people: relative to this repository's plans. */
  planLabel(plan: string): string {
    return plan.startsWith(`${this.repoPlans}/`) ? plan.slice(this.repoPlans.length + 1) : plan;
  }

  // ── headers ──────────────────────────────────────────────────────────

  private load(paths: readonly string[]): void {
    for (const p of paths) {
      const text = readBytes(p);
      const parsed = text === undefined ? undefined : parsePlan(text);
      this.plans.set(p, parsed ?? { head: "", stacks: "", spec: "" });
    }
  }

  /** Reads the files again, replacing what the cache holds for them (dev-plan-lib.sh load_plans). */
  reload(paths: readonly string[]): void {
    this.load(paths);
  }

  /** Caches `text` as the plan at `key`, as load_plans reads a file holding it. */
  loadText(key: string, text: string): void {
    this.plans.set(key, parsePlan(text) ?? { head: "", stacks: "", spec: "" });
  }

  /** The plan files in a directory, in number order, as the stack index lists them. */
  private dirPlans(dir: string): string[] {
    return (
      this.planFiles.get(dir) ??
      globNames(dir, "pr", ".spec.md").sort((x, y) => versionCompare(x, y))
    );
  }

  /** Reads every plan in plan's directory, the worktrees, and the local branches once. */
  indexStack(plan: string): void {
    const dir = dirname(plan);
    const files = globNames(dir, "pr", ".spec.md").sort((x, y) => versionCompare(x, y));
    this.planFiles.set(dir, files);
    this.load(files.filter((f) => isFile(f) && readable(f)));
    const wt = git(["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
    this.worktreeList = wt.code === 0 ? stripNewlines(wt.stdout) : "";
    const br = git(["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: this.repoRoot });
    this.localBranches = br.code === 0 ? stripNewlines(br.stdout) : "";
  }

  private loaded(plan: string): Parsed | undefined {
    const hit = this.plans.get(plan);
    if (hit) return hit;
    if (!isFile(plan) || !readable(plan)) return undefined;
    this.load([plan]);
    return this.plans.get(plan);
  }

  /** Header field `key` of plan, trimmed; "" without it; undefined when the plan cannot be read. */
  field(plan: string, key: string): string | undefined {
    const p = this.loaded(plan);
    if (!p) return undefined;
    const marker = `\n${key}:`;
    const i = p.head.indexOf(marker);
    if (i < 0) return "";
    const rest = p.head.slice(i + marker.length);
    const nl = rest.indexOf("\n");
    return trimSpace(nl < 0 ? rest : rest.slice(0, nl));
  }

  /** field() with an unreadable plan read as "". */
  fieldOr(plan: string, key: string): string {
    return this.field(plan, key) ?? "";
  }

  /**
   * Sets header fields of plan in place from [key, value] pairs: each replaces its key's header
   * line, and a missing key goes after Status, which must exist. False when nothing was written.
   */
  setHeader(plan: string, pairs: readonly (readonly [string, string])[]): boolean {
    if (!this.field(plan, "Status")) return false;
    const text = readBytes(plan);
    if (text === undefined) return false;
    const rows = text.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    const val = new Map<string, string>();
    for (const [k, v] of pairs) val.set(k, v);
    const scan = (emit: (row: string, key: string | undefined) => void): void => {
      let fenced = false;
      let body = false;
      const seen = new Set<string>();
      for (const row of rows) {
        if (/^[ \t\n\v\f\r]*(```|~~~)/.test(row)) fenced = !fenced;
        if (row.startsWith("## ") && !fenced) body = true;
        const m = !fenced && !body ? /^[A-Z][A-Za-z ]*:/.exec(row) : null;
        const key = m ? m[0].slice(0, -1) : undefined;
        if (key !== undefined && !seen.has(key)) {
          seen.add(key);
          emit(row, key);
        } else {
          emit(row, undefined);
        }
      }
    };
    const present = new Set<string>();
    scan((_row, key) => {
      if (key !== undefined) present.add(key);
    });
    let out = "";
    scan((row, key) => {
      if (key === undefined) {
        out += `${row}\n`;
        return;
      }
      const v = val.get(key);
      out += v === undefined ? `${row}\n` : `${key}: ${v}\n`;
      if (key === "Status")
        for (const [k] of pairs) if (!present.has(k)) out += `${k}: ${val.get(k) ?? ""}\n`;
    });
    const tmp = `${plan}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      const mode = fs.statSync(Buffer.from(plan, "latin1")).mode & 0o7777;
      fs.writeFileSync(Buffer.from(tmp, "latin1"), Buffer.from(out, "latin1"), { mode });
      fs.chmodSync(Buffer.from(tmp, "latin1"), mode);
      fs.renameSync(Buffer.from(tmp, "latin1"), Buffer.from(plan, "latin1"));
    } catch {
      try {
        fs.rmSync(Buffer.from(tmp, "latin1"), { force: true });
      } catch {}
      return false;
    }
    // The cache keeps what was read before the change, as dev-plan-lib.sh's does.
    return true;
  }

  /**
   * Plan's parent from its `Stacks On: pr<K>` line, in the same directory with K below the plan's
   * own number; "" for a root; undefined on an unreadable plan or line.
   */
  parent(plan: string): string | undefined {
    const p = this.loaded(plan);
    if (!p) return undefined;
    if (p.stacks === "") return "";
    const m = /^pr([1-9][0-9]*)$/.exec(p.stacks);
    if (!m?.[1]) return undefined;
    // bash arithmetic reads a non-numeric N as an unset variable, 0.
    const n = planNumber(plan);
    if (!(BigInt(m[1]) < BigInt(/^[0-9]+$/.test(n) ? n : "0"))) return undefined;
    return `${dirname(plan)}/pr${m[1]}.spec.md`;
  }

  /** Plan's Status; a `reviewed` plan without a Tip SHA reads as an unknown status. */
  status(plan: string): string {
    const s = this.fieldOr(plan, "Status");
    if (s !== "reviewed") return s;
    return /^[0-9a-f]{7,40}$/.test(this.fieldOr(plan, "Tip"))
      ? "reviewed"
      : "reviewed without its SHA";
  }

  /** The Tip SHA review-code recorded on a `reviewed` plan; "" otherwise. */
  greenOf(plan: string): string {
    return this.status(plan) === "reviewed" ? this.fieldOr(plan, "Tip") : "";
  }

  isPublished(plan: string): boolean {
    return this.status(plan) === "published";
  }

  /** The path dev-worktree create gives worktree `name`. */
  worktreePath(name: string): string {
    return `${this.worktreesRoot}/${this.repoRoot.slice(this.repoRoot.lastIndexOf("/") + 1)}-${name}`;
  }

  /** The name plan's own worktree is created under: <issue>_<slug>-pr<N>. */
  worktreeName(plan: string): string {
    return `${basename(dirname(plan))}-pr${planNumber(plan)}`;
  }

  isWorktree(dir: string): boolean {
    if (!isDir(dir) || dir === this.repoRoot) return false;
    let list = this.worktreeList;
    if (list === undefined)
      list = stripNewlines(git(["worktree", "list", "--porcelain"], { cwd: this.repoRoot }).stdout);
    return `\n${list}\n`.includes(`\nworktree ${dir}\n`);
  }

  branchExists(name: string): boolean {
    if (this.localBranches !== undefined)
      return `\n${this.localBranches}\n`.includes(`\nrefs/heads/${name}\n`);
    return (
      git(["show-ref", "--verify", "-q", `refs/heads/${name}`], { cwd: this.repoRoot }).code === 0
    );
  }

  /** Plan's own worktree when registered; else "". */
  worktreeOf(plan: string): string {
    const own = this.worktreePath(this.worktreeName(plan));
    return this.isWorktree(own) ? own : "";
  }

  /**
   * Unpublished plans stacked on plan, by number; "!<plan>" for one whose Stacks On is malformed or
   * names no plan, or that is a symlink, since it may mean plan.
   */
  childPlans(plan: string): string[] {
    const out: string[] = [];
    for (const f of this.dirPlans(dirname(plan))) {
      if (!isFile(f) || f === plan) continue;
      if (!this.includePublished && this.isPublished(f)) continue;
      const parent = isLink(f) ? undefined : this.parent(f);
      if (parent === undefined) out.push(`!${f}`);
      else if (parent === plan) out.push(f);
      else if (parent !== "" && !isFile(parent)) out.push(`!${f}`);
    }
    return out;
  }

  /** Every plan childPlans lists stacked above plan, breadth first, each once. */
  descendantPlans(plan: string): string[] {
    const out: string[] = [];
    const queue = [plan];
    const seen = new Set([plan]);
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const child of this.childPlans(cur)) {
        if (!child.startsWith("!") && seen.has(child)) continue;
        out.push(child);
        if (child.startsWith("!")) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    return out;
  }

  /** The plans in plan's directory with no Stacks On line. */
  rootPlans(plan: string): string[] {
    return globNames(dirname(plan), "pr", ".spec.md")
      .sort(byteCompare)
      .filter((f) => isFile(f) && !isLink(f) && this.parent(f) === "");
  }

  /** The branch plan's PR targets: its parent's Branch, or its Base for a root; undefined on failure. */
  prTarget(plan: string): string | undefined {
    const parent = this.parent(plan);
    if (parent === undefined) return undefined;
    return parent !== "" ? this.field(parent, "Branch") : this.field(plan, "Base");
  }

  /** Whether plan was reviewed on top of its parent's current reviewed tip. */
  containsParentGreen(plan: string, parent: string): boolean {
    const pg = this.greenOf(parent);
    const g = this.greenOf(plan);
    return (
      pg !== "" &&
      g !== "" &&
      git(["merge-base", "--is-ancestor", pg, g], { cwd: this.repoRoot }).code === 0
    );
  }

  /** Plan's spec without trailing newlines; "" for a file it cannot read. */
  spec(plan: string): string {
    return stripNewlines(this.loaded(plan)?.spec ?? "");
  }

  /** git hash-object of a byte string. */
  hashObject(text: string): string {
    return stripNewlines(
      git(["hash-object", "--stdin"], { cwd: this.repoRoot, input: text }).stdout,
    );
  }

  /** A hash of plan's spec and the specs below it; undefined on a missing plan or bad line. */
  planHash(plan: string): string | undefined {
    let text = "";
    let cur = plan;
    while (cur !== "") {
      if (!isFile(cur)) return undefined;
      text += `${this.spec(cur)}\n`;
      const parent = this.parent(cur);
      if (parent === undefined) return undefined;
      cur = parent;
    }
    return this.hashObject(text);
  }

  /** The Spec value verdict records for spec hash. */
  verdictHash(hash: string, verdict: string): string {
    return verdict === "ready" ? hash : this.hashObject(`${hash} ${verdict}\n`);
  }

  /** ready, needs-changes, stale, or "" without a Spec value; undefined when the hash fails. */
  reviewState(plan: string): string | undefined {
    const rec = this.fieldOr(plan, "Spec");
    if (rec === "" || rec === "-") return "";
    const hash = this.planHash(plan);
    if (hash === undefined) return undefined;
    if (rec === hash) return "ready";
    if (rec === this.verdictHash(hash, "needs-changes")) return "needs-changes";
    return "stale";
  }

  // ── stack log ────────────────────────────────────────────────────────

  /** Plan's log lines, in order, without their prefix. */
  logLines(plan: string): string[] {
    const text = readBytes(stackLog(plan));
    if (text === undefined) return [];
    const prefix = `pr${planNumber(plan)}: `;
    const rows = text.split("\n");
    if (rows[rows.length - 1] === "") rows.pop();
    return rows.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
  }

  /** What a stop record is bound to; undefined when the plan cannot be hashed. */
  stopKey(plan: string): string | undefined {
    const hash = this.planHash(plan);
    if (hash === undefined) return undefined;
    const branch = this.fieldOr(plan, "Branch");
    let tip = "-";
    if (branch !== "") {
      const r = git(["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], {
        cwd: this.repoRoot,
      });
      tip = r.code === 0 ? stripNewlines(r.stdout) : `${stripNewlines(r.stdout)}-`;
    }
    let status = this.fieldOr(plan, "Status");
    if (statusRank(status) === 0) status = "planning";
    return this.hashObject(`${status} ${this.fieldOr(plan, "Tip")}\n${hash}\n${tip}\n`);
  }

  /** Plan's stop reasons since its last resume. */
  stopRecords(plan: string): string[] {
    let recs: string[] = [];
    for (const l of this.logLines(plan)) {
      if (l === "cleared" || l === "reopened") recs = [];
      else if (l.startsWith("stop ")) recs.push(l.slice(5));
    }
    return recs;
  }

  /** Why plan is stopped; "" when it is not; undefined when the plan cannot be hashed. */
  stopReason(plan: string): string | undefined {
    const recs = lines(
      this.stopRecords(plan)
        .map((r) => `${r}\n`)
        .join(""),
    );
    if (recs.length === 0) return "";
    let held = "";
    for (const rec of recs) {
      const m = /^(.+) at [0-9a-f]{40,64}$/.exec(rec);
      if (m?.[1] && heldStop(m[1])) held = m[1];
    }
    if (held !== "") return held;
    const key = this.stopKey(plan);
    if (key === undefined) return undefined;
    const m = /^(.+) at ([0-9a-f]{40,64})$/.exec(recs[recs.length - 1] ?? "");
    return m?.[1] && m[2] === key ? m[1] : "";
  }

  /** The review rounds recorded and allowed for kind `review` or `code-review`. */
  roundBudget(plan: string, kind: string): { round: number; limit: number } {
    let k = 0;
    let l = 3;
    for (const line of this.logLines(plan)) {
      const f = fields(line);
      if (f[0] === kind) {
        k++;
        if (kind === "code-review" && f[1] === "pass") {
          k = 0;
          l = 3;
        }
        continue;
      }
      if (line === "cleared") {
        if (k >= l) l = k + 3;
        continue;
      }
      if (line === "reopened" || line === "auto-reopened") {
        k = 0;
        l = 3;
      }
    }
    return { round: k, limit: l };
  }

  /** Whether plan's last review-code verdict is a pass logged at its Tip. */
  passedAtTip(plan: string): boolean {
    const tip = this.greenOf(plan);
    if (tip === "") return false;
    let last = "";
    for (const l of this.logLines(plan)) if (fields(l)[0] === "code-review") last = l;
    const m = /^code-review pass \([0-9]+\/[0-9]+\) at ([0-9a-f]{7,64})$/.exec(last);
    return !!m?.[1] && (m[1].startsWith(tip) || tip.startsWith(m[1]));
  }

  /** Who approved plan since its last reopen: auto-approved, approved, or "". */
  approvalKind(plan: string): string {
    let a = "";
    for (const l of this.logLines(plan)) {
      if (l === "reopened" || l === "auto-reopened") a = "";
      else {
        const f = fields(l);
        if (f[0] === "approve") a = f[1] ?? "";
      }
    }
    return a;
  }

  /** How many times autopilot reopened plan. */
  autoReopens(plan: string): number {
    return this.logLines(plan).filter((l) => l === "auto-reopened").length;
  }

  /** The spec hash plan was approved at since its last reopen; "" when it was not. */
  approvedHash(plan: string): string {
    let h = "";
    for (const l of this.logLines(plan)) {
      if (l === "reopened" || l === "auto-reopened") h = "";
      else if (fields(l)[0] === "approve") {
        const m = / at ([0-9a-f]+)$/.exec(l);
        if (m?.[1]) h = m[1];
      }
    }
    return h;
  }

  /** Whether plan's last review-feature verdict since its last reopen is ready at its spec hash. */
  reviewLogged(plan: string): boolean {
    let last = "";
    for (const l of this.logLines(plan)) {
      if (l === "reopened" || l === "auto-reopened") last = "";
      else if (fields(l)[0] === "review") last = l;
    }
    const m = /^review ready \([0-9]+\/[0-9]+\) at ([0-9a-f]+)$/.exec(last);
    if (!m) return false;
    const hash = this.planHash(plan);
    return hash !== undefined && m[1] === hash;
  }

  /** Why plan breaks the approval ratchet (../rules/plan.md#changes); "" when it does not. */
  freezeReason(plan: string): string {
    const approved = this.approvedHash(plan);
    if (approved === "") return "";
    const status = this.status(plan);
    const rank = statusRank(status);
    if (rank === 4) return "";
    if (rank === 0)
      return `it was approved at ${approved}, but its Status is '${status}'; an approved plan never returns to planning. The user reverts the change, or reopens it with dev-stack.ts reopen; where a change goes instead follows rules/plan.md#changes`;
    const hash = this.planHash(plan);
    if (hash === undefined)
      return `it was approved at ${approved}, but a plan below it is missing or unreadable`;
    return hash === approved
      ? ""
      : `its spec, or a spec below it, changed since its approval at ${approved}; an approved plan is frozen. The user reverts the change, or reopens it with dev-stack.ts reopen (rules/plan.md#changes)`;
  }
}

/**
 * Whether stop reason holds until the user's resume: a review round limit, or failed fixes at
 * their limit, "Failed fixes: <n>/<limit>" with n >= limit (../rules/CORE.md#work).
 */
export const heldStop = (reason: string): boolean => {
  if (/(review-feature|review-code) round limit \([0-9]+\/[0-9]+\)/.test(reason)) return true;
  for (const line of reason.split("\n"))
    for (const m of line.matchAll(/Failed fixes: ([0-9]+)\/([0-9]+)(?:[^0-9]|$)/g)) {
      const n = Number(m[1]);
      const lim = Number(m[2]);
      if (lim > 0 && n >= lim) return true;
    }
  return false;
};
