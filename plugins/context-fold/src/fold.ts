import type { AgentContextRequest, AgentContextUnit } from "@asterism-app/builtin-api/runtime";
import type { ModelFilePart, ModelInputPart } from "@asterism-app/sdk/contracts";

export const pluginId = "asterism.context-fold";
export const recallId = pluginId + "/recall";
export const recallName = "context_fold_recall";
export const ticketPattern = /^([A-Za-z0-9_-]+):([0-9]+)$/u;

export function parseTicket(ticket: string) {
  const match = ticketPattern.exec(ticket);
  if (!match) return null;
  const part = Number(match[2]);
  return Number.isSafeInteger(part) ? { recordId: match[1]!, part } : null;
}

export function isImage(part: ModelInputPart | undefined): part is ModelFilePart {
  return part?.kind === "file" && part.mediaType.startsWith("image/");
}

export function foldImages(projection: readonly AgentContextUnit[], request: AgentContextRequest): readonly AgentContextUnit[] {
  return projection.map(unit => {
    if (unit.turn >= request.turn) return unit;
    return { ...unit, items: unit.items.map(entry => {
      const { item, origin } = entry;
      if (item.kind !== "result" || !origin) return entry;
      const data = item.outcome.data;
      const ticket = item.outcome.implementation?.id === recallId && data && typeof data === "object" && !Array.isArray(data)
        ? data.ticket : null;
      const canonical = typeof ticket === "string" ? parseTicket(ticket) : null;
      const parts = [...origin.parts];
      const model = item.outcome.model.map((part, index): ModelInputPart => {
        const originalIndex = parts[index];
        if (originalIndex == null || !isImage(part)) return part;
        parts[index] = null;
        const address = canonical ? canonical.recordId + ":" + canonical.part : origin.recordId + ":" + originalIndex;
        const label = part.filename ? " " + JSON.stringify(part.filename) : "";
        return { kind: "text", text: "[Context Fold: image" + label + " from " + item.name + " is folded. To view the saved image, call "
          + recallName + " with " + JSON.stringify({ ticket: address }) + ".]" };
      });
      return { item: { ...item, outcome: { ...item.outcome, model } }, origin: { ...origin, parts } };
    }) };
  });
}
