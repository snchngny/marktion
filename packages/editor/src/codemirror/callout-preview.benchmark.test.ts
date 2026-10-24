import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as shared from "@markra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calloutPreviewPlugin, liveMarkdown } from "./index.ts";
import "./dom.test-support.ts";

const views: EditorView[] = [];

function documentOfSize(size: number) {
  const prefix = "> [!NOTE]\n> Synthetic callout\n\n";
  const filler = "Regular paragraph content for the benchmark.\n\n";
  return prefix + filler.repeat(Math.ceil((size - prefix.length) / filler.length))
    .slice(0, size - prefix.length);
}

function percentile(values: readonly number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

describe("callout preview benchmark", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
  });

  it.skipIf(process.env.MARKRA_CALLOUT_BENCHMARK !== "1")(
    "measures repeated selection updates on fixed 100 KB and 1 MB documents",
    () => {
      const results: Array<Record<string, number>> = [];
      const parseMarker = vi.spyOn(shared, "parseMarkdownCalloutMarker");

      for (const size of [100 * 1024, 1024 * 1024]) {
        const doc = documentOfSize(size);
        const parent = document.createElement("div");
        document.body.append(parent);
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc,
            extensions: [liveMarkdown({ plugins: [calloutPreviewPlugin()] })],
            selection: EditorSelection.cursor(doc.length),
          }),
        });
        views.push(view);
        view.focus();

        const moveSelection = () => {
          view.dispatch({ selection: EditorSelection.cursor(3) });
          view.dispatch({ selection: EditorSelection.cursor(doc.length) });
        };
        for (let index = 0; index < 5; index += 1) moveSelection();

        parseMarker.mockClear();
        const durations: number[] = [];
        for (let index = 0; index < 20; index += 1) {
          const startedAt = performance.now();
          moveSelection();
          durations.push(performance.now() - startedAt);
        }
        results.push({
          documentBytes: size,
          iterations: durations.length,
          parserCalls: parseMarker.mock.calls.length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        });
      }

      const outputPath = join(tmpdir(), `markra-callout-benchmark-${Date.now()}.json`);
      writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
      console.info(`Callout benchmark results: ${outputPath}`);
      expect(results).toHaveLength(2);
    },
  );

  it.skipIf(process.env.MARKRA_CALLOUT_INPUT_BENCHMARK !== "1")(
    "measures repeated insert-delete pairs on fixed 100 KB and 1 MB documents",
    () => {
      const results: Array<Record<string, number>> = [];
      const parseMarker = vi.spyOn(shared, "parseMarkdownCalloutMarker");

      for (const size of [100 * 1024, 1024 * 1024]) {
        const doc = documentOfSize(size);
        const parent = document.createElement("div");
        document.body.append(parent);
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc,
            extensions: [liveMarkdown({ plugins: [calloutPreviewPlugin()] })],
            selection: EditorSelection.cursor(doc.length),
          }),
        });
        views.push(view);
        view.focus();

        const position = doc.indexOf("Regular paragraph ", Math.floor(size / 2)) +
          "Regular paragraph ".length;
        const editPair = () => {
          view.dispatch({
            changes: { from: position, insert: "x" },
            selection: { anchor: position + 1 },
            userEvent: "input",
          });
          view.dispatch({
            changes: { from: position, to: position + 1, insert: "" },
            selection: { anchor: position },
            userEvent: "delete",
          });
        };
        for (let index = 0; index < 5; index += 1) editPair();

        parseMarker.mockClear();
        const durations: number[] = [];
        for (let index = 0; index < 30; index += 1) {
          const startedAt = performance.now();
          editPair();
          durations.push(performance.now() - startedAt);
        }
        results.push({
          documentBytes: size,
          iterations: durations.length,
          parserCalls: parseMarker.mock.calls.length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        });
      }

      const outputPath = join(tmpdir(), `markra-callout-input-benchmark-${Date.now()}.json`);
      writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
      console.info(`Callout input benchmark results: ${outputPath}`);
      expect(results).toHaveLength(2);
    },
  );
});
