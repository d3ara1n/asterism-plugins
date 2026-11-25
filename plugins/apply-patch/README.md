# Apply Patch

Apply Codex-format text patches to a linked Asterism Directory. This plugin exercises the SDK's **freeform resource tools**, including Directory selection, sequential write scheduling, and a tool view built only from the SDK renderer's shared controls. The view previews each file's hunks while the patch streams and replays the committed diffs from history. The patch parser and matcher are an independent implementation of the Codex patch format; pi-apply-patch is a behavioral reference, not a runtime dependency.

## Try it locally

Build the plugin as described in the [workspace README](../../README.md), add the `plugins/apply-patch` package directory in Asterism's plugin settings, and restart. Link a scratch Directory to an Agent. Inspect the Directory and confirm that `apply_patch` is listed as a freeform write tool. Run `resource_call_text` with the following input, replacing `<directory_id>` with the linked Directory's ID:

```text
<directory_id> apply_patch
*** Begin Patch
*** Add File: greeting.txt
+Hello
*** Update File: greeting.txt
@@
-Hello
+Hello there
*** End Patch
```

The Agent should see an `ADDED` and an `UPDATED` receipt in that order. While the model writes a patch, the tool body lists each file with its hunks and follows the end of the draft; the hunks have no line numbers because a patch carries no file positions. The settled body lists the same files with the diffs actually written, with line numbers, and the header shows the first path and the total `+added −removed`. A rejected patch keeps its intended hunks below the failure block. `greeting.txt` should contain `Hello there` followed by a newline. Re-run the same patch: it should reject the occupied Add target without changing `greeting.txt`.

## Patch contract

- Send raw text between `*** Begin Patch` and `*** End Patch`. Use `*** Add File: path`, `*** Delete File: path`, or `*** Update File: path`. An Update can put `*** Move to: destination` immediately after its header. Paths are unquoted and relative to the linked Directory.
- Add prefixes every content line with `+`; Delete has no body. An Update contains one or more nonempty hunks beginning with `@@` or `@@ <literal existing line>`. Prefix each hunk line with a space, `-`, or `+` before its original indentation. A context-only hunk can move a file without altering its contents.
- Hunks search forward and match the file as it existed at the start of that Update block. A locator starts the search after the matching line. `*** End of File` anchors a hunk to the end. A hunk containing only additions appends. File operations themselves run in patch order, so later blocks can use changes from earlier blocks.
- Matching prefers exact text, then trailing-whitespace differences, then edge whitespace, then selected typographic punctuation and spaces. Non-exact matches are reported. A hunk with multiple matches in the winning pass is rejected rather than editing the first occurrence; add context, a locator, or an EOF marker to disambiguate. Existing BOMs, unchanged lines, and line endings are retained; a replacement of the final line without a newline retains that absence.
- The plugin accepts LF and CRLF patch text. Markdown fences, unified-diff line numbers, and missing operation prefixes are errors, not repairs. There is no provider-specific grammar constraint.

## Write behavior

Preflight validates the whole patch before any filesystem changes. Add and Move do not replace existing destinations; Move to the same file is an error. New parent directories can be created, but converting a path between a file and a directory in one patch is unsupported. Paths must stay within the linked Directory even after resolving symlinks. File symlinks and non-regular files are rejected. The tool operates on UTF-8 text, up to 8 MiB per file, with bounded patch, matching, and diff work.

Each write rechecks the path and expected contents before committing. Existing files are replaced from a staging file; newly created files are published without overwriting competing destinations. These checks are not an OS sandbox or a guarantee against concurrent filesystem changes. A write or cancellation after changes begin can leave partial effects. The result says where execution stopped and lists incomplete operations; it does not roll back completed writes. Read the affected files before retrying a partial patch.
