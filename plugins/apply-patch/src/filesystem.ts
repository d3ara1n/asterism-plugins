import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { PatchError, quote } from "./syntax.ts";

export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
export interface Root { requested: string; path: string; identity: Stats }
export interface Snapshot { text: string; stat: Stats }

function missing(e: unknown): boolean { return (e as NodeJS.ErrnoException)?.code === "ENOENT"; }
const statIfPresent = (path: string) => lstat(path).catch(e => { if (!missing(e)) throw e; return null; });
function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
export function sameEntry(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

export async function openRoot(requested: string): Promise<Root> {
  const path = await realpath(requested);
  const identity = await lstat(path);
  if (!identity.isDirectory()) throw new PatchError("not_directory", "The linked Directory is not a directory.");
  return { requested, path, identity };
}

/** Resolve directory aliases within the root; never operate on a file symlink as if it were a regular file. */
export async function targetPath(root: Root, input: string): Promise<string> {
  if (!input || input.length > 4096 || /[\p{Cc}\uD800-\uDFFF]/u.test(input) || /[\\/]$/u.test(input)) {
    throw new PatchError("invalid_path", `Expected a relative file path, got ${quote(input)}.`);
  }
  if (isAbsolute(input) || win32.isAbsolute(input) || /^[A-Z]:/iu.test(input) || input.startsWith("~/")) {
    throw new PatchError("absolute_path", "Use a path relative to the linked Directory, without a drive letter or '~/'.");
  }
  if (process.platform === "win32" && input.split(/[\\/]/u).some(part => /[:<>"|?*]/u.test(part)
    || (part !== "." && part !== ".." && /[. ]$/u.test(part)) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new PatchError("invalid_path", "The patch contains a reserved Windows path component.");
  }
  const resolved = resolve(root.path, input);
  if (!inside(root.path, resolved) || resolved === root.path) throw new PatchError("outside_resource", "Patch paths must resolve to files inside the linked Directory.");
  const parts = relative(root.path, resolved).split(sep);
  let parent = root.path;
  for (const [index, part] of parts.entries()) {
    const candidate = join(parent, part);
    const info = await statIfPresent(candidate);
    if (!info) return join(candidate, ...parts.slice(index + 1));
    if (index === parts.length - 1) {
      if (!info.isFile()) throw new PatchError("not_file", "Patch targets must be regular text files, not directories, symlinks or special files.");
      const canonical = await realpath(candidate);
      if (!inside(root.path, canonical)) throw new PatchError("outside_resource", "The file resolves outside the linked Directory.");
      return canonical;
    }
    if (info.isDirectory()) { parent = candidate; continue; }
    if (!info.isSymbolicLink()) throw new PatchError("not_directory", "A parent path is not a directory.");
    try { parent = await realpath(candidate); }
    catch (e) {
      if (!missing(e)) throw e;
      throw new PatchError("broken_symlink", "A parent directory is a broken symbolic link.");
    }
    if (!inside(root.path, parent)) throw new PatchError("outside_resource", "A symbolic link resolves outside the linked Directory.");
    if (!(await lstat(parent)).isDirectory()) throw new PatchError("not_directory", "A parent symlink does not resolve to a directory.");
  }
  throw new PatchError("invalid_path", "No file path was selected.");
}

function fromBytes(bytes: Buffer): string {
  if (!isUtf8(bytes) || bytes.subarray(0, 5).toString("ascii") === "%PDF-" || bytes.some(byte => byte < 9 || (byte > 13 && byte < 32))) {
    throw new PatchError("unsupported_text", "Expected a UTF-8 text file; binary content is not supported.");
  }
  return bytes.toString("utf8");
}
function checkSize(size: number) {
  if (size > MAX_TEXT_BYTES) throw new PatchError("file_too_large", "Patch file operations are limited to 8 MiB per file.");
}
export function validateText(text: string): number {
  const size = Buffer.byteLength(text);
  checkSize(size);
  if (fromBytes(Buffer.from(text)) !== text) throw new PatchError("unsupported_text", "Patch text contains an unpaired Unicode surrogate.");
  return size;
}
function stale(): never { throw new PatchError("file_changed", "The file or its path changed after validation. Re-read it before retrying."); }
export async function readSnapshot(path: string, signal: AbortSignal): Promise<Snapshot | null> {
  signal.throwIfAborted();
  const seen = await statIfPresent(path);
  if (!seen) return null;
  if (!seen.isFile()) throw new PatchError("not_file", "Patch targets must be regular text files.");
  checkSize(seen.size);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !sameEntry(stat, seen)) stale();
    checkSize(stat.size);
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    if (total !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) stale();
    return { text: fromBytes(bytes.subarray(0, total)), stat: after };
  } finally { await file.close(); }
}

export interface Target { input: string; path: string }
export async function verify(root: Root, target: Target, expected: Snapshot | null, signal: AbortSignal): Promise<void> {
  if (await realpath(root.requested) !== root.path || !sameEntry(root.identity, await lstat(root.path))) stale();
  if (relative(await targetPath(root, target.input), target.path)) stale();
  const now = await readSnapshot(target.path, signal);
  if (!expected && !now) return;
  if (!expected || !now || !sameEntry(expected.stat, now.stat) || expected.stat.mode !== now.stat.mode
    || expected.text !== now.text) stale();
}

export async function writeText(root: Root, target: Target, expected: Snapshot | null, text: string, mode: number | undefined,
  signal: AbortSignal, createdDirectory: () => void, committed: () => void): Promise<Snapshot> {
  await verify(root, target, expected, signal);
  const parent = dirname(target.path);
  signal.throwIfAborted();
  const made = await mkdir(parent, { recursive: true });
  if (made !== undefined) createdDirectory();
  await verify(root, target, expected, signal);
  const temp = join(parent, `.apply-patch-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", mode === undefined ? 0o666 : 0o600);
  try {
    let stat: Stats;
    try {
      await file.writeFile(text, { signal });
      if (mode !== undefined) await file.chmod(mode & 0o777);
      await file.sync();
      stat = await file.stat();
    } finally { await file.close(); }
    await verify(root, target, expected, signal);
    signal.throwIfAborted();
    // link publishes a new file without replacing a destination created by another writer.
    if (expected) await rename(temp, target.path);
    else await link(temp, target.path);
    committed();
    return { text, stat };
  } finally { await unlink(temp).catch(e => { if (!missing(e)) throw e; }); }
}

export async function removeText(root: Root, target: Target, expected: Snapshot, signal: AbortSignal): Promise<void> {
  await verify(root, target, expected, signal);
  signal.throwIfAborted();
  await unlink(target.path);
}
