import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeMirrorBlockDragPlugin,
  moveCodeMirrorBlock,
  moveCodeMirrorBlocks,
  readCodeMirrorBlockRanges,
  resolveCodeMirrorBlockSelection,
} from "./block-drag.ts";
import { horizontalRulePlugin } from "./horizontal-rule.ts";
import { getMarkraSlashMenuState, liveMarkdown } from "./index.ts";
import "./dom.test-support.ts";

const views: EditorView[] = [];

function createView(
  doc: string,
  readOnly = false,
  extensions: readonly Extension[] = [],
) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        liveMarkdown({
          plugins: [codeMirrorBlockDragPlugin(), horizontalRulePlugin()],
          slashMenu: true,
        }),
        EditorState.readOnly.of(readOnly),
        ...extensions,
      ],
      selection: EditorSelection.cursor(doc.length),
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("codeMirrorBlockDragPlugin", () => {
  it("resolves a partial multi-block text selection to whole blocks in either direction", () => {
    const doc = "First paragraph\ncontinued\n\nSecond\n\nThird";
    const view = createView(doc);
    const start = doc.indexOf("paragraph") + 2;
    const end = doc.indexOf("Second") + 3;
    view.dispatch({ selection: EditorSelection.range(start, end) });

    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) =>
      view.state.sliceDoc(block.from, block.to))).toEqual([
      "First paragraph\ncontinued",
      "Second",
    ]);
    view.dispatch({ selection: EditorSelection.range(end, start) });
    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) =>
      view.state.sliceDoc(block.from, block.to))).toEqual([
      "First paragraph\ncontinued",
      "Second",
    ]);
  });

  it("keeps selection ends exclusive, rejects whitespace-only ranges, and prefers nested children", () => {
    const view = createView("- Parent\n  - Child\n\nTail");
    const parent = readCodeMirrorBlockRanges(view.state).find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("- Parent")
    );
    const child = readCodeMirrorBlockRanges(view.state).find((block) =>
      view.state.sliceDoc(block.from, block.to).includes("Child")
    );
    expect(parent && child).toBeTruthy();
    view.dispatch({ selection: EditorSelection.range(parent!.from, parent!.to) });
    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) => block.from)).toEqual([parent!.from]);
    view.dispatch({ selection: EditorSelection.range(child!.from + 4, child!.to - 1) });
    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) => block.from)).toEqual([child!.from]);

    const exclusive = createView("First\n\nSecond");
    exclusive.dispatch({ selection: EditorSelection.range(0, 7) });
    expect(resolveCodeMirrorBlockSelection(exclusive.state)?.map((block) =>
      exclusive.state.sliceDoc(block.from, block.to))).toEqual(["First"]);

    const blankDoc = "First\n \t\nSecond";
    const blank = createView(blankDoc);
    blank.dispatch({ selection: EditorSelection.range(6, 8) });
    expect(resolveCodeMirrorBlockSelection(blank.state)).toEqual([]);
  });

  it("does not create movable empty-line ranges inside fenced code", () => {
    const view = createView("```txt\nFirst\n\nSecond\n```\n\nTail");
    expect(readCodeMirrorBlockRanges(view.state).filter((block) => block.name === "EmptyLine")).toEqual([]);
  });

  it("cancels a pointer drop released outside the editor and its handle gutter", () => {
    const doc = "First\n\nSecond\n\nThird";
    const view = createView(doc);
    Object.defineProperty(view.dom, "getBoundingClientRect", {
      value: () => new DOMRect(80, 50, 300, 200),
    });
    const handle = view.dom.querySelector<HTMLElement>(".markra-block-drag-handle")!;
    handle.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, pointerId: 12, clientX: 55, clientY: 70,
    }));
    document.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, pointerId: 12, clientX: 410, clientY: 130,
    }));
    expect(view.dom.querySelector(".markra-block-drop-indicator")?.getAttribute("data-show")).toBe("false");
    document.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, pointerId: 12, clientX: 410, clientY: 130,
    }));
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.dom.querySelector(".markra-block-drop-indicator")).toBeNull();
  });

  it("expands either selected edge to the entire parent list item", () => {
    const doc = "- Parent\n  - Child\n  - Sibling\n\nTail";
    const view = createView(doc);
    const parent = readCodeMirrorBlockRanges(view.state).find((block) => block.depth === 0)!;
    view.dispatch({ selection: EditorSelection.range(3, doc.indexOf("Child") + 2) });
    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) => block.from)).toEqual([parent.from]);
    view.dispatch({ selection: EditorSelection.range(doc.indexOf("Child") + 2, 3) });
    expect(resolveCodeMirrorBlockSelection(view.state)?.map((block) => block.from)).toEqual([parent.from]);
  });

  it("moves a multi-block paragraph group as one edit and preserves extra blank lines", () => {
    const doc = "First\n\nSecond\n\nThird\n\n\n\nFourth";
    const view = createView(doc);
    const blocks = readCodeMirrorBlockRanges(view.state);
    const first = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "First");
    const second = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Second");
    const third = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Third");

    expect(first && second && third && moveCodeMirrorBlocks(
      view,
      [first.from, second.from],
      third.from,
      "after",
    )).toBe(true);
    expect(view.state.doc.toString()).toBe("Third\n\nFirst\n\nSecond\n\n\n\nFourth");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("First\n\nSecond");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("moves a raw group containing different top-level block types", () => {
    const view = createView("# Heading\n\nParagraph\n\nTail");
    const blocks = readCodeMirrorBlockRanges(view.state);
    const heading = blocks.find((block) => block.name === "ATXHeading1");
    const paragraph = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Paragraph");
    const tail = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Tail");

    expect(heading && paragraph && tail && moveCodeMirrorBlocks(
      view,
      [heading.from, paragraph.from],
      tail.from,
      "after",
    )).toBe(true);
    expect(view.state.doc.toString()).toBe("Tail\n\n# Heading\n\nParagraph");
  });

  it("keeps a following paragraph separate when moving the last nested list child", () => {
    const view = createView("- Parent\n  - First\n  - Last\n\nAfter");
    const blocks = readCodeMirrorBlockRanges(view.state);
    const last = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "  - Last");
    const after = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "After");

    expect(last && after && moveCodeMirrorBlock(view, last.from, after.from, "before")).toBe(true);
    expect(readCodeMirrorBlockRanges(view.state).some((block) =>
      block.name === "Paragraph" && view.state.sliceDoc(block.from, block.to) === "After"
    )).toBe(true);
  });

  it.each(["- Parent\n  - Child", "- Parent\n- Child"])("keeps the vacated list boundary when moving a last item beyond another paragraph: %s", (list) => {
    const doc = `${list}\n\nAfter\n\nLast`;
    const view = createView(doc);
    const blocks = readCodeMirrorBlockRanges(view.state);
    const child = blocks.find((block) => view.state.sliceDoc(block.from, block.to).trim() === "- Child");
    const last = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Last");
    expect(child && last && moveCodeMirrorBlock(view, child.from, last.from, "after")).toBe(true);
    expect(readCodeMirrorBlockRanges(view.state).filter((block) => block.name === "Paragraph").map((block) =>
      view.state.sliceDoc(block.from, block.to))).toEqual(["After", "Last"]);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps typing before and after a drag move in separate undo events", () => {
    const doc = "First\n\nSecond\n\nThird";
    const view = createView(doc);
    view.dispatch({ changes: { from: 5, insert: "!" }, userEvent: "input.type" });
    const blocks = readCodeMirrorBlockRanges(view.state);
    expect(moveCodeMirrorBlock(view, blocks[0]!.from, blocks[2]!.from, "after")).toBe(true);
    const moved = view.state.doc.toString();
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: "?" }, userEvent: "input.type" });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(moved);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First!\n\nSecond\n\nThird");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps a selected list group with its nested children when reordering", () => {
    const view = createView("- First\n  - Child A\n- Second\n- Third\n  - Child B");
    const blocks = readCodeMirrorBlockRanges(view.state);
    const first = blocks.find((block) => view.state.sliceDoc(block.from, block.to).startsWith("- First"));
    const second = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "- Second");
    const third = blocks.find((block) => view.state.sliceDoc(block.from, block.to).startsWith("- Third"));

    expect(first && second && third && moveCodeMirrorBlocks(
      view,
      [first.from, second.from],
      third.from,
      "after",
      0,
    )).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Third\n  - Child B\n- First\n  - Child A\n- Second",
    );
  });

  it("uses the target row midpoint even when the pointer is over its toolbar", () => {
    for (const testCase of [
      { y: 100, side: "before", indicator: "100px" },
      { y: 109, side: "before", indicator: "100px" },
      { y: 110, side: "after", indicator: "120px" },
      { y: 111, side: "after", indicator: "120px" },
      { y: 120, side: "after", indicator: "120px" },
    ] as const) {
      const view = createView("First\n\nSecond\n\nThird\n\nFourth");
      const blocks = readCodeMirrorBlockRanges(view.state);
      const first = blocks[0];
      const third = blocks[2];
      const handle = view.dom.querySelector<HTMLElement>(
        `[data-block-from="${first?.from}"] .markra-block-drag-handle`,
      );
      const target = view.dom.querySelector<HTMLElement>(
        `.cm-line[data-markra-block-from="${third?.from}"]`,
      );
      const toolbar = target?.querySelector<HTMLElement>(".markra-block-toolbar");
      const rowRect = { top: 100, bottom: 120, height: 20, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) };
      const toolbarRect = { ...rowRect, top: 100, bottom: 102, height: 2 };
      if (target) Object.defineProperty(target, "getBoundingClientRect", { value: () => rowRect });
      if (toolbar) Object.defineProperty(toolbar, "getBoundingClientRect", { value: () => toolbarRect });
      const values = new Map<string, string>();
      const dataTransfer = {
        dropEffect: "none",
        effectAllowed: "none",
        getData: (type: string) => values.get(type) ?? "",
        setData: (type: string, value: string) => values.set(type, value),
      };
      const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
      const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: testCase.y });
      Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
      const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: testCase.y });
      Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });

      handle?.dispatchEvent(dragStart);
      toolbar?.dispatchEvent(dragOver);
      expect(view.dom.querySelector<HTMLElement>(".markra-block-drop-indicator")?.style.top).toBe(testCase.indicator);
      toolbar?.dispatchEvent(drop);
      expect(view.state.doc.toString()).toBe(testCase.side === "before"
        ? "Second\n\nFirst\n\nThird\n\nFourth"
        : "Second\n\nThird\n\nFirst\n\nFourth");
    }
  });

  it("drags every block in a selected group from any selected handle", () => {
    const doc = "First\n\nSecond\n\nThird\n\nFourth";
    const view = createView(doc);
    const blocks = readCodeMirrorBlockRanges(view.state);
    const second = blocks[1];
    const fourth = blocks[3];
    view.dispatch({ selection: EditorSelection.range(0, second?.to ?? 0) });
    const handle = view.dom.querySelector<HTMLElement>(
      `[data-block-from="${second?.from}"] .markra-block-drag-handle`,
    );
    const target = view.dom.querySelector<HTMLElement>(
      `.cm-line[data-markra-block-from="${fourth?.from}"]`,
    );
    if (target) Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ top: 100, bottom: 120, height: 20, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }),
    });
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 105 });
    Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 105 });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });

    handle?.dispatchEvent(dragStart);
    target?.dispatchEvent(dragOver);
    target?.dispatchEvent(drop);

    expect(view.state.doc.toString()).toBe("Third\n\nFirst\n\nSecond\n\nFourth");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("First\n\nSecond");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("uses the coordinate row when a neighboring line receives the pointer event", () => {
    const doc = "Alpha\n\nBravo first\ncontinued\nlast\n\nCharlie\n\nDelta";
    const view = createView(doc);
    const rows = [...view.dom.querySelectorAll<HTMLElement>(".cm-line")];
    const continued = rows.find((line) => line.textContent === "continued")!;
    const last = rows.find((line) => line.textContent === "last")!;
    Object.defineProperty(continued, "getBoundingClientRect", { value: () => new DOMRect(0, 100, 200, 20) });
    Object.defineProperty(last, "getBoundingClientRect", { value: () => new DOMRect(0, 120, 200, 20) });
    Object.defineProperty(view, "posAtCoords", { value: () => doc.indexOf("continued") + 2 });
    const handle = view.dom.querySelector<HTMLElement>(`[data-block-from="${doc.indexOf("Delta")}"] .markra-block-drag-handle`)!;
    handle.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, pointerId: 21, clientX: 10, clientY: 200,
    }));
    last.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, pointerId: 21, clientX: 10, clientY: 119.5,
    }));
    expect(view.dom.querySelector<HTMLElement>(".markra-block-drop-indicator")?.style.top).toBe("140px");
    last.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true, pointerId: 21, clientX: 10, clientY: 119.5,
    }));
    expect(view.state.doc.toString()).toBe("Alpha\n\nBravo first\ncontinued\nlast\n\nDelta\n\nCharlie");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("rejects an empty external drag payload instead of treating it as block zero", () => {
    const view = createView("First\n\nSecond");
    const target = view.dom.querySelector<HTMLElement>('.cm-line[data-markra-block-from="7"]');
    const dataTransfer = { dropEffect: "none", getData: () => "", setData: () => undefined };
    const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
    target?.dispatchEvent(dragOver);
    expect(dragOver.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("First\n\nSecond");
  });

  it("cancels pointer drags on pointercancel or a document change", () => {
    for (const mode of ["cancel", "edit"] as const) {
      const view = createView("First\n\nSecond\n\nThird");
      const blocks = readCodeMirrorBlockRanges(view.state);
      const first = blocks[0];
      const handle = view.dom.querySelector<HTMLElement>(
        `[data-block-from="${first?.from}"] .markra-block-drag-handle`,
      );
      handle?.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, button: 0, buttons: 1, clientX: 10, clientY: 10, pointerId: 8,
      }));
      view.dom.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, buttons: 1, clientX: 20, clientY: 40, pointerId: 8,
      }));
      expect(view.dom.querySelector(".markra-block-drop-indicator")).not.toBeNull();

      if (mode === "cancel") {
        document.dispatchEvent(new PointerEvent("pointercancel", {
          bubbles: true, pointerId: 8,
        }));
        expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
      } else {
        view.dispatch({ changes: { from: 5, insert: "!" }, userEvent: "input" });
        document.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true, button: 0, clientX: 20, clientY: 40, pointerId: 8,
        }));
        expect(view.state.doc.toString()).toBe("First!\n\nSecond\n\nThird");
      }
      expect(view.dom.querySelector(".markra-block-drop-indicator")).toBeNull();
    }
  });

  it("discovers list items as independently draggable blocks without rewriting source", () => {
    const doc = "# Title\n\nParagraph\n\n- One\n- Two\n\n> Quote";
    const view = createView(doc);

    expect(readCodeMirrorBlockRanges(view.state).map((range) =>
      view.state.sliceDoc(range.from, range.to))).toEqual([
      "# Title",
      "Paragraph",
      "- One",
      "- Two",
      "> Quote",
    ]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("reorders one list item without moving the entire list", () => {
    const doc = "- First\n- Second\n- Third\n\nAfter";
    const view = createView(doc);
    const [first, second] = readCodeMirrorBlockRanges(view.state);

    expect(first?.name).toBe("ListItem");
    expect(second?.name).toBe("ListItem");
    expect(second && first && moveCodeMirrorBlock(view, second.from, first.from, "before")).toBe(true);
    expect(view.state.doc.toString()).toBe("- Second\n- First\n- Third\n\nAfter");
  });

  it("moves a paragraph into a list as a sibling item", () => {
    const doc = "Paragraph\n\n- First\n- Second";
    const view = createView(doc);
    const [paragraph, first] = readCodeMirrorBlockRanges(view.state);

    expect(paragraph && first && moveCodeMirrorBlock(view, paragraph.from, first.from, "after")).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n- Paragraph\n- Second");
  });

  it("outdents a nested list item when a shallower drop depth is requested", () => {
    const doc = "- First\n  - Nested\n- Last";
    const view = createView(doc);
    const nested = readCodeMirrorBlockRanges(view.state).find(
      (block) => block.depth === 1,
    );
    const last = readCodeMirrorBlockRanges(view.state).at(-1);

    expect(nested && last && moveCodeMirrorBlock(view, nested.from, last.from, "before", 0)).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n- Nested\n- Last");
  });

  it("preserves parsed child-item styling by changing only the moved region", () => {
    const doc = [
      "- **First title**: Body",
      "- Middle item",
      "- **Second title**: Body",
      "- **Third title**: Body",
      "",
      "After",
    ].join("\n");
    const changedRanges: Array<{ from: number; to: number }> = [];
    const view = createView(doc, false, [
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        update.changes.iterChangedRanges((from, to) => {
          changedRanges.push({ from, to });
        });
      }),
    ]);
    const [first, , second] = readCodeMirrorBlockRanges(view.state);

    expect(
      first && second &&
        moveCodeMirrorBlock(view, second.from, first.from, "after", 1),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe([
      "- **First title**: Body",
      "  - **Second title**: Body",
      "- Middle item",
      "- **Third title**: Body",
      "",
      "After",
    ].join("\n"));
    expect(changedRanges).toHaveLength(1);
    expect(changedRanges[0]?.from).toBeGreaterThan(0);
    expect(changedRanges[0]?.to).toBeLessThan(doc.length);

    const childLine = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-markra-list-item"),
    ).find((line) => line.textContent === "Second title: Body");
    expect(childLine?.getAttribute("data-list-depth")).toBe("1");
    expect(childLine?.getAttribute("data-markra-list-source")).toBe("hidden");
  });

  it("clamps a child drop to the deepest available parent level", () => {
    const view = createView([
      "- **First title**: Body",
      "- Middle item",
      "- **Moved title**: Body",
      "- Last item",
    ].join("\n"));
    const [first, , source] = readCodeMirrorBlockRanges(view.state);

    expect(
      source && first && moveCodeMirrorBlock(
        view,
        source.from,
        first.from,
        "after",
        3,
      ),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe([
      "- **First title**: Body",
      "  - **Moved title**: Body",
      "- Middle item",
      "- Last item",
    ].join("\n"));
    const movedLine = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-line"),
    ).find((line) => line.textContent?.includes("Moved title"));
    expect(movedLine?.getAttribute("data-list-depth")).toBe("1");
    expect(movedLine?.getAttribute("data-markra-list-source")).toBe("hidden");
  });

  it("uses the parent marker width when nesting below an ordered item", () => {
    const view = createView([
      "10. Ordered parent",
      "- **Moved title**: Body",
      "- Last item",
    ].join("\n"));
    const [parent, source] = readCodeMirrorBlockRanges(view.state);

    expect(
      source && parent && moveCodeMirrorBlock(
        view,
        source.from,
        parent.from,
        "after",
        1,
      ),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe([
      "10. Ordered parent",
      "    - **Moved title**: Body",
      "- Last item",
    ].join("\n"));
    const movedLine = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-line"),
    ).find((line) => line.textContent?.includes("Moved title"));
    expect(movedLine?.getAttribute("data-list-depth")).toBe("1");
    expect(movedLine?.getAttribute("data-markra-list-source")).toBe("hidden");
  });

  it("preserves tab-expanded columns when nesting a second-level item deeper", () => {
    const view = createView([
      "- Parent",
      "\t- First child",
      "\t- Second child",
      "\t\t- Grandchild",
      "- Tail",
    ].join("\n"));
    const blocks = readCodeMirrorBlockRanges(view.state);
    const firstChild = blocks.find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("\t- First child")
    );
    const secondChild = blocks.find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("\t- Second child")
    );

    expect(firstChild?.depth).toBe(1);
    expect(secondChild?.depth).toBe(1);
    expect(
      secondChild && firstChild && moveCodeMirrorBlock(
        view,
        secondChild.from,
        firstChild.from,
        "after",
        2,
      ),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe([
      "- Parent",
      "\t- First child",
      "      - Second child",
      "          - Grandchild",
      "- Tail",
    ].join("\n"));
    const movedBlocks = readCodeMirrorBlockRanges(view.state);
    const moved = movedBlocks.find((block) =>
      view.state.doc.lineAt(block.from).text.includes("Second child")
    );
    const grandchild = movedBlocks.find((block) =>
      view.state.doc.lineAt(block.from).text.includes("Grandchild")
    );
    expect(moved?.depth).toBe(2);
    expect(grandchild?.depth).toBe(3);
  });

  it("turns a paragraph dropped as a child into a nested list item", () => {
    const view = createView("- Parent\n\nChild paragraph\n\nAfter");
    const [parent, child] = readCodeMirrorBlockRanges(view.state);

    expect(
      child && parent && moveCodeMirrorBlock(
        view,
        child.from,
        parent.from,
        "after",
        1,
      ),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Child paragraph\n\nAfter",
    );
    const childLine = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-line"),
    ).find((line) => line.textContent === "Child paragraph");
    expect(childLine?.getAttribute("data-list-depth")).toBe("1");
    expect(childLine?.getAttribute("data-markra-list-source")).toBe("hidden");
  });

  it("renders block controls with the app-compatible icon structure", () => {
    const view = createView("First\n\nSecond");
    const add = view.dom.querySelector(".markra-block-add-button");
    const drag = view.dom.querySelector(".markra-block-drag-handle");

    expect(add?.classList.contains("markra-block-tool-button")).toBe(true);
    expect(drag?.classList.contains("markra-block-tool-button")).toBe(true);
    expect(drag?.querySelectorAll(".markra-block-drag-dot")).toHaveLength(6);
  });

  it("moves a top-level block as one undoable source edit", () => {
    const doc = "First\n\nSecond\n\nThird";
    const view = createView(doc);
    const [first, second] = readCodeMirrorBlockRanges(view.state);

    expect(first && second && moveCodeMirrorBlock(view, first.from, second.from, "after")).toBe(true);
    expect(view.state.doc.toString()).toBe("Second\n\nFirst\n\nThird");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("reorders a four-asterisk horizontal rule as one block", () => {
    const doc = "First\n\n****\n\nSecond";
    const view = createView(doc);
    const blocks = readCodeMirrorBlockRanges(view.state);
    const rule = blocks.find((block) => block.name === "HorizontalRule");
    const second = blocks.find((block) => view.state.sliceDoc(block.from, block.to) === "Second");

    expect(view.dom.querySelectorAll("hr.cm-markra-horizontal-rule")).toHaveLength(1);
    expect(rule && second && moveCodeMirrorBlock(view, rule.from, second.from, "after")).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\n****");
  });

  it("reorders blocks through the rendered drag handle", () => {
    const view = createView("First\n\nSecond\n\nThird");
    const [first, second] = readCodeMirrorBlockRanges(view.state);
    const handle = view.dom.querySelector<HTMLElement>(
      `[data-block-from="${first?.from}"] .markra-block-drag-handle`,
    );
    const target = view.dom.querySelector<HTMLElement>(
      `.cm-line[data-markra-block-from="${second?.from}"]`,
    );
    if (target) Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ top: 0, bottom: 20, height: 20, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY: 15 });
    Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 15 });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });

    handle?.dispatchEvent(dragStart);
    target?.dispatchEvent(dragOver);
    expect(view.dom.querySelector(".markra-block-drag-source")).not.toBeNull();
    expect(view.dom.querySelector(".markra-block-drop-indicator")?.getAttribute("data-show")).toBe("true");
    target?.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Second\n\nFirst\n\nThird");
    expect(view.dom.querySelector(".markra-block-drag-source")).toBeNull();
    expect(view.dom.querySelector(".markra-block-drop-indicator")).toBeNull();
  });

  it("reorders task items through pointer dragging when native drag events are unavailable", () => {
    const view = createView(
      "- [ ] First task\n- [ ] Second task\n- [ ] Third task",
    );
    const [first, second] = readCodeMirrorBlockRanges(view.state);
    const handle = view.dom.querySelector<HTMLElement>(
      `[data-block-from="${first?.from}"] .markra-block-drag-handle`,
    );
    const target = view.dom.querySelector<HTMLElement>(
      `.cm-line[data-markra-block-from="${second?.from}"]`,
    );

    handle?.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    }));
    target?.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      buttons: 1,
      clientX: 20,
      clientY: 40,
      pointerId: 1,
    }));

    expect(view.dom.querySelector(".markra-block-drag-source")).not.toBeNull();
    expect(
      view.dom.querySelector(".markra-block-drop-indicator")?.getAttribute(
        "data-show",
      ),
    ).toBe("true");

    target?.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 40,
      pointerId: 1,
    }));

    expect(view.state.doc.toString()).toBe(
      "- [ ] Second task\n- [ ] First task\n- [ ] Third task",
    );
    expect(view.dom.querySelector(".markra-block-drag-source")).toBeNull();
    expect(view.dom.querySelector(".markra-block-drop-indicator")).toBeNull();
  });

  it("nests a second-level item as a third-level item through pointer dragging", () => {
    const view = createView([
      "- Parent",
      "  - First child",
      "  - Second child",
      "- Tail",
    ].join("\n"));
    const blocks = readCodeMirrorBlockRanges(view.state);
    const firstChild = blocks.find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("  - First child")
    );
    const secondChild = blocks.find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("  - Second child")
    );
    const handle = view.dom.querySelector<HTMLElement>(
      `[data-block-from="${secondChild?.from}"] .markra-block-drag-handle`,
    );
    const target = view.dom.querySelector<HTMLElement>(
      `.cm-line[data-markra-block-from="${firstChild?.from}"]`,
    );

    handle?.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 44,
      clientY: 10,
      pointerId: 2,
    }));
    target?.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      buttons: 1,
      clientX: 66,
      clientY: 40,
      pointerId: 2,
    }));
    target?.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      button: 0,
      clientX: 66,
      clientY: 40,
      pointerId: 2,
    }));

    expect(view.state.doc.toString()).toBe([
      "- Parent",
      "  - First child",
      "    - Second child",
      "- Tail",
    ].join("\n"));
    const moved = readCodeMirrorBlockRanges(view.state).find((block) =>
      view.state.sliceDoc(block.from, block.to).startsWith("    - Second child")
    );
    expect(moved?.depth).toBe(2);
  });

  it("adds an editable blank block below and opens the virtual slash menu", () => {
    const view = createView("First\n\nSecond\n\nThird");
    const second = readCodeMirrorBlockRanges(view.state)[1];
    const button = view.dom.querySelector<HTMLButtonElement>(
      `[data-block-from="${second?.from}"] [aria-label="Add block below"]`,
    );

    button?.click();

    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\n\n\nThird");
    expect(getMarkraSlashMenuState(view)).toMatchObject({
      open: true,
      source: "virtual",
    });
    expect(view.dom.querySelectorAll(".markra-block-add-button")).toHaveLength(4);
  });

  it("keeps later block controls mounted while typing plain text before them", () => {
    const doc = "Edit here\n\n## Later block";
    const view = createView(doc);
    const laterFrom = doc.indexOf("## Later block");
    const laterToolbar = view.dom.querySelector<HTMLElement>(
      `[data-block-from="${laterFrom}"]`,
    );

    view.dispatch({
      changes: { from: "Edit here".length, insert: "字" },
      selection: EditorSelection.cursor("Edit here字".length),
      userEvent: "input.type",
    });

    const nextLaterFrom = laterFrom + 1;
    expect(
      view.dom.querySelector(`[data-block-from="${nextLaterFrom}"]`),
    ).toBe(laterToolbar);
    expect(
      view.dom.querySelector(
        `.cm-line[data-markra-block-from="${nextLaterFrom}"]`,
      ),
    ).not.toBeNull();
  });

  it("does not render mutation controls in a read-only editor", () => {
    const view = createView("First\n\nSecond", true);

    expect(view.dom.querySelector(".markra-block-drag-handle")).toBeNull();
    const [first, second] = readCodeMirrorBlockRanges(view.state);
    expect(first && second && moveCodeMirrorBlock(view, first.from, second.from, "after")).toBe(false);
    expect(view.state.doc.toString()).toBe("First\n\nSecond");
  });
});
