import assert from "node:assert/strict";
import { test } from "node:test";
import { diffStats, previewFiles } from "./preview.ts";

// The diff view rejects a hunk whose header counts disagree with its rows, so every synthesized header must match.
test("preview hunks carry counts that match their rows and keep each file separate", () => {
  const files = previewFiles([
    "*** Begin Patch",
    "*** Update File: a.ts",
    "*** Move to: b.ts",
    "@@ function f",
    " keep",
    "-old",
    "+new",
    "+more",
    "@@",
    "-gone",
    "*** End of File",
    "*** Add File: c.md",
    "+x",
    "*** Delete File: d",
    "*** End Patch",
  ].join("\n"));
  assert.deepEqual(files, [
    { status: "moved", path: "a.ts", destination: "b.ts", diff: "--- a.ts\n+++ b.ts\n@@ -1,2 +1,3 @@ function f\n keep\n-old\n+new\n+more\n@@ -4,1 +4,0 @@\n-gone\n" },
    { status: "added", path: "c.md", diff: "--- /dev/null\n+++ c.md\n@@ -0,0 +1,1 @@\n+x\n" },
    { status: "deleted", path: "d", diff: null },
  ]);
});

test("a patch cut off mid-stream previews the rows received so far", () => {
  const files = previewFiles("*** Begin Patch\r\n*** Update File: a\r\n@@\r\n-x\r\n+y");
  assert.deepEqual(files, [{ status: "updated", path: "a", diff: "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-x\n+y\n" }]);
  assert.deepEqual(previewFiles("*** Begin Patch\n*** Update File: a\n@@"), [{ status: "updated", path: "a", diff: null }]);
});

test("diff stats count body rows, not the file headers", () => {
  assert.deepEqual(diffStats("Index: a\n===\n--- a\n+++ a\n@@ -1,2 +1,2 @@\n--- x\n+++ y\n same\n"), { added: 1, removed: 1 });
});
