// Byte strings: core handles text as latin1-decoded bytes, one char per byte, so matching,
// slicing, and hashing see the same bytes the original bash saw under LC_ALL=C. Convert at the
// edges only: files are read and written as latin1, process IO as Buffers, and UTF-8 text from
// JSON or source literals goes through b().

/** A UTF-8 string as a byte string. */
export const b = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

/** A byte string as UTF-8 text (invalid sequences become U+FFFD). */
export const utf8 = (bytes: string): string => Buffer.from(bytes, "latin1").toString("utf8");

/** POSIX [[:space:]] in the C locale. */
export const SPACE = " \t\n\v\f\r";

/** ASCII-only lowercase, as tolower() in the C locale. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Trims C-locale whitespace from both ends. */
export const trimSpace = (s: string): string => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

/** What `$(...)` keeps of a command's output: trailing newlines removed. */
export const stripNewlines = (s: string): string => s.replace(/\n+$/, "");

/** Lines as `while read` sees them from `printf '%s\n' "$s"`; none for an empty string. */
export const lines = (s: string): string[] => (s === "" ? [] : stripNewlines(s).split("\n"));

/** Version order of two strings, as sort -V on names that differ only in digit runs. */
export const versionCompare = (a: string, b2: string): number => {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b2.match(re) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d < 0n ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

/** Byte order, as a C-locale glob sorts its matches. */
export const byteCompare = (a: string, b2: string): number => (a < b2 ? -1 : a > b2 ? 1 : 0);
