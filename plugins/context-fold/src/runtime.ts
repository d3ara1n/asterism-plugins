import { z } from "zod";
import { Agent, ToolExecution, decodeExecution } from "@asterism-app/builtin-api/contracts";
import { defineAgentContextTransform } from "@asterism-app/builtin-api/runtime";
import { modelInputPartSchema, pluginNamespace } from "@asterism-app/sdk/contracts";
import { defineModule, definePlugin, defineTopLevelTool } from "@asterism-app/sdk/runtime";
import { foldImages, isImage, parseTicket, pluginId, recallId, recallName, ticketPattern } from "./fold.ts";

const recall = defineTopLevelTool({
  id: recallId,
  name: recallName,
  description: "Retrieve saved tool output referenced by a Context Fold marker when the omitted content is needed. Returns the original saved image as this tool's result.",
  guidelines: ["A Context Fold marker appears in place of an image from an earlier tool result and contains the exact ticket to pass to this tool.",
    "The result is the saved image from that call, not a new observation. Other content in the original tool result remains separate.",
    "Tickets refer to earlier tool results on this Agent's current conversation path."],
  argsSchema: z.strictObject({ ticket: z.string().regex(ticketPattern)
    .describe("Copy the complete ticket from the Context Fold marker.") }).describe("The Context Fold ticket to retrieve."),
  resultSchema: z.strictObject({ ticket: z.string(), image: modelInputPartSchema }).describe("The original ticket and the unchanged saved image."),
  effect: "read",
  execution: "parallel",
  async execute({ ticket }, context) {
    const unavailable = { kind: "rejected" as const,
      error: { code: "not_found", message: "This image ticket is unavailable on the Agent's request path." } };
    const agent = context.caller.ref;
    const origin = parseTicket(ticket);
    if (!origin || agent.kind !== Agent.kind) return unavailable;
    const snapshot = context.session.snapshot();
    const scope = { scope: "timeline" as const, source: agent.id };
    // The current tool operation is recorded before execution; its request parent anchors the batch.
    const pending = snapshot.records.index({ ...scope, contracts: [ToolExecution.id] }).filter(record => record.pending);
    if (!pending.length) return unavailable;
    const call = snapshot.records.query(ToolExecution, { ...scope, ids: pending.map(record => record.id) })
      .findLast(entry => entry.status === "known" && entry.data.input.callId === context.callId && entry.data.input.name === recallName);
    const requestParent = call?.status === "known" ? call.data.input.requestParentId : null;
    if (!requestParent) return unavailable;
    const [record] = snapshot.records.all({ ...scope, ids: [origin.recordId] });
    const [parent] = snapshot.records.index({ scope: "timeline", ids: [requestParent] });
    if (!record || !parent || record.sequence > parent.sequence) return unavailable;
    const execution = decodeExecution(record);
    const block = execution?.status === "known" ? execution.data.block : null;
    const image = block?.kind === "toolcall" ? block.outcome?.model[origin.part] : undefined;
    if (!isImage(image)) return unavailable;
    return { kind: "succeeded", data: { ticket: origin.recordId + ":" + origin.part, image } };
  },
  toModel: ({ image }) => [image],
});

export default definePlugin({
  namespace: pluginNamespace(pluginId),
  modules: [defineAgentContextTransform({ id: "fold", transform: foldImages }), defineModule(() => ({ topLevelTools: [recall] }))],
});
