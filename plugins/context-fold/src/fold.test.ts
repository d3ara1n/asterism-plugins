import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextUnit } from "@asterism-app/builtin-api/runtime";
import type { ModelItem } from "@asterism-app/sdk/contracts";
import { foldImages, parseTicket, recallId, recallName } from "./fold.ts";

const picture = { kind: "file", mediaType: "image/png", file: { "$asterism.content": "550e8400-e29b-41d4-a716-446655440000" } } as const;
const source: Extract<ModelItem, { kind: "result" }> = {
  kind: "result", callId: "call", name: "see", outcome: { kind: "succeeded", data: null, model: [
    { kind: "text", text: "The original caption" }, picture, { ...picture, mediaType: "application/pdf" },
  ] },
};
const request = { sessionId: "session", agentId: "agent", turn: 3 };
const unit = (turn: number, result = source): AgentContextUnit => ({ turn, items: [{ item: result, origin: { recordId: "shot", parts: [0, 4, 2] } }] });
function parts(unit: AgentContextUnit) {
  const item = unit.items[0]!.item;
  if (item.kind !== "result") throw new Error("Expected tool result");
  return item.outcome.model;
}

test("folding uses original part identity after a preceding transform moves the image", () => {
  const [older, current] = foldImages([unit(1), unit(3)], request);
  const [caption, marker, pdf] = parts(older!);
  assert.deepEqual(caption, source.outcome.model[0]);
  assert.match(marker?.kind === "text" ? marker.text : "", /"ticket":"shot:4"/);
  assert.equal(older?.items[0]?.origin?.parts[1], null);
  assert.deepEqual(pdf, source.outcome.model[2]);
  assert.deepEqual(parts(current!), source.outcome.model);
});

test("a folded recall result keeps its canonical ticket and synthetic images get no ticket", () => {
  const recall = { ...source, name: recallName, outcome: { ...source.outcome, model: [picture], implementation: { id: recallId }, data: { ticket: "shot:4" } } };
  const entry = { item: recall, origin: { recordId: "later", parts: [0] } };
  const output = foldImages([{ turn: 1, items: [entry] }, { turn: 1, items: [{ item: recall }] }], request);
  const marker = parts(output[0]!)[0];
  assert.match(marker?.kind === "text" ? marker.text : "", /"ticket":"shot:4"/);
  assert.deepEqual(parts(output[1]!), [picture]);
  assert.equal(parseTicket("bad:9007199254740993"), null);
});
