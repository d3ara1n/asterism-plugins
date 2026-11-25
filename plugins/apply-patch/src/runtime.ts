import { defineModule, definePlugin, implementTool } from "@asterism-app/sdk/runtime";
import { applyPatch, summarize } from "./apply.ts";
import { ApplyPatch, namespace } from "./contract.ts";

const tool = implementTool(ApplyPatch, {
  call: (directory, text, { signal }) => applyPatch(directory.path, text, signal),
  toModel: summarize,
});

export default definePlugin({ namespace, modules: [defineModule(() => ({ tools: [tool] }))] });
