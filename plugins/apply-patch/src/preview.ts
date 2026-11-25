/** Display model shared by the input and result views. Patch text is parsed leniently here; the runtime's parser owns validation. */
export type FileStatus = "added" | "updated" | "deleted" | "moved" | "unchanged";
export interface FileView {
  status: FileStatus;
  path: string;
  destination?: string;
  /** Single-file unified diff, or null when there is nothing to show. */
  diff: string | null;
  diffOmitted?: boolean;
}

const HEADER = /^\*\*\* (Add|Update|Delete) File: (.*)$/u;
const MOVE = "*** Move to: ";

interface Draft { kind: "Add" | "Update" | "Delete"; path: string; destination?: string; hunks: { locator?: string; rows: string[] }[] }

/**
 * Files described so far by patch text that may still be streaming. Hunks have no file positions, so the
 * synthesized headers only carry counts that match their rows; render them without line numbers.
 */
export function previewFiles(text: string): FileView[] {
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const header = HEADER.exec(line);
    if (header) {
      current = { kind: header[1] as Draft["kind"], path: header[2]!, hunks: [] };
      drafts.push(current);
      if (current.kind === "Add") current.hunks.push({ rows: [] });
      continue;
    }
    if (line === "*** End Patch") break;
    if (!current || current.kind === "Delete") continue;
    if (current.kind === "Update" && line.startsWith(MOVE) && !current.hunks.length) current.destination = line.slice(MOVE.length);
    else if (current.kind === "Update" && (line === "@@" || line.startsWith("@@ "))) current.hunks.push({ locator: line === "@@" ? undefined : line.slice(3), rows: [] });
    else if (current.kind === "Add" ? line.startsWith("+") : /^[ +-]/u.test(line)) current.hunks.at(-1)?.rows.push(line);
  }
  return drafts.map(draft => ({
    status: draft.kind === "Add" ? "added" : draft.kind === "Delete" ? "deleted" : draft.destination ? "moved" : "updated",
    path: draft.path,
    ...(draft.destination ? { destination: draft.destination } : {}),
    diff: draft.kind === "Delete" ? null : synthesize(draft),
  }));
}

function synthesize(draft: Draft): string | null {
  const hunks = draft.hunks.filter(hunk => hunk.rows.length);
  if (!hunks.length) return null;
  const out = [`--- ${draft.kind === "Add" ? "/dev/null" : draft.path}`, `+++ ${draft.destination ?? draft.path}`];
  // A one-line gap between hunks lets the diff view mark each boundary.
  let oldNext = 1, newNext = 1;
  for (const { locator, rows } of hunks) {
    const removed = rows.filter(row => row[0] !== "+").length;
    const added = rows.filter(row => row[0] !== "-").length;
    const range = (next: number, count: number) => `${count ? next : next - 1},${count}`;
    out.push(`@@ -${range(oldNext, removed)} +${range(newNext, added)} @@${locator === undefined ? "" : ` ${locator}`}`, ...rows);
    oldNext += removed + 1;
    newNext += added + 1;
  }
  return `${out.join("\n")}\n`;
}

/** Added and removed line counts in a unified diff body; file headers before the first hunk are not lines. */
export function diffStats(diff: string | null): { added: number; removed: number } {
  let added = 0, removed = 0, body = false;
  for (const line of diff?.split("\n") ?? []) {
    if (line.startsWith("@@")) body = true;
    else if (body && line[0] === "+") added++;
    else if (body && line[0] === "-") removed++;
  }
  return { added, removed };
}
