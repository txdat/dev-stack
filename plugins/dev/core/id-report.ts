// Format and closure of a plan's IDs (../rules/plan.md#schema): AC <- TC (Proves:) <- ST
// (satisfies). It proves every ID is well formed, declared once, and linked, never that an edge is
// true.
//
// Output classes the caller keeps apart: `!` means the IDs could not be read (ranges, leading
// zeros, duplicates, a missing section, a bad Proves:), so no closure verdict follows; a false
// traceability block would teach readers to distrust the hook. `@` is a citation of another
// artifact's ID. Anything else is a closure finding, including, with `fields`, an AC, TC, or DD
// missing one of its schema fields.

import { b, rowsOf, trimSpace } from "./bytes.ts";

const OWNER: Readonly<Record<string, string>> = {
  AC: "Acceptance Criteria",
  TC: "Test Cases",
  ST: "Implementation Steps",
  PC: "Implementation Steps",
  DD: "Design Decisions",
};

const S = "[ \\t\\n\\v\\f\\r]";
const EN = b("–");
const EM = b("—");
const ID_RE = /[A-Z][A-Z]-[0-9]+/g;

/**
 * Registry IDs in s. An ID must not continue a longer word ("UTC-7", "fix-ST-1"), and a
 * #-qualified ID belongs to another artifact. "TC-2/TC-9" yields both.
 */
const scan = (s: string): string[] => {
  const ids: string[] = [];
  for (const m of s.matchAll(ID_RE)) {
    const at = m.index;
    const pre = at > 0 ? s.charAt(at - 1) : "";
    const post = s.charAt(at + m[0].length);
    if (/[A-Za-z0-9_#-]/.test(pre) || /[A-Za-z0-9_]/.test(post)) continue;
    if (!(m[0].slice(0, 2) in OWNER)) continue;
    ids.push(m[0]);
  }
  return ids;
};

const pfx = (id: string): string => id.slice(0, 2);

/** The fields each AC, TC, and DD carries (../rules/plan.md#schema); TC's Proves: is checked apart. */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  AC: ["Source", "Success", "Failure"],
  TC: ["Fixture", "Action", "Expected"],
  DD: ["Options", "Choice", "Why"],
};

/** A `Label: value` field with a value, at a line's start (after a bullet) or after a `|`. */
const FIELD_RE = /(^|\|)[ \t]*([-*][ \t]*)?([A-Z][A-Za-z]*):[ \t]*[^ \t\n\v\f\r|]/g;

const RANGES = Object.keys(OWNER).map((p) => [
  new RegExp(`${p}-[0-9]+(${S}+(through|thru|to)${S}+|${S}*\\.\\.${S}*|${EN}|-)${p}-[0-9]+`),
  new RegExp(`${p}-[0-9]+${S}+(through|thru|to)${S}+[0-9]+`),
  new RegExp(`${p}-[0-9]+(${EN}|-)[0-9]+`),
  new RegExp(`${p}-[0-9]+${S}*\\.\\.${S}*[0-9]+`),
]);

const PC_CHECK = new RegExp(`(${EM}|${EN}|-)${S}*Check:${S}*[^ \\t\\n\\v\\f\\r]`);
const COUNT_GREP = new RegExp(
  `(^|[^A-Za-z0-9_-])(grep|rg)${S}([^|;&]*${S})?(-[A-Za-z]*c[A-Za-z]*|--count)([ \\t\\n\\v\\f\\r);|&"'\`]|$)`,
);
const COUNT_WC = new RegExp(
  `(^|[^A-Za-z0-9_-])wc${S}([^|;&]*${S})?(-[A-Za-z]*l[A-Za-z]*|--lines)([ \\t\\n\\v\\f\\r);|&"'\`]|$)`,
);

/**
 * The report lines for plan text, in the order the checks find them. With `fields`, each AC, TC,
 * and DD must carry its schema fields, each with a value.
 */
export const idReport = (text: string, opts: { fields?: boolean } = {}): string[] => {
  const out: string[] = [];
  let unreadable = false;
  const bad = (msg: string) => {
    out.push(`!${msg}`);
    unreadable = true;
  };
  const rows = rowsOf(text);

  let fenced = false;
  let sec = "";
  let curtc = "";
  let curst = "";
  const proves = new Map<string, string>();
  const provesline = new Map<string, number>();
  const declared = new Map<string, number>();
  const order: string[] = [];
  const count = new Map<string, number>();
  const refline = new Map<string, number>();
  const reforder: string[] = [];
  const stref = new Map<string, number>();
  const sttxt = new Map<string, string>();
  const tcsat = new Set<string>();
  let item = "";
  const itemFields = new Map<string, Set<string>>();

  rows.forEach((line, i) => {
    const nr = i + 1;
    if (new RegExp(`^${S}*(\`\`\`|~~~)`).test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (line.startsWith("## ")) {
      sec = trimSpace(line.slice(3));
      item = "";
      return;
    }

    // A range hides IDs the parser must see. Both operands carry the prefix (or the second is a
    // bare number), and a dash separator is unspaced, so "TC-1 - 200 returned" and "TC-2 — TC-1
    // variant" are not ranges.
    if (RANGES.some((res) => res.some((re) => re.test(line))))
      bad(`line ${nr} uses an ID range (${trimSpace(line)}) ${EM} list IDs one by one`);

    // A plan cites only its own IDs. Any path-like token before #ID counts.
    if (/[A-Za-z0-9_/.`-]#[A-Z][A-Z]-[0-9]+/.test(line))
      out.push(`@line ${nr} cites another artifact's ID (${trimSpace(line)})`);

    const ids = scan(line);
    const n = ids.length;
    const lead = line.replace(new RegExp(`^${S}*([-*|]${S}*|#+${S}+)?`), "");
    // A line in the owning section that begins with an ID declares it.
    const first = ids[0] ?? "";
    const decl = n > 0 && lead.startsWith(first) && OWNER[pfx(first)] === sec ? first : "";

    // An item's fields are the lines after its declaration, until the next declaration or an
    // unindented line that is not a field, as for Proves: below.
    if (decl !== "") {
      item = pfx(decl) in FIELDS && !itemFields.has(decl) ? decl : "";
      if (item !== "") itemFields.set(item, new Set());
    } else if (item !== "") {
      const labels = [...line.matchAll(FIELD_RE)].map((m) => m[3] as string);
      if (/^[^ \t\n\v\f\r]/.test(line) && !/^([-*][ \t]*)?[A-Za-z][A-Za-z ]*:/.test(line))
        item = "";
      else for (const l of labels) itemFields.get(item)?.add(l);
    }

    if (sec === "Test Cases") {
      if (decl.startsWith("TC-")) {
        curtc = decl;
        proves.set(curtc, "");
        provesline.set(curtc, 0);
      } else if (
        /^[^ \t\n\v\f\r]/.test(line) &&
        !/^([-*][ \t\n\v\f\r]*)?[A-Za-z][A-Za-z ]*:/.test(line)
      ) {
        // A new unindented item that is not a TC or one of its fields ends the current TC, so a
        // later Proves: is not misattributed.
        curtc = "";
      }
      if (new RegExp(`^${S}*([-*]${S}*)?Proves:`).test(line) && curtc !== "") {
        const acs = ids.filter((id) => pfx(id) === "AC");
        const prev = provesline.get(curtc) ?? 0;
        if (prev > 0)
          bad(
            `${curtc} has more than one Proves: line (lines ${prev} and ${nr}) ${EM} exactly one is required`,
          );
        provesline.set(curtc, nr);
        if (acs.length === 0) bad(`${curtc} has an unparseable Proves: line (${trimSpace(line)})`);
        else if (acs.length > 1)
          bad(`${curtc} names ${acs.length} ACs in Proves: ${EM} exactly one is required`);
        else proves.set(curtc, acs[0] as string);
      }
    }

    if (n === 0) return;
    for (const id of ids) {
      if (/-0+$/.test(id)) bad(`line ${nr}: ${id} ${EM} IDs start at 1`);
      else if (/-0/.test(id))
        bad(
          `line ${nr}: ${id} has a leading zero ${EM} write ${pfx(id)}-${id.slice(3).replace(/^0+/, "")}`,
        );
    }

    if (decl !== "") {
      // A reused ID is two items wearing one name, so it is unreadable.
      const at = declared.get(decl);
      if (at !== undefined)
        bad(`${decl} is declared more than once (lines ${at} and ${nr}) ${EM} IDs must be unique`);
      else {
        declared.set(decl, nr);
        order.push(decl);
        count.set(pfx(decl), (count.get(pfx(decl)) ?? 0) + 1);
      }
    }

    for (const id of decl !== "" ? ids.slice(1) : ids)
      if (!refline.has(id)) {
        refline.set(id, nr);
        reforder.push(id);
      }

    // A PC carries a Check, never a count of matches, which an unrelated merge can change
    // (../skills/design-feature/SKILL.md#3-write-the-spec).
    if (decl.startsWith("PC-")) {
      const m = PC_CHECK.exec(line);
      if (!m) out.push(`${decl} has no "${EM} Check: <command>": ${trimSpace(line)}`);
      else {
        let chk = line.slice(m.index);
        chk = chk.slice(chk.indexOf("Check:") + 6);
        if (COUNT_GREP.test(chk) || COUNT_WC.test(chk))
          out.push(
            `${decl} counts matches (grep -c, rg -c, wc -l); check the structure instead, such as a definition with grep -q or a forbidden use with ! grep -q: ${trimSpace(line)}`,
          );
      }
    }

    // A step satisfies the TCs its satisfies clause names, on its own line or a continuation
    // line. A TC mentioned in prose is only a reference.
    if (sec === "Implementation Steps") {
      if (decl.startsWith("ST-")) {
        curst = decl;
        stref.set(curst, 0);
        sttxt.set(curst, trimSpace(line));
      }
      const at = line.search(/satisfies/i);
      if (curst !== "" && at >= 0)
        for (const id of scan(line.slice(at)))
          if (pfx(id) === "TC") {
            tcsat.add(id);
            stref.set(curst, (stref.get(curst) ?? 0) + 1);
          }
    }
  });

  if (!count.get("AC")) bad("no AC- entries under ## Acceptance Criteria");
  if (!count.get("TC")) bad("no TC- entries under ## Test Cases");
  if (!count.get("ST")) bad("no ST- entries under ## Implementation Steps");
  if (unreadable) return out;
  for (const id of reforder)
    if (!declared.has(id))
      out.push(
        `line ${refline.get(id)} cites ${id}, which is not declared: no line in ## ${OWNER[pfx(id)]} begins with it`,
      );
  const proved = new Set(proves.values());
  for (const id of order) {
    if (id.startsWith("AC-")) {
      if (!proved.has(id)) out.push(`${id} has no TC ${EM} no Test Case names it in Proves:`);
    } else if (id.startsWith("TC-")) {
      if (!proves.get(id))
        out.push(`${id} has no Proves: line ${EM} every TC names exactly one AC`);
      if (!tcsat.has(id)) out.push(`${id} is not satisfied by any Implementation Step`);
    } else if (id.startsWith("ST-")) {
      if (!stref.get(id)) out.push(`${id} has no satisfies clause naming a TC: ${sttxt.get(id)}`);
    }
    const have = itemFields.get(id);
    if (opts.fields && have) {
      const missing = (FIELDS[pfx(id)] ?? []).filter((f) => !have.has(f));
      if (missing.length > 0)
        out.push(
          `${id} (line ${declared.get(id)}) has no ${missing.map((f) => `${f}:`).join(", ")} ${EM} write ${
            pfx(id) === "DD"
              ? `"  Options: <considered> | Choice: <chosen, by whom> | Why: <rationale, derivation>"`
              : `each on its own line under ${id}, such as "  ${missing[0]}: <value>"`
          }`,
        );
    }
  }
  return out;
};
