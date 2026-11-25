import { PatchError, quote, type Hunk } from "./syntax.ts";

type Ending = "" | "\n" | "\r\n";
type SourceLine = { text: string; ending: Ending };
const space = /\p{White_Space}/u;
function trailing(text: string) {
  let end = text.length;
  while (end && space.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}
function edge(text: string) {
  let start = 0;
  while (start < text.length && space.test(text[start]!)) start++;
  return trailing(text.slice(start));
}
const editorial = (text: string) => edge(text).replace(/[‐‑‒–—―−‘’‚‛“”„‟\p{Zs}]/gu, char => {
  if (space.test(char)) return " ";
  if ("‘’‚‛".includes(char)) return "'";
  return "“”„‟".includes(char) ? '"' : "-";
});
const passes = [
  { name: "exact", key: (text: string) => text },
  { name: "trailing whitespace", key: trailing },
  { name: "leading/trailing whitespace", key: edge },
  { name: "typographic punctuation/space", key: editorial },
];

function split(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
    if (lines.length >= 250_000) throw new PatchError("file_too_large", "Update supports files of at most 250,000 lines.");
    const crlf = end > start && text[end - 1] === "\r";
    lines.push({ text: text.slice(start, end - Number(crlf)), ending: crlf ? "\r\n" : "\n" });
    start = end + 1;
  }
  if (start < text.length) {
    if (lines.length >= 250_000) throw new PatchError("file_too_large", "Update supports files of at most 250,000 lines.");
    lines.push({ text: text.slice(start), ending: "" });
  }
  return lines;
}

/** Prefix table keeps searches linear even for long, repetitive contexts. */
function find(source: readonly string[], needle: readonly string[], start: number, end: number, limit: number): number[] {
  if (!needle.length || start < 0 || end - start < needle.length) return [];
  const prefix = new Uint32Array(needle.length);
  for (let i = 1, n = 0; i < needle.length; i++) {
    while (n && needle[i] !== needle[n]) n = prefix[n - 1]!;
    if (needle[i] === needle[n]) n++;
    prefix[i] = n;
  }
  const hits: number[] = [];
  for (let i = start, n = 0; i < end; i++) {
    while (n && source[i] !== needle[n]) n = prefix[n - 1]!;
    if (source[i] === needle[n]) n++;
    if (n === needle.length) {
      hits.push(i - n + 1);
      if (hits.length === limit) break;
      n = prefix[n - 1]!;
    }
  }
  return hits;
}

function hint(source: readonly string[], expected: readonly string[], replacement: readonly string[], start: number, eof: boolean): string {
  if (source.length <= 100_000) {
    const [earlier] = find(source, expected, 0, source.length, 1);
    if (earlier !== undefined && earlier < start) return ` Exact context exists at file line ${earlier + 1}, before the search began. Check locator and hunk order.`;
    if (earlier !== undefined && eof) return ` Exact context exists at file line ${earlier + 1}, but not at EOF. Check the EOF marker.`;
    if (replacement.length && expected.join("\n") !== replacement.join("\n") && find(source, replacement, start, source.length, 1).length) {
      return " Replacement text already appears in the search range; the change may already be applied.";
    }
  }
  // Find a nearby candidate from the first informative context line; this is diagnostic only.
  const anchors = expected.slice(0, 12).map((text, offset) => ({ text: edge(text), offset })).filter(row => row.text).slice(0, 3);
  const last = Math.min(source.length, start + 5000);
  let best: { at: number; score: number } | undefined;
  let budget = 1000;
  for (let i = start; i < last && budget > 0; i++) {
    const current = edge(source[i]!);
    for (const anchor of anchors) {
      if (current !== anchor.text || i - anchor.offset < start) continue;
      const at = i - anchor.offset;
      let score = 0;
      for (let k = 0; k < Math.min(12, expected.length, source.length - at) && budget > 0; k++, budget--) {
        if (edge(source[at + k]!) === edge(expected[k]!)) score++;
      }
      if (!best || score > best.score) best = { at, score };
    }
  }
  if (!best) return " Re-read the file and include literal context around the intended change.";
  const sample = source.slice(best.at, best.at + Math.min(3, expected.length)).map(line => quote(line)).join(" / ");
  return ` Nearby candidate at file line ${best.at + 1}: ${sample}. Re-read before retrying.`;
}

export function updateText(original: string, hunks: Hunk[]): { text: string; warnings: string[] } {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = split(original.slice(bom.length));
  const source = lines.map(line => line.text);
  const views = new Map<number, string[]>([[0, source]]);
  const view = (pass: number) => {
    if (!views.has(pass)) views.set(pass, source.map(passes[pass]!.key));
    return views.get(pass)!;
  };
  const fallback = lines.find(line => line.ending)?.ending || "\n";
  const result: SourceLine[] = [];
  const warnings: string[] = [];
  let consumed = 0;
  let work = 0;
  for (const [index, hunk] of hunks.entries()) {
    const fail = (code: string, message: string): never => { throw new PatchError(code, `Hunk ${index + 1} (patch line ${hunk.line}): ${message}`); };
    function locate(needle: string[], start: number, end: number, limit: number) {
      for (const [pass, strategy] of passes.entries()) {
        work += Math.max(0, end - start) + needle.length;
        if (work > 8_000_000) fail("match_budget", "Context search limit reached; split the patch or use literal locators.");
        const haystack = view(pass);
        const keys = needle.map(strategy.key);
        // A patch may include the source BOM, but only as metadata for source line 1.
        const atBom = bom && start === 0 && needle[0]?.startsWith(bom) && end >= needle.length
          && haystack[0] === strategy.key(needle[0].slice(bom.length))
          && keys.slice(1).every((key, i) => haystack[i + 1] === key);
        const hits = atBom ? [0, ...(limit > 1 ? find(haystack, keys, 1, end, limit - 1) : [])]
          : find(haystack, keys, start, end, limit);
        if (hits.length) return { hits, pass };
      }
      return undefined;
    }
    let start = consumed;
    if (hunk.locator !== undefined) {
      const found = locate([hunk.locator], start, source.length, 1)
        ?? fail("locator_not_found", `Locator ${quote(hunk.locator)} was not found from file line ${start + 1}. Re-read the file or use a bare '@@'.`);
      start = found.hits[0]! + 1;
      if (found.pass) warnings.push(`Hunk ${index + 1}: locator matched at file line ${start} using ${passes[found.pass]!.name}.`);
    }
    const expected = hunk.rows.filter(row => row.kind !== "+").map(row => row.text);
    let at = lines.length;
    if (expected.length) {
      const lower = hunk.eof ? Math.max(start, source.length - expected.length) : start;
      const found = locate(expected, lower, source.length, 2);
      if (!found) {
        const snippet = expected.slice(0, 3).map(line => quote(line)).join(" / ");
        const replacement = hunk.rows.filter(row => row.kind !== "-").map(row => row.text);
        fail("context_not_found", `Context not found from file line ${start + 1}${hunk.eof ? " at EOF" : ""}. Expected ${snippet}.${hint(source, expected, replacement, start, hunk.eof)}`);
      } else {
        at = found.hits[0]!;
        if (found.hits.length > 1) fail("ambiguous_context", `Context matches file lines ${at + 1} and ${found.hits[1]! + 1}. Include more literal context, use an earlier unique locator, or anchor to EOF.`);
        if (found.pass) warnings.push(`Hunk ${index + 1}: context matched at file line ${at + 1} using ${passes[found.pass]!.name}.`);
      }
    }
    for (; consumed < at; consumed++) result.push(lines[consumed]!);
    let rowIndex = 0;
    while (rowIndex < hunk.rows.length) {
      const row = hunk.rows[rowIndex++]!;
      if (row.kind === " ") { result.push(lines[consumed++]!); continue; }
      const removed: SourceLine[] = [];
      const added: string[] = [];
      const previous = lines[consumed - 1]?.ending;
      const collect = (change: typeof row) => {
        if (change.kind === "-") removed.push(lines[consumed++]!);
        else added.push(change.text);
      };
      collect(row);
      while (rowIndex < hunk.rows.length && hunk.rows[rowIndex]!.kind !== " ") collect(hunk.rows[rowIndex++]!);
      for (const [i, text] of added.entries()) {
        const ending = (removed[i] ?? removed.at(-1))?.ending ?? (previous || lines[consumed]?.ending || fallback);
        result.push({ text, ending });
      }
    }
  }
  for (; consumed < lines.length; consumed++) result.push(lines[consumed]!);
  return { text: bom + result.map(({ text, ending }, i) => text + (ending || (i + 1 < result.length ? fallback : ""))).join(""), warnings };
}
