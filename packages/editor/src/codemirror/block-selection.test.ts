import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { blocksPlugin } from "./blocks.ts";
import { blockSelectionPlugin } from "./block-selection.ts";
import {
  getMarkraSlashMenuState,
  liveMarkdown,
  markdownEditingPlugin,
} from "./index.ts";
import "./dom.test-support.ts";

const views: EditorView[] = [];

function createView(
  doc: string,
  readOnly = false,
  extraExtensions: readonly Extension[] = [],
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
          plugins: [blocksPlugin({ keybindings: false }), blockSelectionPlugin(), markdownEditingPlugin()],
          slashMenu: true,
        }),
        EditorState.readOnly.of(readOnly),
        ...extraExtensions,
      ],
      selection: EditorSelection.cursor(0),
    }),
  });
  views.push(view);
  return view;
}

function press(
  view: EditorView,
  key: string,
  options: { ctrl?: boolean; shift?: boolean } = {},
) {
  return runScopeHandlers(view, new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrl ?? false,
    key,
    shiftKey: options.shift ?? false,
  }), "editor");
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("blockSelectionPlugin", () => {
  it("selects the current block, expands to the document, and exits with Escape", () => {
    const view = createView("First\n\nSecond");
    view.dispatch({ selection: EditorSelection.cursor(8) });

    expect(press(view, "a", { ctrl: true })).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Second");
    expect(press(view, "a", { ctrl: true })).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
    expect(press(view, "Escape")).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it("returns to the block caret on Enter without replacing the selected Markdown", () => {
    const doc = "A paragraph";
    const view = createView(doc);

    expect(press(view, "Escape")).toBe(true);
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
  });

  it("extends across adjacent blocks and moves a multi-block selection in one undo", () => {
    const view = createView("First\n\nSecond\n\nThird");

    expect(press(view, "a", { ctrl: true })).toBe(true);
    expect(press(view, "ArrowDown", { shift: true })).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("First\n\nSecond");
    expect(press(view, "ArrowDown", { ctrl: true, shift: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("Third\n\nFirst\n\nSecond");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
  });

  it("moves an ordinary partial multi-block selection by whole blocks", () => {
    const doc = "First paragraph\ncontinued\n\nSecond\n\nThird";
    const view = createView(doc);
    const start = doc.indexOf("paragraph") + 2;
    const end = doc.indexOf("Second") + 3;
    view.dispatch({ selection: EditorSelection.range(start, end) });

    expect(press(view, "ArrowDown", { ctrl: true, shift: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "Third\n\nFirst paragraph\ncontinued\n\nSecond",
    );
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "First paragraph\ncontinued\n\nSecond",
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps a one-block move selected and leaves the ordinary caret shortcut alone", () => {
    const view = createView("First\n\nSecond\n\nThird");
    view.dispatch({ selection: EditorSelection.range(1, 3) });
    expect(press(view, "ArrowDown", { ctrl: true, shift: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("Second\n\nFirst\n\nThird");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("First");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");

    const caret = createView("First\n\nSecond\n\nThird");
    expect(press(caret, "ArrowDown", { ctrl: true, shift: true })).toBe(false);
    expect(caret.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
  });

  it("does not move a blank-only or multi-range selection", () => {
    const view = createView("First\n\nSecond\n\nThird", false, [
      EditorState.allowMultipleSelections.of(true),
    ]);
    const original = view.state.doc.toString();
    view.dispatch({ selection: EditorSelection.range(5, 6) });
    expect(press(view, "ArrowDown", { ctrl: true, shift: true })).toBe(false);
    expect(view.state.doc.toString()).toBe(original);

    view.dispatch({ selection: EditorSelection.create([
      EditorSelection.range(0, 5),
      EditorSelection.range(7, 13),
    ]) });
    press(view, "ArrowDown", { ctrl: true, shift: true });
    expect(view.state.doc.toString()).toBe(original);
  });

  it("duplicates and deletes blocks with one undo per action", () => {
    const view = createView("First\n\nSecond\n\nThird");
    view.dispatch({ changes: { from: 5, insert: "!" }, userEvent: "input" });
    view.dispatch({ selection: EditorSelection.cursor(10) });
    expect(press(view, "Escape")).toBe(true);
    expect(press(view, "d", { ctrl: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("First!\n\nSecond\n\nSecond\n\nThird");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "?" }, userEvent: "input" });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First!\n\nSecond\n\nSecond\n\nThird");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First!\n\nSecond\n\nThird");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
    view.dispatch({ selection: EditorSelection.cursor(10) });
    expect(press(view, "Escape")).toBe(true);
    expect(press(view, "Delete")).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nThird");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
  });

  it("deletes a multi-block selection in one undo and keeps the remaining separator", () => {
    const view = createView("First\n\nSecond\n\nThird");
    expect(press(view, "Escape")).toBe(true);
    expect(press(view, "ArrowDown", { shift: true })).toBe(true);
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("Third");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n\nThird");
  });

  it("does not treat separate lists across a paragraph as siblings or delete the gap", () => {
    const view = createView("- First\n\nParagraph\n\n- Second");
    view.dispatch({ selection: EditorSelection.cursor(3) });

    expect(press(view, "a", { ctrl: true })).toBe(true);
    expect(press(view, "ArrowDown", { shift: true })).toBe(false);
    expect(press(view, "Delete")).toBe(true);
    expect(view.state.doc.toString()).toBe("Paragraph\n\n- Second");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n\nParagraph\n\n- Second");
  });

  it("preserves separators and surrounding blocks when deleting a final list item", () => {
    const cases = [
      {
        before: "Before\n\n- Parent\n  - Child\n\nAfter",
        selected: "Child",
        after: "Before\n\n- Parent\n\nAfter",
      },
      {
        before: "Before\n\n- A\n- Item B\n\nAfter",
        selected: "Item B",
        after: "Before\n\n- A\n\nAfter",
      },
      {
        before: "```txt\nBefore code\n```\n\n- A\n- Item B\n\n```txt\nAfter code\n```",
        selected: "Item B",
        after: "```txt\nBefore code\n```\n\n- A\n\n```txt\nAfter code\n```",
      },
      {
        before: "---\ntitle: Note\n---\n\n- A\n- Item B\n\nAfter",
        selected: "Item B",
        after: "---\ntitle: Note\n---\n\n- A\n\nAfter",
      },
    ];

    for (const testCase of cases) {
      const view = createView(testCase.before);
      view.dispatch({ selection: EditorSelection.cursor(testCase.before.indexOf(testCase.selected) + 1) });

      expect(press(view, "a", { ctrl: true })).toBe(true);
      expect(press(view, "Delete")).toBe(true);
      expect(view.state.doc.toString()).toBe(testCase.after);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(testCase.before);
    }
  });

  it("selects a nested list child alone and keeps its parent when duplicating it", () => {
    const doc = "Before\n\n- Parent\n  - Child\n\nAfter";
    const view = createView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("Child") + 2) });

    expect(press(view, "a", { ctrl: true })).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("  - Child");
    expect(press(view, "d", { ctrl: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\n- Parent\n  - Child\n  - Child\n\nAfter");

    const parent = createView(doc);
    parent.dispatch({ selection: EditorSelection.cursor(doc.indexOf("Parent") + 2) });
    expect(press(parent, "a", { ctrl: true })).toBe(true);
    expect(parent.state.sliceDoc(parent.state.selection.main.from, parent.state.selection.main.to)).toBe("- Parent\n  - Child");
    expect(press(parent, "d", { ctrl: true })).toBe(true);
    expect(parent.state.doc.toString()).toBe("Before\n\n- Parent\n  - Child\n- Parent\n  - Child\n\nAfter");
  });

  it("leaves frontmatter, code, tables, read-only documents, and ordinary text selections to existing behavior", () => {
    const code = createView("```ts\nconst value = 1;\n```");
    code.dispatch({ selection: EditorSelection.cursor(code.state.doc.toString().indexOf("value")) });
    expect(press(code, "Escape")).toBe(false);
    expect(press(code, "4", { ctrl: true, shift: true })).toBe(false);
    expect(code.state.doc.toString()).toBe("```ts\nconst value = 1;\n```");
    expect(code.state.selection.main.empty).toBe(true);

    const frontmatter = createView("---\ntitle: Note\n---\n\nBody");
    frontmatter.dispatch({ selection: EditorSelection.cursor(4) });
    expect(press(frontmatter, "a", { ctrl: true })).toBe(false);
    expect(frontmatter.state.selection.main.empty).toBe(true);

    const table = createView("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(press(table, "Escape")).toBe(false);

    const readOnly = createView("Read only", true);
    expect(press(readOnly, "Escape")).toBe(false);
    expect(readOnly.state.selection.main.empty).toBe(true);
    expect(press(readOnly, "4", { ctrl: true, shift: true })).toBe(false);
    expect(readOnly.state.doc.toString()).toBe("Read only");

    const normalSelection = createView("Selected text");
    normalSelection.dispatch({ selection: EditorSelection.range(0, 8) });
    expect(press(normalSelection, "ArrowDown", { shift: true })).toBe(false);
    expect(normalSelection.state.sliceDoc(normalSelection.state.selection.main.from, normalSelection.state.selection.main.to)).toBe("Selected");
  });

  it("routes the Notion task-list shortcut through the existing block command", () => {
    const view = createView("Task");

    expect(press(view, "4", { ctrl: true, shift: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("- [ ] Task");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Task");
  });

  it("opens the slash menu with Ctrl+/ and keeps the block selection through conversion", () => {
    const view = createView("Alpha");
    expect(press(view, "Escape")).toBe(true);
    const selected = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    expect(selected).toBe("Alpha");

    expect(press(view, "/", { ctrl: true })).toBe(true);
    expect(getMarkraSlashMenuState(view)).toMatchObject({
      open: true,
      query: "",
      source: "block-selection",
    });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(selected);

    const actions = getMarkraSlashMenuState(view).actions;
    const headingIndex = actions.findIndex((action) => action.command === "block.heading.1");
    for (let index = 0; index < headingIndex; index += 1) press(view, "ArrowDown");
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("# Alpha");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("Alpha");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Alpha");
  });

  it("does not open a formatting menu for a quote containing fenced code", () => {
    const doc = "> Text\n>\n> ```ts\n> const value = 1\n> ```";
    const view = createView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("Text") + 1) });

    expect(press(view, "Escape")).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(doc);
    expect(press(view, "/", { ctrl: true })).toBe(false);
    expect(getMarkraSlashMenuState(view).open).toBe(false);
  });
});
