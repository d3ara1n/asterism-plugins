import { z } from "zod";
import { builtin } from "@asterism-app/builtin-api/contracts";
import { defineImplementation, defineTool, pluginNamespace } from "@asterism-app/sdk/contracts";

export const namespace = pluginNamespace("asterism.apply-patch");
const message = (id: string, defaultMessage: string) => ({ id, defaultMessage });
export const messages = namespace.messages("en", {
  "tool.label": message("tool.label", "Apply Patch"),
  "tool.details": message("tool.details", "File changes"),
  "tool.more": message("tool.more", "{path} and {count} more"),
  "status.added": message("status.added", "Added"),
  "status.updated": message("status.updated", "Updated"),
  "status.deleted": message("status.deleted", "Deleted"),
  "status.moved": message("status.moved", "Moved"),
  "status.unchanged": message("status.unchanged", "Unchanged"),
  "file.diffOmitted": message("file.diffOmitted", "Diff omitted: size or time limit."),
  "file.noDiff": message("file.noDiff", "No content changes."),
  "result.warnings": message("result.warnings", "Match warnings"),
  "result.remaining": message("result.remaining", "Not applied"),
});
// Match Directory's public resource kind and persisted shape without importing host internals.
const Directory = builtin.resource("directory", z.object({ path: z.string() }));
export const ApplyPatch = defineImplementation({
  ...namespace.data("directory.apply-patch", z.strictObject({
    files: z.array(z.strictObject({
      path: z.string(), destination: z.string().optional(),
      status: z.enum(["added", "updated", "deleted", "moved", "unchanged"]),
      diff: z.string().nullable(), diffOmitted: z.boolean(),
    })),
    warnings: z.array(z.string()),
    remaining: z.array(z.string()),
  }).describe("The completed operations in patch order, bounded diffs of the actual changes, matching warnings and incomplete operations.")),
  resource: Directory,
  tool: defineTool({
    id: namespace.name("apply-patch"), name: "apply_patch", kind: "freeform",
    description: "Apply a Codex-format text patch to this linked Directory. Add, update, delete or move files in one call. Validates the entire patch before writing.",
    guidelines: [
      "Send raw text from *** Begin Patch to *** End Patch, without Markdown fences or unified-diff headers. Use unquoted paths relative to this Directory.",
      "Add: use *** Add File: path, then prefix every content line with + (even blank lines). Delete: use *** Delete File: path with no body. Add and Move do not overwrite existing targets.",
      "Update: use *** Update File: path and one or more hunks starting with @@ or @@ <literal existing line>. Mark unchanged context with a space, removals with -, and additions with +, before the original indentation.",
      "Read before editing. Copy literal lines, include enough context to match once, and write hunks in file order without overlapping context. A locator starts the search after its line. Use *** End of File after a hunk to anchor it to EOF. A hunk with only additions appends.",
      "Move: put *** Move to: destination immediately after an Update header. To move without content changes, include a context-only hunk.",
      "Example:\n*** Begin Patch\n*** Update File: greeting.txt\n@@\n-Hello\n+Hello there\n*** End Patch",
      "If preflight rejects the patch, no changes were made. If writing stops partway through, inspect the reported files before retrying; completed operations are not rolled back.",
    ],
  }),
  effect: "write", execution: "sequential",
});
export type Receipt = z.infer<typeof ApplyPatch.schema>;
