// Runbooks and architecture documents (../rules/plan.md#documents): their plan-style header, its
// Status and Spec lines, and the hash Spec records. A document is recognized by its path and by
// both header lines; anything else, such as another project's runbook, is no document here. A
// runbook's execution record lives in the uncommitted `log` beside it, so its hash covers the whole
// file but those two lines. Read and hashed as bytes (latin1), matched with ASCII-only classes.

import { rowsOf, stripNewlines } from "./bytes.ts";
import { type Env, git } from "./sys.ts";

export type DocKind = "runbook" | "architecture";

/** The statuses each kind takes, in order. */
export const DOC_STATUSES: Readonly<Record<DocKind, readonly string[]>> = {
  runbook: ["draft", "ready", "approved", "executed"],
  architecture: ["draft", "ready", "approved"],
};

/** Statuses from which a document is frozen: only its Status line changes. */
export const FROZEN = new Set(["approved", "executed"]);

/**
 * The kind a path names, as written under a repository's docs/; undefined for any other path. The
 * fixed segments match in any case, as a case-insensitive filesystem opens them.
 */
export const docKind = (path: string): DocKind | undefined => {
  if (/\/docs\/runbook\/[0-9]+_[a-z0-9-]+\/rb\.md$/is.test(path)) return "runbook";
  if (/\/docs\/architecture\/[0-9]+_[a-z0-9-]+\.html$/is.test(path)) return "architecture";
  return undefined;
};

/** The runbook a runbook log path belongs to; undefined for any other path. */
export const runbookOfLog = (path: string): string | undefined =>
  /\/docs\/runbook\/[0-9]+_[a-z0-9-]+\/log$/is.test(path)
    ? `${path.slice(0, -"log".length)}rb.md`
    : undefined;

export type Doc = {
  /** Header values; "" when missing. */
  status: string;
  spec: string;
  /** Whether both the Status and the Spec header line are present. */
  isDoc: boolean;
  /** Header keys the document repeats, with their lines, as plan-lib reports a plan's. */
  dupes: string[];
  /** The text Spec hashes: without the Status and Spec lines, carriage returns, and trailing blank lines. */
  body: string;
  /** Row index of each header line; -1 when missing. */
  statusRow: number;
  specRow: number;
  rows: string[];
};

/**
 * Parses a document's text. The header is a plan's (plan.md#schema): its `Key: value` lines before
 * the first section heading, outside code fences, each key once. A runbook's section heading is a
 * `## ` line; an architecture document's is an `<h2`, and its header lines sit in a `<pre>` under
 * its `<h1>`.
 */
export const parseDoc = (text: string, kind: DocKind): Doc => {
  const rows = rowsOf(text);
  let status = "";
  let spec = "";
  let statusRow = -1;
  let specRow = -1;
  let fenced = false;
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const [i, row] of rows.entries()) {
    if (kind === "runbook" && /^[ \t\n\v\f\r]*(```|~~~)/.test(row)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (kind === "runbook" ? row.startsWith("## ") : /<h2[ >]/i.test(row)) break;
    const m = /^([A-Z][A-Za-z ]*):[ \t]*(.*?)[ \t]*\r?$/.exec(row);
    if (!m?.[1]) continue;
    const at = seen.get(m[1]);
    if (at !== undefined) {
      dupes.push(`'${m[1]}' on lines ${at} and ${i + 1}`);
      continue;
    }
    seen.set(m[1], i + 1);
    if (m[1] === "Status") [status, statusRow] = [m[2] ?? "", i];
    if (m[1] === "Spec") [spec, specRow] = [m[2] ?? "", i];
  }
  let body = "";
  for (const [i, row] of rows.entries())
    if (i !== statusRow && i !== specRow) body += `${row.replace(/\r$/, "")}\n`;
  body = body.replace(/(\n[ \t]*)+$/, "\n");
  const isDoc = statusRow >= 0 && specRow >= 0;
  return { status, spec, isDoc, dupes, body, statusRow, specRow, rows };
};

/** git hash-object of a document's body. */
export const docHash = (doc: Doc, cwd: string, env: Env): string =>
  stripNewlines(git(["hash-object", "--stdin"], { cwd, env, input: doc.body }).stdout);

/** The document's text with its Status and Spec values replaced, keeping each line's ending. */
export const withHeader = (doc: Doc, status: string, spec: string): string => {
  const rows = [...doc.rows];
  const cr = (i: number) => ((rows[i] ?? "").endsWith("\r") ? "\r" : "");
  rows[doc.statusRow] = `Status: ${status}${cr(doc.statusRow)}`;
  rows[doc.specRow] = `Spec: ${spec}${cr(doc.specRow)}`;
  return rows.map((r) => `${r}\n`).join("");
};
