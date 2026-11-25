import { createElement as h, useMemo } from "react";
import { FileDiff } from "lucide-react";
import {
  Diff, defineRendererPlugin, StreamingScrollArea, ToolHeader, ToolResourceSubject, ToolScrollArea, toolRenderer, useI18n,
  type FreeformToolRenderProps,
} from "@asterism-app/sdk/renderer";
import { ApplyPatch, messages, type Receipt } from "./contract.ts";
import { diffStats, previewFiles, type FileView } from "./preview.ts";
import styles from "./renderer.module.css";

type Props = FreeformToolRenderProps<Receipt>;

/** Header and body read the same draft; one cached parse serves both on each update. */
let cached: { text: string; files: FileView[] } | undefined;
function intent(text: string | null): FileView[] {
  if (text === null) return [];
  if (cached?.text !== text) cached = { text, files: previewFiles(text) };
  return cached.files;
}
/** Receipts show what was written; until one lists a file, the submitted patch states what was intended. */
function useFiles({ text, result }: Props): { files: FileView[]; actual: boolean } {
  const written = result?.data?.files;
  return useMemo(() => written?.length ? { files: written, actual: true } : { files: intent(text), actual: false }, [written, text]);
}
const fileName = (file: FileView) => file.destination ? `${file.path} \u2192 ${file.destination}` : file.path;

function Header(props: Props) {
  const i18n = useI18n();
  const { files } = useFiles(props);
  const resource = props.invocation.resource;
  const first = files[0];
  const stats = files.reduce((sum, file) => {
    const { added, removed } = diffStats(file.diff);
    return { added: sum.added + added, removed: sum.removed + removed };
  }, { added: 0, removed: 0 });
  return h(ToolHeader, {
    label: i18n.formatMessage(messages["tool.label"]),
    subject: resource && h(ToolResourceSubject, { resource }),
    summary: first && h("span", { className: "type-code" }, files.length > 1
      ? i18n.formatMessage(messages["tool.more"], { path: fileName(first), count: files.length - 1 }) : fileName(first)),
    meta: files.length > 0 && `+${stats.added} −${stats.removed}`,
  });
}

function File({ file, actual }: { file: FileView; actual: boolean }) {
  const i18n = useI18n();
  const note = file.diffOmitted ? messages["file.diffOmitted"] : actual && !file.diff && file.status !== "deleted" ? messages["file.noDiff"] : null;
  return h("section", { className: styles.file },
    h("p", { className: `type-caption ${styles.title}` },
      h("span", { className: styles.status }, i18n.formatMessage(messages[`status.${file.status}`])),
      h("span", { className: `type-code ${styles.path}` }, fileName(file))),
    // Receipt diffs are computed from the actual contents, so their positions are real; patch hunks carry none.
    file.diff && h(Diff, { diff: file.diff, lineNumbers: actual }),
    note && h("p", { className: "type-caption" }, i18n.formatMessage(note)));
}

function Files({ files, actual }: { files: readonly FileView[]; actual: boolean }) {
  return h("div", { className: styles.files }, files.map((file, index) => h(File, { key: index, file, actual })));
}

function Body(props: Props) {
  const i18n = useI18n();
  const { files, actual } = useFiles(props);
  const label = i18n.formatMessage(messages["tool.details"]);
  const data = props.result?.data;
  const content = h(Files, { files, actual });
  return h("div", { className: styles.files },
    // One viewport carries the intent from the first streamed line until written files replace it, so the reader keeps their place.
    files.length > 0 && (actual ? h(ToolScrollArea, { label, children: content })
      : h(StreamingScrollArea, { label, initialScrollPosition: props.phase === "input" ? "end" : "start", children: content })),
    data?.warnings.length ? h(Notes, { title: i18n.formatMessage(messages["result.warnings"]), items: data.warnings }) : null,
    data?.remaining.length ? h(Notes, { title: i18n.formatMessage(messages["result.remaining"]), items: data.remaining }) : null);
}

function Notes({ title, items }: { title: string; items: readonly string[] }) {
  return h("div", { className: "type-caption" },
    h("p", { className: styles.status }, title),
    h("ul", { className: styles.notes }, items.map((item, index) => h("li", { key: index }, item))));
}

const view = { headerRenderer: Header, bodyRenderer: Body };
export default defineRendererPlugin({ modules: [{ resources: [], cards: [], tools: [toolRenderer(ApplyPatch, {
  label: messages["tool.label"],
  icon: h(FileDiff, { size: 14, "aria-hidden": true }),
  input: { ...view, streaming: props => intent(props.text).some(file => file.diff !== null) },
  execution: view,
  result: view,
})] }] });
