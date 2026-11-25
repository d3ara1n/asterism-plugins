export class PatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface Hunk {
  line: number;
  locator?: string;
  eof: boolean;
  rows: { kind: " " | "-" | "+"; text: string }[];
}
export type Operation = { path: string; line: number } & (
  | { kind: "add"; text: string }
  | { kind: "delete" }
  | { kind: "update"; hunks: Hunk[]; destination?: string }
);

export function quote(text: string, length = 160): string {
  const excerpt = text.length > length ? `${text.slice(0, length)}…` : text;
  return JSON.stringify(excerpt).replace(/[\p{Cf}\p{Z}]/gu, char => char === " " ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

const START = "*** Begin Patch";
const END = "*** End Patch";
const EOF = "*** End of File";
const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/u;
const MOVE = "*** Move to: ";

export function parsePatch(input: string): Operation[] {
  if (Buffer.byteLength(input) > 1024 * 1024) throw new PatchError("patch_too_large", "Patch input is limited to 1 MiB; split it into smaller patches.");
  const lines = input.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > 30_000) throw new PatchError("patch_too_large", "Patch input is limited to 30,000 lines.");
  let cursor = 0;
  const fail = (message: string, at = cursor): never => { throw new PatchError("invalid_patch", `Patch line ${at + 1}: ${message}`); };
  if (lines[cursor] !== START) fail(`Expected ${START}; send the patch without Markdown fences or commentary.`);
  cursor++;
  const operations: Operation[] = [];
  while (cursor < lines.length && lines[cursor] !== END) {
    if (operations.length === 64) throw new PatchError("patch_too_large", "A patch is limited to 64 file operations.");
    const header = HEADER.exec(lines[cursor] ?? "") ?? fail("Expected an Add File, Update File or Delete File header.");
    const path = header[2]!;
    const line = ++cursor;
    if (header[1] === "Add") {
      const added: string[] = [];
      while (lines[cursor]?.startsWith("+")) added.push(lines[cursor++]!.slice(1));
      if (cursor < lines.length && lines[cursor] !== END && !HEADER.test(lines[cursor]!)) {
        fail("Every Add File content line, including a blank line, must begin with '+'.");
      }
      operations.push({ kind: "add", path, line, text: added.length ? `${added.join("\n")}\n` : "" });
    } else if (header[1] === "Delete") {
      operations.push({ kind: "delete", path, line });
    } else {
      let destination: string | undefined;
      if (lines[cursor]?.startsWith(MOVE)) {
        destination = lines[cursor]!.slice(MOVE.length);
        if (!destination) fail("Expected a destination after *** Move to: .");
        cursor++;
      }
      const hunks: Hunk[] = [];
      while (cursor < lines.length && lines[cursor] !== END && !HEADER.test(lines[cursor]!)) {
        const marker = lines[cursor]!;
        if (marker !== "@@" && !/^@@ .+/u.test(marker)) fail("Expected '@@' or '@@ <existing line>' to start a hunk.");
        if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: |$)/u.test(marker)) {
          fail("Use '@@' or a literal source locator instead of a unified-diff line-number header.");
        }
        const hunk: Hunk = { line: ++cursor, locator: marker === "@@" ? undefined : marker.slice(3), eof: false, rows: [] };
        while (cursor < lines.length) {
          const row = lines[cursor]!;
          const kind = row[0];
          if (kind !== " " && kind !== "-" && kind !== "+") break;
          hunk.rows.push({ kind, text: row.slice(1) });
          cursor++;
        }
        if (!hunk.rows.length) fail("A hunk needs at least one prefixed context, removal or addition line.", hunk.line - 1);
        if (lines[cursor] === EOF) { hunk.eof = true; cursor++; }
        hunks.push(hunk);
      }
      if (!hunks.length) fail("Update File requires at least one nonempty hunk.", line - 1);
      operations.push({ kind: "update", path, line, hunks, destination });
    }
  }
  if (lines[cursor] !== END) fail(`Missing ${END}.`);
  if (cursor !== lines.length - 1) fail(`Unexpected text after ${END}.`, cursor + 1);
  if (!operations.length) fail("The patch contains no file operations.");
  return operations;
}
