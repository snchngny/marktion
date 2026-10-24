import { defaultKeymap, history, redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeMirrorBlockDragPlugin } from "./block-drag.ts";
import { liveMarkdown } from "./index.ts";
import { markdownEditingPlugin } from "./markdown-editing.ts";
import "./dom.test-support.ts";

const views: EditorView[] = [];

function createView(
  doc: string,
  selection: number | EditorSelection,
  blockToolbar = false,
  observedTransactions?: Transaction[],
  readOnly = false,
) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
        history(),
        keymap.of(defaultKeymap),
        liveMarkdown({
          plugins: [
            ...(blockToolbar ? [codeMirrorBlockDragPlugin()] : []),
            markdownEditingPlugin(),
          ],
        }),
        observedTransactions
          ? EditorView.updateListener.of((update) => {
            observedTransactions.push(...update.transactions);
          })
          : [],
      ],
      selection: typeof selection === "number"
        ? EditorSelection.cursor(selection)
        : selection,
    }),
  });
  views.push(view);
  return view;
}

function press(
  view: EditorView,
  key: string,
  options: KeyboardEventInit = {},
) {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { bubbles: true, key, ...options }),
    "editor",
  );
}

function expectFullHeightEmptyLines(view: EditorView, count: number) {
  const emptyLines = Array.from(
    view.dom.querySelectorAll(".cm-markra-empty-line"),
  );
  expect(emptyLines).toHaveLength(count);
  expect(
    emptyLines.every((line) =>
      !line.hasAttribute("data-markra-empty-source")
    ),
  ).toBe(true);
}

function topLevelNodeNames(view: EditorView) {
  const names: string[] = [];
  for (let node = syntaxTree(view.state).topNode.firstChild; node; node = node.nextSibling) {
    names.push(node.name);
  }
  return names;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("markdownEditingPlugin", () => {
  it.each([3, 4])(
    "keeps the trailing line break when replacing a line after click count %s",
    (detail) => {
      const firstLine = "Mock selected line";
      const secondLine = "Mock next line";
      const view = createView(`${firstLine}\n${secondLine}`, 0);
      view.focus();

      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 0,
        clientY: 0,
        detail,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(view.state.selection.main.from).toBe(0);
      expect(view.state.selection.main.to).toBe(firstLine.length);

      view.dispatch(
        view.state.replaceSelection("Replacement"),
        { userEvent: "input.type" },
      );

      expect(view.state.doc.toString()).toBe(`Replacement\n${secondLine}`);
    },
  );

  it("keeps the trailing line break when replacing a keyboard-selected line", () => {
    const firstLine = "Mock selected line";
    const secondLine = "Mock next line";
    const view = createView(`${firstLine}\n${secondLine}`, 0);
    view.focus();

    expect(press(view, "l", { altKey: true })).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(firstLine.length);

    view.dispatch(
      view.state.replaceSelection("Replacement"),
      { userEvent: "input.type" },
    );

    expect(view.state.doc.toString()).toBe(`Replacement\n${secondLine}`);
  });

  it("inserts into a triple-clicked empty line without removing it", () => {
    const secondLine = "Mock next line";
    const view = createView(`\n${secondLine}`, 0);
    view.focus();

    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      clientX: 0,
      clientY: 0,
      detail: 3,
    }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(view.state.selection.main.empty).toBe(true);
    view.dispatch(
      view.state.replaceSelection("Replacement"),
      { userEvent: "input.type" },
    );

    expect(view.state.doc.toString()).toBe(`Replacement\n${secondLine}`);
  });

  it("keeps internal line breaks in a keyboard-selected line range", () => {
    const firstLine = "Mock first line";
    const secondLine = "Mock second line";
    const thirdLine = "Mock third line";
    const doc = `${firstLine}\n${secondLine}\n${thirdLine}`;
    const view = createView(
      doc,
      EditorSelection.create([
        EditorSelection.range(2, firstLine.length + 1 + 4),
      ]),
    );

    expect(press(view, "l", { altKey: true })).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(
      firstLine.length + 1 + secondLine.length,
    );

    view.dispatch(
      view.state.replaceSelection("Replacement"),
      { userEvent: "input.type" },
    );

    expect(view.state.doc.toString()).toBe(`Replacement\n${thirdLine}`);
  });

  it("selects multiple complete lines without their trailing breaks", () => {
    const firstLine = "Mock first line";
    const middleLine = "Mock middle line";
    const lastLine = "Mock last line";
    const doc = `${firstLine}\n${middleLine}\n${lastLine}`;
    const lastLineFrom = firstLine.length + 1 + middleLine.length + 1;
    const view = createView(
      doc,
      EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(lastLineFrom + 2),
      ]),
    );

    expect(press(view, "l", { altKey: true })).toBe(true);
    expect(view.state.selection.ranges.map(({ from, to }) => ({ from, to })))
      .toEqual([
        { from: 0, to: firstLine.length },
        { from: lastLineFrom, to: doc.length },
      ]);

    view.dispatch(
      view.state.replaceSelection("Replacement"),
      { userEvent: "input.type" },
    );

    expect(view.state.doc.toString()).toBe(
      `Replacement\n${middleLine}\nReplacement`,
    );
  });

  it("keeps CodeMirror's double-click word selection behavior", () => {
    const view = createView("Mock selected line\nMock next line", 0);
    view.focus();

    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      clientX: 0,
      clientY: 0,
      detail: 2,
    }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe("Mock".length);
  });

  it("splits a paragraph into two Markdown paragraphs on Enter", () => {
    const doc = "MockBeforeMockAfter";
    const position = "MockBefore".length;
    const view = createView(doc, position);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("MockBefore\n\nMockAfter");
    expect(view.state.selection.main.head).toBe(position + 2);
  });

  it("keeps the caret on a new blank line before text", () => {
    const doc = "Before\nAfter";
    const position = "Before\n".length;
    const view = createView(doc, position);
    view.focus();

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\nAfter");
    expect(view.state.selection.main.head).toBe(position + 1);
    expectFullHeightEmptyLines(view, 1);

    view.dispatch({
      changes: { from: position + 1, insert: "Middle" },
      selection: EditorSelection.cursor(position + 1 + "Middle".length),
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe("Before\n\nMiddleAfter");
    expectFullHeightEmptyLines(view, 1);
  });

  it("adds one editable blank line when a Markdown separator already exists", () => {
    const doc = "Before\n\nAfter";
    const position = "Before\n\n".length;
    const view = createView(doc, position);
    view.focus();

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\n\nAfter");
    expect(view.state.selection.main.head).toBe(position + 1);
    expectFullHeightEmptyLines(view, 2);
  });

  it("splits paragraphs when Enter follows text before an existing line break", () => {
    const doc = "Before\nAfter";
    const position = "Before".length;
    const view = createView(doc, position);
    view.focus();

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\n\nAfter");
    expect(view.state.selection.main.head).toBe(position + 2);
    expectFullHeightEmptyLines(view, 2);
  });

  it("keeps a single native newline at the end of the document", () => {
    const doc = "Before";
    const view = createView(doc, doc.length);
    view.focus();

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Before\n\n");
    expect(view.state.selection.main.head).toBe(doc.length + 2);
    expectFullHeightEmptyLines(view, 2);
  });

  it("moves the caret with text across repeated Enter presses", () => {
    const before = "MockBefore";
    const after = "MockAfter";
    const view = createView(`${before}${after}`, before.length);
    view.focus();

    for (let presses = 1; presses <= 4; presses += 1) {
      expect(press(view, "Enter")).toBe(true);
      const lineBreaks = presses + 1;
      expect(view.state.doc.toString()).toBe(
        `${before}${"\n".repeat(lineBreaks)}${after}`,
      );
      expect(view.state.selection.main.head).toBe(before.length + lineBreaks);
    }

    expectFullHeightEmptyLines(view, 4);

    const position = view.state.selection.main.head;
    view.dispatch({
      changes: { from: position, insert: "Typed" },
      selection: EditorSelection.cursor(position + "Typed".length),
      userEvent: "input.type",
    });

    expect(view.state.doc.toString()).toBe(
      `${before}\n\n\n\n\nTyped${after}`,
    );
    expectFullHeightEmptyLines(view, 4);

    view.dispatch({
      selection: EditorSelection.cursor(0),
      userEvent: "select.pointer",
    });
    expectFullHeightEmptyLines(view, 4);
  });

  it("keeps surviving blank lines full height during backward deletion", () => {
    const before = "MockBefore";
    const after = "MockAfter";
    const view = createView(`${before}${after}`, before.length);
    view.focus();

    for (let presses = 0; presses < 4; presses += 1) {
      expect(press(view, "Enter")).toBe(true);
    }

    view.contentDOM.blur();
    expect(view.hasFocus).toBe(false);
    expectFullHeightEmptyLines(view, 4);

    view.focus();
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(4).from),
      userEvent: "select.pointer",
    });
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe(`${before}\n\n\n\n${after}`);
    expectFullHeightEmptyLines(view, 3);

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe(`${before}\n\n\n${after}`);
    expectFullHeightEmptyLines(view, 2);

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe(`${before}\n\n${after}`);
    expectFullHeightEmptyLines(view, 1);
  });

  it("keeps multiple inserted empty lines full height", () => {
    const doc = "One\nTwo";
    const view = createView(
      doc,
      EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor("One\n".length),
      ]),
    );
    view.focus();

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("\nOne\n\nTwo");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
      1,
      "\nOne\n".length + 1,
    ]);
    expectFullHeightEmptyLines(view, 2);
  });

  it("keeps the caret associated with text after joining lines backward", () => {
    const view = createView("MockText", 0);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("\nMockText");
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("MockText");
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.selection.main.assoc).toBe(1);
  });

  it("keeps the native caret on the text side of the block toolbar", () => {
    const transactions: Transaction[] = [];
    const view = createView("\nMockText", 1, true, transactions);
    view.focus();

    expect(press(view, "Backspace")).toBe(true);

    const line = view.dom.querySelector<HTMLElement>(".cm-line");
    const toolbar = line?.querySelector(":scope > .cm-markra-block-toolbar");
    const nativeSelection = document.getSelection();
    expect(line).not.toBeNull();
    expect(toolbar).not.toBeNull();
    expect(nativeSelection?.anchorNode).not.toBeNull();

    const anchorNode = nativeSelection?.anchorNode;
    const anchorOffset = nativeSelection?.anchorOffset ?? -1;
    const toolbarIndex = line && toolbar
      ? [...line.childNodes].indexOf(toolbar)
      : -1;
    const isOnTextSide = anchorNode === line
      ? anchorOffset > toolbarIndex + 1
      : Boolean(
        anchorNode && line?.contains(anchorNode) && !toolbar?.contains(anchorNode),
      );
    expect(isOnTextSide).toBe(true);
    // The affinity must be part of the deleting transaction. A follow-up
    // selection update leaves real browsers on the equivalent widget edge.
    expect(transactions).toHaveLength(1);
  });

  it("keeps every caret associated with text when joining empty lines backward", () => {
    const doc = "\nMockOne\n\nMockTwo";
    const view = createView(
      doc,
      EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(doc.indexOf("MockTwo")),
      ]),
    );

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("MockOne\nMockTwo");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([
      0,
      "MockOne\n".length,
    ]);
    expect(view.state.selection.ranges.map((range) => range.assoc)).toEqual([
      1,
      1,
    ]);
  });

  it("corrects only affected carets in a mixed multi-cursor deletion", () => {
    const doc = "\nMockOne\nTail";
    const view = createView(
      doc,
      EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(doc.length),
      ]),
    );

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("MockOne\nTai");
    expect(view.state.selection.ranges.map((range) => range.assoc)).toEqual([
      1,
      -1,
    ]);
  });

  it("completes a typed image destination when Enter confirms it", () => {
    const doc = "![a](https://images.example.test/mock.jpg?w=1280&h=960";
    const view = createView(doc, doc.length);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe(`${doc})\n`);
    expect(view.state.selection.main.head).toBe(doc.length + 2);
  });

  it("keeps CodeMirror's native Markdown list continuation", () => {
    const view = createView("- First", "- First".length);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n- ");
  });

  it("lets CodeMirror end an empty list item on Enter", () => {
    const view = createView("- First\n- ", "- First\n- ".length);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n");
  });

  it("leaves multi-cursor empty list handling to Markdown without dropping a cursor", () => {
    const doc = "- First\n- ";
    const view = createView(doc, EditorSelection.create([
      EditorSelection.cursor("- First".length),
      EditorSelection.cursor(doc.length),
    ]));
    const originalRanges = view.state.selection.ranges.map((range) => range.head);

    press(view, "Enter");

    expect(view.state.selection.ranges).toHaveLength(2);
    expect(view.state.selection.ranges.map((range) => range.head)).toHaveLength(2);
    expect(view.state.doc.toString()).toContain("- First");
    expect(originalRanges).toHaveLength(2);
  });

  it("converts a plain paragraph into a root list item on Tab", () => {
    const view = createView("Alphabeta", "Alpha".length);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("- Alphabeta");
  });

  it("turns the preceding plain paragraph into a parent list item", () => {
    const view = createView("Parent\n\nChild", "Parent\n\nChild".length);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("- Parent\n\n  - Child");
  });

  it("converts a paragraph with multiple source lines into one child item", () => {
    const doc = "Parent\n\nChild line one\nChild line two";
    const view = createView(doc, doc.indexOf("Child line two") + 3);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n\n  - Child line one\n    Child line two",
    );
  });

  it("nests a paragraph after a list under its last top-level item", () => {
    const doc = "- Parent\n  - Existing child\n\nNew paragraph";
    const view = createView(doc, doc.indexOf("New paragraph") + 4);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Existing child\n\n  - New paragraph",
    );
  });

  it("nests ordered items by the parent marker's content column", () => {
    const doc = "1. Root\n   9. Parent\n   10. Child\n   11. Sibling\n2. Next";
    const view = createView(doc, doc.indexOf("10. Child") + 5);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "1. Root\n   9. Parent\n      10. Child\n   11. Sibling\n2. Next",
    );
    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      doc,
    );
  });

  it("moves a deeply nested item one level per Tab and Shift+Tab", () => {
    const doc = "- Root\n  - Parent\n    - Child\n  - Sibling";
    const view = createView(doc, doc.indexOf("Child"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Root\n  - Parent\n  - Child\n  - Sibling",
    );
    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Root\n  - Parent\n    - Child\n  - Sibling",
    );
  });

  it("leaves the first root item unchanged when Tab has no previous sibling", () => {
    const doc = "- First\n- Second";
    const view = createView(doc, doc.indexOf("First"));

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps selected sibling items at the same new depth", () => {
    const doc = "- Parent\n- First\n- Second\n- Next";
    const from = doc.indexOf("- First");
    const to = doc.indexOf("- Second") + "- Second".length;
    const view = createView(doc, EditorSelection.create([EditorSelection.range(from, to)]));

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - First\n  - Second\n- Next",
    );
  });

  it("does not turn the next line into a selected list item when the range ends there", () => {
    const doc = "- Parent\n- Selected\n- Next";
    const from = doc.indexOf("- Selected");
    const to = doc.indexOf("- Next");
    const view = createView(doc, EditorSelection.create([EditorSelection.range(from, to)]));

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Selected\n- Next",
    );
  });

  it("outdents selected siblings together without changing their parent order", () => {
    const doc = "- Parent\n  - First\n  - Second\n  - Later\n- Next";
    const from = doc.indexOf("- First");
    const to = doc.indexOf("- Second") + "- Second".length;
    const view = createView(doc, EditorSelection.create([EditorSelection.range(from, to)]));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Later\n- First\n- Second\n- Next",
    );
  });

  it("keeps Tab as indentation in frontmatter, quotes, and tables", () => {
    const frontmatter = "---\ntitle: Example\n---\n\nBody";
    const frontmatterView = createView(frontmatter, frontmatter.indexOf("Example") + 2);
    expect(press(frontmatterView, "Tab")).toBe(true);
    expect(frontmatterView.state.doc.toString()).toContain("Ex  ample");

    const quote = "> Quoted";
    const quoteView = createView(quote, quote.indexOf("Quoted") + 2);
    expect(press(quoteView, "Tab")).toBe(true);
    expect(quoteView.state.doc.toString()).toBe("> Qu  oted");

    const table = "| A | B |\n| --- | --- |\n| x | y |";
    const tableView = createView(table, table.indexOf("x") + 1);
    expect(press(tableView, "Tab")).toBe(true);
    expect(tableView.state.doc.toString()).toContain("x   | y");
  });

  it("moves an outdented subtree after the parent's other children", () => {
    const doc = "- Parent\n  - Child\n  - Sibling\n- Next";
    const view = createView(doc, doc.indexOf("Child"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Sibling\n- Child\n- Next",
    );
  });

  it("removes a root list marker and promotes its child list", () => {
    const doc = "- Parent\n  - Child\n    - Grandchild";
    const view = createView(doc, doc.indexOf("Parent"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "Parent\n\n- Child\n  - Grandchild",
    );
    expect(topLevelNodeNames(view)).toEqual(["Paragraph", "BulletList"]);
  });

  it("separates an unlisted root item from its preceding list", () => {
    const doc = "- First\n- Second";
    const view = createView(doc, doc.indexOf("Second"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n\nSecond");
    expect(topLevelNodeNames(view)).toEqual(["BulletList", "Paragraph"]);
  });

  it("separates a promoted ordered child list from its plain parent paragraph", () => {
    const doc = "- Parent\n\n  2. Child";
    const view = createView(doc, doc.indexOf("Parent"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("Parent\n\n2. Child");
    expect(topLevelNodeNames(view)).toEqual(["Paragraph", "OrderedList"]);
  });

  it("keeps list-looking lazy continuation text as part of its paragraph", () => {
    const doc = "- Parent\n  2. continuation";
    const view = createView(doc, doc.indexOf("Parent"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("Parent\n2. continuation");
    expect(topLevelNodeNames(view)).toEqual(["Paragraph"]);
  });

  it("keeps selected root items as separate Markdown paragraphs", () => {
    const doc = "- First\n- Second\n- Third";
    const from = doc.indexOf("- First");
    const to = doc.indexOf("- Second") + "- Second".length;
    const view = createView(doc, EditorSelection.create([EditorSelection.range(from, to)]));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("First\n\nSecond\n- Third");
    expect(topLevelNodeNames(view)).toEqual(["Paragraph", "Paragraph", "BulletList"]);
  });

  it.each(["- literal", "2. literal"])(
    "preserves list-looking code content %s when unlisting its parent",
    (literal) => {
      const doc = ["- Parent", "  ```text", `  ${literal}`, "  ```"].join("\n");
      const view = createView(doc, doc.indexOf("Parent"));

      expect(press(view, "Tab", { shiftKey: true })).toBe(true);
      expect(view.state.doc.toString()).toBe(
        ["Parent", "```text", literal, "```"].join("\n"),
      );
      expect(topLevelNodeNames(view)).toEqual(["Paragraph", "FencedCode"]);
    },
  );

  it("separates a real child list after a fenced block without changing code", () => {
    const doc = [
      "- Parent", "  ```text", "  - literal", "  ```", "  2. Child",
    ].join("\n");
    const view = createView(doc, doc.indexOf("Parent"));

    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe([
      "Parent", "```text", "- literal", "```", "", "2. Child",
    ].join("\n"));
    expect(topLevelNodeNames(view)).toEqual(["Paragraph", "FencedCode", "OrderedList"]);
  });

  it("keeps Tab inside fenced code as plain indentation", () => {
    const doc = "```\ncode\n```";
    const view = createView(doc, doc.indexOf("code") + 2);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nco  de\n```");
  });

  it("applies one paragraph conversion for duplicate cursors", () => {
    const view = createView(
      "Paragraph",
      EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(6),
      ]),
    );

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("- Paragraph");
  });

  it("undoes and redoes a hierarchy edit as one operation", () => {
    const view = createView("Parent\n\nChild", "Parent\n\nChild".length);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("- Parent\n\n  - Child");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Parent\n\nChild");
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- Parent\n\n  - Child");
  });

  it("keeps consecutive hierarchy edits as separate undo steps", () => {
    const doc = "- Parent\n- Child\n- Sibling";
    const view = createView(doc, doc.indexOf("Child"));

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Child\n- Sibling",
    );
    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Child\n- Sibling",
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "- Parent\n  - Child\n- Sibling",
    );
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("indents and outdents the current Markdown list item", () => {
    const doc = "- First\n- Second";
    const view = createView(doc, doc.indexOf("Second"));

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("- First\n  - Second");
    expect(press(view, "Tab", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("keeps Shift+Enter inside quote and callout source", () => {
    const doc = "> [!NOTE]\n> Quote";
    const view = createView(doc, doc.length);

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("> [!NOTE]\n> Quote\n> ");
  });

  it("inserts an HTML line break inside a GFM table cell", () => {
    const doc = "| Name | Notes |\n| --- | --- |\n| Example | First line |";
    const position = doc.indexOf("First line") + "First line".length;
    const view = createView(doc, position);

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toContain("First line<br> |");
  });

  it("inserts a Markdown hard break with Shift+Enter in a paragraph", () => {
    const doc = "FirstSecond";
    const view = createView(doc, "First".length);

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("First\\\nSecond");
    expect(view.state.selection.main.head).toBe("First\\\n".length);
  });

  it("leaves a heading for a normal paragraph when Enter is pressed", () => {
    const doc = "## Heading";
    const view = createView(doc, doc.length);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("## Heading\n\n");
    expect(topLevelNodeNames(view)).toEqual(["ATXHeading2"]);
  });

  it("splits at the caret inside an ATX heading and leaves Setext headings to Markdown", () => {
    const atx = "## Heading";
    const atxView = createView(atx, atx.indexOf("Heading") + 3);
    expect(press(atxView, "Enter")).toBe(true);
    expect(atxView.state.doc.toString()).toBe("## Hea\n\nding");

    const setext = "Heading\n=======";
    const setextView = createView(setext, "Heading".length);
    expect(press(setextView, "Enter")).toBe(true);
    expect(setextView.state.doc.toString()).toBe("Heading\n\n=======");
  });

  it("uses native Enter at the start of a heading", () => {
    const doc = "## Heading";
    const view = createView(doc, 0);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("\n## Heading");
  });

  it("does not add a literal Markdown hard-break marker inside a heading", () => {
    const doc = "## Heading";
    const view = createView(doc, doc.indexOf("Heading") + 3);

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).not.toContain("\\\n");
  });

  it("toggles a task checkbox with Ctrl+Enter as one undo step", () => {
    const doc = "- [ ] Task";
    const view = createView(doc, doc.indexOf("Task"));

    expect(press(view, "Enter", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("- [x] Task");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [x] Task");
    expect(press(view, "Enter", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("toggles distinct tasks at multiple cursors in one undo step", () => {
    const doc = "- [ ] One\n- [ ] Two";
    const view = createView(doc, EditorSelection.create([
      EditorSelection.cursor(doc.indexOf("One")),
      EditorSelection.cursor(doc.indexOf("Two")),
    ]));

    expect(press(view, "Enter", { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("- [x] One\n- [x] Two");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("converts a typed empty task shortcut and keeps source syntax", () => {
    const view = createView("[]", 2);
    const handler = view.state.facet(EditorView.inputHandler).find((candidate) =>
      candidate(view, 2, 2, " ", () => view.state.update({}))
    );

    expect(handler).toBeDefined();
    expect(view.state.doc.toString()).toBe("- [ ] ");
    expect(view.state.selection.main.head).toBe(6);
  });

  it("applies paragraph Enter to independent cursors in one history step", () => {
    const doc = "AlphaBeta GammaDelta";
    const view = createView(doc, EditorSelection.create([
      EditorSelection.cursor("Alpha".length),
      EditorSelection.cursor("AlphaBeta Gamma".length),
    ]));

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Alpha\n\nBeta Gamma\n\nDelta");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("applies Shift+Enter to a selection and keeps following text editable", () => {
    const doc = "First selectedSecond";
    const from = "First".length;
    const to = "First selected".length;
    const view = createView(doc, EditorSelection.create([EditorSelection.range(from, to)]));

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("First\\\nSecond");
    const position = view.state.selection.main.head;
    view.dispatch({
      changes: { from: position, insert: "Typed" },
      selection: EditorSelection.cursor(position + "Typed".length),
      userEvent: "input.type",
    });
    expect(view.state.doc.toString()).toBe("First\\\nTypedSecond");
    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("First\\\nTypeSecond");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("First\\\nSecond");
  });

  it("applies Shift+Enter to multiple paragraph cursors", () => {
    const doc = "FirstOne SecondTwo";
    const view = createView(doc, EditorSelection.create([
      EditorSelection.cursor("First".length),
      EditorSelection.cursor("FirstOne Second".length),
    ]));

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("First\\\nOne Second\\\nTwo");
  });

  it.each([
    ["fenced code", "```\nalpha\n```", "alpha"],
    ["frontmatter", "---\ntitle: Test\n---\nBody", "Test"],
    ["HTML", "<div>Alpha</div>\n\nBody", "Alpha"],
    ["block math", "$$\nalpha\n$$", "alpha"],
  ])("keeps Shift+Enter source behavior inside %s", (_label, doc, target) => {
    const position = doc.indexOf(target) + Math.floor(target.length / 2);
    const view = createView(doc, position);

    expect(press(view, "Enter", { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).not.toContain("\\\n");
    expect(view.state.doc.toString()).toContain("\n");
  });

  it("does not transform task input while read-only or composing", async () => {
    const readOnlyView = createView("[]", 2, false, undefined, true);
    const readOnlyHandlers = readOnlyView.state.facet(EditorView.inputHandler);
    expect(readOnlyHandlers.some((handler) =>
      handler(readOnlyView, 2, 2, " ", () => readOnlyView.state.update({}))
    )).toBe(false);
    expect(readOnlyView.state.doc.toString()).toBe("[]");

    const composingView = createView("[]", 2);
    composingView.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "",
    }));
    composingView.contentDOM.append("中");
    composingView.contentDOM.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "中",
      inputType: "insertCompositionText",
    }));
    await vi.waitFor(() => expect(composingView.composing).toBe(true));
    expect(composingView.composing).toBe(true);
    const composingHandlers = composingView.state.facet(EditorView.inputHandler);
    expect(composingHandlers.some((handler) =>
      handler(composingView, 2, 2, " ", () => composingView.state.update({}))
    )).toBe(false);
    expect(composingView.state.doc.toString()).toBe("[]中");
    composingView.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "",
    }));
  });

  it("recreates the Markdown task source and parser structure after editing", () => {
    const original = "- [ ] Task";
    const firstView = createView(original, original.indexOf("Task"));
    expect(press(firstView, "Enter", { ctrlKey: true })).toBe(true);
    const savedSource = firstView.state.doc.toString();
    const reopenedView = createView(savedSource, savedSource.length);

    expect(reopenedView.state.doc.toString()).toBe("- [x] Task");
    expect(topLevelNodeNames(reopenedView)).toEqual(topLevelNodeNames(firstView));
  });

  it("reopens authored hard breaks with the same Markdown structure", () => {
    const source = "First\\\nSecond";
    const firstView = createView(source, source.length);
    const reopenedView = createView(firstView.state.doc.toString(), source.length);

    expect(reopenedView.state.doc.toString()).toBe(source);
    expect(topLevelNodeNames(reopenedView)).toEqual(topLevelNodeNames(firstView));
  });

  it("protects later math blocks and ignores math-like text inside code", () => {
    const mathDoc = "Before\n\n$$\nalpha\n$$\n\n$$\nbeta\n$$\n\nAfter";
    const mathPosition = mathDoc.indexOf("beta") + 2;
    const mathView = createView(mathDoc, mathPosition);
    expect(press(mathView, "Enter", { shiftKey: true })).toBe(true);
    expect(mathView.state.doc.toString()).toBe(
      `${mathDoc.slice(0, mathPosition)}\n${mathDoc.slice(mathPosition)}`,
    );

    const codeDoc = "```\n$$\nalpha\n$$\n```";
    const codePosition = codeDoc.indexOf("alpha") + 2;
    const codeView = createView(codeDoc, codePosition);
    expect(press(codeView, "Enter", { shiftKey: true })).toBe(true);
    expect(codeView.state.doc.toString()).toBe(
      `${codeDoc.slice(0, codePosition)}\n${codeDoc.slice(codePosition)}`,
    );
  });
});
