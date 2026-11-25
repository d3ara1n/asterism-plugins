import { dirname, relative } from "node:path";
import { formatPatch, structuredPatch } from "diff";
import type { CallResult } from "@asterism-app/sdk/runtime";
import type { Receipt } from "./contract.ts";
import { openRoot, readSnapshot, removeText, sameEntry, targetPath, validateText, verify, writeText, type Root, type Snapshot, type Target } from "./filesystem.ts";
import { parsePatch, PatchError, quote, type Operation } from "./syntax.ts";
import { updateText } from "./update.ts";

interface Planned {
  source: Target;
  destination?: Target;
  before: string | null;
  after: string | null;
  receipt: Receipt["files"][number];
  warnings: string[];
}

const label = (source: string, destination?: string) => destination === undefined ? quote(source, 4096) : `${quote(source, 4096)} → ${quote(destination, 4096)}`;
function details(error: unknown) {
  if (error instanceof PatchError) return { code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException)?.code;
  return { code: "filesystem_error", message: code ? `The filesystem reported ${code}.` : "The operation could not be completed." };
}

function makeDiff(oldPath: string, newPath: string, before: string, after: string, budget: number): Pick<Receipt["files"][number], "diff" | "diffOmitted"> {
  if (before === after) return { diff: null, diffOmitted: false };
  if (budget <= 0 || before.length + after.length > 512 * 1024) return { diff: null, diffOmitted: true };
  const patch = structuredPatch(oldPath, newPath, before, after, undefined, undefined, { context: 3, maxEditLength: 4000, timeout: 50 });
  const diff = patch && formatPatch(patch);
  return diff && diff.length <= Math.min(24_000, budget) ? { diff, diffOmitted: false } : { diff: null, diffOmitted: true };
}

async function prepare(root: Root, operations: Operation[], signal: AbortSignal) {
  const initial = new Map<string, Snapshot | null>();
  const state = new Map<string, string | null>();
  const directories = new Set<string>();
  const targets: Target[] = [];
  const planned: Planned[] = [];
  let bytes = 0;
  let diffBudget = 64_000;
  const charge = (size: number) => {
    bytes += size;
    if (bytes > 32 * 1024 * 1024) throw new PatchError("patch_too_large", "The patch requires processing more than 32 MiB of text. Split it across calls.");
  };
  async function resolve(input: string): Promise<Target> {
    const path = await targetPath(root, input);
    if (directories.has(path)) throw new PatchError("path_conflict", "This path is also needed as a directory in the same patch.");
    for (let parent = dirname(path); parent !== root.path && parent !== dirname(parent); parent = dirname(parent)) {
      if (state.has(parent)) throw new PatchError("path_conflict", "A parent path is also targeted as a file in the same patch.");
      directories.add(parent);
    }
    const target = { input, path };
    targets.push(target);
    if (!initial.has(path)) {
      const snapshot = await readSnapshot(path, signal);
      if (snapshot) charge(snapshot.stat.size);
      initial.set(path, snapshot);
      state.set(path, snapshot?.text ?? null);
    }
    return target;
  }
  for (const op of operations) {
    signal.throwIfAborted();
    try {
      const source = await resolve(op.path);
      const before = state.get(source.path)!;
      let after: string | null;
      let destination: Target | undefined;
      let warnings: string[] = [];
      let status: Receipt["files"][number]["status"];
      if (op.kind === "add") {
        if (before !== null) throw new PatchError("already_exists", "Add does not overwrite an existing file. Use Update File for an existing file.");
        after = op.text;
        status = "added";
      } else {
        if (before === null) throw new PatchError("path_not_found", "The source file does not exist at this point in the patch.");
        if (op.kind === "delete") { after = null; status = "deleted"; }
        else {
          if (op.destination !== undefined) {
            destination = await resolve(op.destination);
            const a = initial.get(source.path);
            const b = initial.get(destination.path);
            if (!relative(source.path, destination.path) || (a && b && sameEntry(a.stat, b.stat))) {
              throw new PatchError("same_file", "Move source and destination refer to the same file.");
            }
            if (state.get(destination.path) !== null) throw new PatchError("already_exists", "Move does not overwrite an existing destination.");
          }
          ({ text: after, warnings } = updateText(before, op.hunks));
          status = destination ? "moved" : before === after ? "unchanged" : "updated";
        }
      }
      if (after !== null) charge(validateText(after));
      const displayPath = (path: string) => /[\t\r\n"\\]/u.test(path) ? quote(path, 4096) : path;
      const diff = makeDiff(before === null ? "/dev/null" : displayPath(op.path), after === null ? "/dev/null" : displayPath(destination?.input ?? op.path), before ?? "", after ?? "", diffBudget);
      diffBudget -= diff.diff?.length ?? 0;
      const receipt = { path: op.path, ...(destination ? { destination: destination.input } : {}), status, ...diff };
      planned.push({ source, destination, before, after, receipt, warnings });
      state.set(source.path, destination ? null : after);
      if (destination) state.set(destination.path, after);
    } catch (error) {
      signal.throwIfAborted();
      const { code, message } = details(error);
      throw new PatchError(code, `Patch line ${op.line}, ${label(op.path, op.kind === "update" ? op.destination : undefined)}: ${message}`);
    }
  }
  return { planned, initial, targets };
}

export async function applyPatch(rootPath: string, text: string, signal: AbortSignal): Promise<CallResult<Receipt>> {
  let root: Root;
  let batch: Awaited<ReturnType<typeof prepare>>;
  try {
    signal.throwIfAborted();
    const operations = parsePatch(text);
    root = await openRoot(rootPath);
    batch = await prepare(root, operations, signal);
    // Check all original files and aliases again before the first mutation.
    for (const target of batch.targets) {
      try { await verify(root, target, batch.initial.get(target.path)!, signal); }
      catch (error) {
        const { code, message } = details(error);
        throw new PatchError(code, `${quote(target.input, 4096)}: ${message}`);
      }
    }
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled", message: "Patch cancelled before writing. No changes were made." };
    const { code, message } = details(error);
    return { kind: "rejected", error: { code, message: `Patch preflight failed. No changes were made. ${message}` } };
  }
  const { planned, initial: live } = batch;
  const data: Receipt = { files: [], warnings: [], remaining: [] };
  let effects = false;
  const changed = () => { effects = true; };
  for (const [index, step] of planned.entries()) {
    const { source, destination, after } = step;
    const name = label(source.input, destination?.input);
    let destinationPublished = false;
    try {
      signal.throwIfAborted();
      const incoming = live.get(source.path)!;
      if (destination) {
        await verify(root, source, incoming, signal);
        const created = await writeText(root, destination, null, after!, incoming!.stat.mode, signal, changed,
          () => { changed(); destinationPublished = true; });
        await removeText(root, source, incoming!, signal);
        live.set(destination.path, created);
        live.set(source.path, null);
      } else if (after === null) {
        await removeText(root, source, incoming!, signal);
        changed();
        live.set(source.path, null);
      } else if (step.before === after) {
        await verify(root, source, incoming, signal);
      } else {
        live.set(source.path, await writeText(root, source, incoming, after, incoming?.stat.mode, signal, changed, changed));
      }
      data.files.push(step.receipt);
      for (const warning of step.warnings) if (data.warnings.length < 32) data.warnings.push(`${quote(source.input, 160)}: ${warning}`);
    } catch (error) {
      data.remaining = planned.slice(index).map(p => label(p.source.input, p.destination?.input));
      const reason = signal.aborted ? "cancelled" : details(error).message;
      const message = `Patch stopped at ${name}: ${reason}${reason.endsWith(".") ? "" : "."}`;
      if (effects) return { kind: "partial", data, message: `${message}${destinationPublished ? " The move destination was written but the source was not removed." : ""} Check the incomplete operation before retrying; filesystem changes are not rolled back.` };
      if (signal.aborted) return { kind: "cancelled", message: `${message} No changes were made.` };
      return { kind: "failed", data, error: { code: details(error).code, message: `${message} No changes were made.` } };
    }
  }
  return { kind: "succeeded", data };
}

export function summarize(data: Receipt): string {
  const rows = data.files.map(file => `${file.status.toUpperCase()} ${label(file.path, file.destination)}`);
  return [...(rows.length ? rows : ["No operations completed."]),
    ...(data.warnings.length ? ["Match warnings:", ...data.warnings.map(warning => `- ${warning}`)] : []),
    ...(data.remaining.length ? ["Incomplete operations:", ...data.remaining.map(path => `- ${path}`)] : []),
  ].join("\n");
}
