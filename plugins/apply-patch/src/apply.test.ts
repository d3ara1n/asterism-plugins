import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test, type TestContext } from "node:test";
import { applyPatch, summarize } from "./apply.ts";
import { openRoot, readSnapshot, writeText } from "./filesystem.ts";
import { parsePatch } from "./syntax.ts";
import { updateText } from "./update.ts";

const signal = () => new AbortController().signal;
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
async function sandbox(t: TestContext) {
  const base = await mkdtemp(resolve(".apply-patch-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(root);
  return { base, root };
}
function edit(text: string, ...lines: string[]) {
  const [op] = parsePatch(patch("*** Update File: a", ...lines));
  assert(op?.kind === "update");
  return updateText(text, op.hunks);
}

test("CRLF input retains literal patch prefixes and payload boundaries", () => {
  const input = patch("*** Add File: a b", "+", "+*** End Patch", "+word  ", "*** Delete File: gone");
  assert.deepEqual(parsePatch(`${input.replaceAll("\n", "\r\n")}\r\n`), [
    { kind: "add", line: 2, path: "a b", text: "\n*** End Patch\nword  \n" },
    { kind: "delete", line: 6, path: "gone" },
  ]);
  assert.throws(() => parsePatch(patch("*** Add File: a", "missing prefix")), /line 3.*must begin/);
  assert.throws(() => edit("a\n", "@@ -1 +1 @@", "-a", "+b"), /unified-diff/);
});

test("exact context outranks earlier loose matches; loose context preserves the original bytes", () => {
  const original = "\uFEFFfirst\r\n  keep \r\nnew\nkeep\nnew\r\n";
  assert.deepEqual(edit(original, "@@", " keep", "-new", "+updated"), {
    text: "\uFEFFfirst\r\n  keep \r\nnew\nkeep\nupdated\r\n", warnings: [],
  });
  const result = edit(original, "@@ \uFEFFfirst", "    keep", "-new", "+changed", " keep");
  assert.equal(result.text, "\uFEFFfirst\r\n  keep \r\nchanged\nkeep\nnew\r\n");
  assert.match(result.warnings[0]!, /leading\/trailing whitespace/);
  assert.equal(edit("\uFEFFx\n\uFEFFy\n", "@@", "-\uFEFFy", "+z").text, "\uFEFFx\nz\n");
});

test("ambiguous hunks are rejected; locators and EOF can disambiguate", () => {
  assert.throws(() => edit("x\nmarker\nx", "@@", "-x", "+y"), /file lines 1 and 3/);
  assert.equal(edit("x\nmarker\nx", "@@ marker", "-x", "+y").text, "x\nmarker\ny");
  assert.equal(edit("x\nx", "@@", "-x", "+y", "*** End of File").text, "x\ny");
  assert.equal(edit("x\r\nmarker\r\nx", "@@ marker", "+y").text, "x\r\nmarker\r\nx\r\ny\r\n");
  assert.throws(() => edit("x\nmarker\n", "@@ marker", "-x", "+y"), /before the search began/);
});

test("files are applied in order; receipt represents persisted changes without showing diffs to the model", async t => {
  const { root } = await sandbox(t);
  await writeFile(join(root, "obsolete"), "delete me\n");
  const result = await applyPatch(root, patch(
    "*** Add File: new/a", "+old",
    "*** Update File: new/a", "@@", "-old", "+new",
    "*** Update File: new/a", "*** Move to: dir/b", "@@", " new",
    "*** Delete File: obsolete",
  ), signal());
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(result.data.files.map(file => file.status), ["added", "updated", "moved", "deleted"]);
  assert.match(result.data.files[1]!.diff!, /-old\n\+new/);
  assert.doesNotMatch(summarize(result.data), /-old|\+new/);
  assert.equal(await readFile(join(root, "dir/b"), "utf8"), "new\n");
  await assert.rejects(lstat(join(root, "new/a")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "obsolete")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(root, "dir")), ["b"]);
});

test("a later invalid operation leaves files and directories untouched", async t => {
  const { root } = await sandbox(t);
  await writeFile(join(root, "a"), "old\n");
  const prefix = ["*** Add File: untouched/new", "+file"];
  const move = ["*** Update File: a", "*** Move to: ./a", "@@", " old"];
  for (const [code, lines] of [
    ["context_not_found", ["*** Update File: a", "@@", "-no", "+yes"]],
    ["same_file", move],
    ["already_exists", ["*** Add File: a", "+clobber"]],
    ["path_conflict", ["*** Add File: other", "+file", "*** Add File: other/child", "+file"]],
    ["outside_resource", ["*** Add File: ../escape", "+file"]],
  ] as const) {
    const result = await applyPatch(root, patch(...prefix, ...lines), signal());
    assert.equal(result.kind, "rejected");
    assert.equal(result.error.code, code);
    assert.match(result.error.message, /No changes were made/);
    assert.deepEqual(await readdir(root), ["a"]);
    assert.equal(await readFile(join(root, "a"), "utf8"), "old\n");
  }
});

test("rejects outside directory symlinks and leaf aliases, but resolves in-root directory aliases", { skip: process.platform === "win32" }, async t => {
  const { base, root } = await sandbox(t);
  await mkdir(join(root, "real"));
  await symlink("real", join(root, "alias"), "dir");
  await symlink(base, join(root, "outside"), "dir");
  await writeFile(join(root, "real/a"), "old\n");
  await symlink("real/a", join(root, "leaf"));
  assert.equal((await applyPatch(root, patch("*** Add File: outside/no", "+x"), signal())).kind, "rejected");
  assert.equal((await applyPatch(root, patch("*** Delete File: leaf"), signal())).kind, "rejected");
  const same = await applyPatch(root, patch("*** Update File: alias/a", "*** Move to: real/a", "@@", " old"), signal());
  assert.equal(same.kind, "rejected");
  assert.equal(same.error.code, "same_file");
  assert.equal((await applyPatch(root, patch("*** Update File: alias/a", "@@", "-old", "+changed"), signal())).kind, "succeeded");
  assert.equal(await readFile(join(root, "real/a"), "utf8"), "changed\n");
});

test("commit rechecks the expected file and never replaces a newly occupied add target", async t => {
  const { root } = await sandbox(t);
  const directory = await openRoot(root);
  const path = join(directory.path, "a");
  await writeFile(path, "before\n");
  const before = await readSnapshot(path, signal());
  await writeFile(path, "external edit\n");
  for (const expected of [null, before]) {
    await assert.rejects(writeText(directory, { input: "a", path }, expected, "patch\n", undefined,
      signal(), assert.fail, assert.fail), { code: "file_changed" });
  }
  assert.equal(await readFile(path, "utf8"), "external edit\n");
  const aborted = AbortSignal.abort();
  assert.equal((await applyPatch(root, patch("*** Delete File: a"), aborted)).kind, "cancelled");
  assert.deepEqual(await readdir(root), ["a"]);
});
