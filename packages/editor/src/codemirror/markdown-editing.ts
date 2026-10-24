import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { isolateHistory } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Prec,
  type ChangeSpec,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { findCodeMirrorMathRanges } from "./math-preview.ts";
import { isInsidePreformattedBlock } from "./blank-lines.ts";
import { readCodeMirrorFrontmatter } from "./frontmatter-preview.ts";
import { defineMarkraPlugin } from "./plugin.ts";

const indentation = "  ";
const quotePrefixPattern = /^([\t ]*(?:>[\t ]*)+)/u;
const incompleteInlineDestinationPattern =
  /(?:^|[^\\])!?\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\n])*$/u;
const mathRangesByDocument = new WeakMap<
  EditorState["doc"],
  ReturnType<typeof findCodeMirrorMathRanges>
>();
const frontmatterRangesByDocument = new WeakMap<
  EditorState["doc"],
  ReturnType<typeof readCodeMirrorFrontmatter>
>();

const protectedMarkdownNodeNames = new Set([
  "FencedCode", "CodeBlock", "Table", "TableCell", "TableHeader",
  "HTMLBlock", "BlockMath", "MathBlock", "Mermaid", "Frontmatter",
]);

export function hasProtectedMarkdownInRange(
  state: EditorState,
  from: number,
  to: number,
) {
  let frontmatter = frontmatterRangesByDocument.get(state.doc);
  if (frontmatter === undefined) {
    frontmatter = readCodeMirrorFrontmatter(state.doc.toString());
    frontmatterRangesByDocument.set(state.doc, frontmatter);
  }
  if (frontmatter && frontmatter.from <= to && from <= frontmatter.to) return true;

  let mathRanges = mathRangesByDocument.get(state.doc);
  if (!mathRanges) {
    mathRanges = findCodeMirrorMathRanges(state);
    mathRangesByDocument.set(state.doc, mathRanges);
  }
  if (mathRanges.some((range) => range.from <= to && from <= range.to)) return true;

  let protectedBlock = false;
  (ensureSyntaxTree(state, to, 100) ?? syntaxTree(state)).iterate({
    enter(node) {
      if (
        protectedMarkdownNodeNames.has(node.name) &&
        node.from <= to && from <= node.to
      ) {
        protectedBlock = true;
        return false;
      }
    },
    from,
    to,
  });
  return protectedBlock || isInsidePreformattedBlock(state, from) ||
    isInsidePreformattedBlock(state, to);
}

function isEditable(view: EditorView) {
  return !view.state.facet(EditorState.readOnly);
}

function selectionEnd(state: EditorState, range: SelectionRange) {
  if (range.empty) return range.to;
  const line = state.doc.lineAt(range.to);
  return line.from === range.to ? Math.max(range.from, range.to - 1) : range.to;
}

function selectedLines(state: EditorState) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(selectionEnd(state, range)).number;
    for (let number = first; number <= last; number += 1) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right).map((number) =>
    state.doc.line(number));
}

function dispatchChanges(view: EditorView, changes: readonly ChangeSpec[]) {
  if (changes.length === 0) return false;
  const changeSet = view.state.changes(changes);
  const selection = EditorSelection.create(
    view.state.selection.ranges.map((range) =>
      EditorSelection.range(
        changeSet.mapPos(range.anchor, 1),
        changeSet.mapPos(range.head, 1),
      )),
    view.state.selection.mainIndex,
  );
  view.dispatch({
    changes: changeSet,
    selection,
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  view.focus();
  return true;
}

type MarkdownBlockNode = SyntaxNode;

function sameNode(left: MarkdownBlockNode | null, right: MarkdownBlockNode | null) {
  return left === right || Boolean(
    left && right && left.name === right.name && left.from === right.from &&
      left.to === right.to,
  );
}

function ancestor(node: SyntaxNode | null, names: readonly string[]) {
  for (let current = node; current; current = current.parent) {
    if (names.includes(current.name)) return current;
  }
  return null;
}

function listItemAt(view: EditorView, position: number) {
  const line = view.state.doc.lineAt(position);
  const leading = /^[\t ]*/u.exec(line.text)?.[0].length ?? 0;
  const target = Math.min(line.to, line.from + leading);
  const tree = ensureSyntaxTree(view.state, target, 100) ?? syntaxTree(view.state);
  return ancestor(tree.resolveInner(target, 1), ["ListItem"]);
}

function paragraphAt(view: EditorView, position: number) {
  const tree = ensureSyntaxTree(view.state, position, 100) ?? syntaxTree(view.state);
  const side = position === view.state.doc.length ? -1 : 1;
  return ancestor(tree.resolveInner(position, side), ["Paragraph"]);
}

function continueMarkdownList(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  const inList = listItemAt(view, position) ||
    /^[\t ]{0,3}(?:[-+*]|\d+[.)])(?:[\t ]+|$)/u.test(line.text);
  if (!inList || protectedMarkdownAt(view, position)) return false;
  return insertNewlineContinueMarkup(view);
}

function endEmptyListItem(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const range = view.state.selection.main;
  if (view.state.selection.ranges.length !== 1 || !range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  if (
    range.head !== line.to ||
    !/^[\t ]*(?:[-+*]|\d+[.)])[\t ]+$/u.test(line.text) ||
    isInsidePreformattedBlock(view.state, range.head)
  ) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: EditorSelection.cursor(line.from),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

function editableParagraphAt(view: EditorView, position: number) {
  const node = paragraphAt(view, position);
  if (node) return ancestor(node, ["ListItem", "Blockquote"]) ? null : node;
  const tree = ensureSyntaxTree(view.state, position, 100) ?? syntaxTree(view.state);
  const heading = ancestor(
    tree.resolveInner(position, position === view.state.doc.length ? -1 : 1),
    [
      "ATXHeading1",
      "ATXHeading2",
      "ATXHeading3",
      "ATXHeading4",
      "ATXHeading5",
      "ATXHeading6",
    ],
  );
  return heading && !ancestor(heading, ["ListItem", "Blockquote"]) ? heading : null;
}

function insertParagraphBreak(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const changesByPosition = new Map<number, ChangeSpec>();
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);
    if (range.empty && (line.text.length === 0 || range.head === line.from)) return false;
    if (
      protectedMarkdownAt(view, range.from) ||
      protectedMarkdownAt(view, range.to)
    ) return false;
    const block = editableParagraphAt(view, range.from);
    if (!block || !sameNode(block, editableParagraphAt(view, range.to))) return false;
    changesByPosition.set(range.from, { from: range.from, to: range.to, insert: "\n\n" });
  }
  if (changesByPosition.size === 0) return false;
  const changes = [...changesByPosition.values()];
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.create(
      view.state.selection.ranges.map((range) =>
        EditorSelection.cursor(changeSet.mapPos(range.from, -1) + 2)),
      view.state.selection.mainIndex,
    ),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

function insertMarkdownHardBreak(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const ranges = view.state.selection.ranges;
  if (ranges.some((range) =>
    protectedMarkdownAt(view, range.from) ||
    protectedMarkdownAt(view, range.to) ||
    editableParagraphAt(view, range.from)?.name !== "Paragraph" ||
    !sameNode(paragraphAt(view, range.from), paragraphAt(view, range.to))
  )) return false;
  const changesByPosition = new Map<number, ChangeSpec>();
  for (const range of ranges) {
    changesByPosition.set(range.from, {
      from: range.from,
      to: range.to,
      insert: "\\\n",
    });
  }
  const changes = [...changesByPosition.values()];
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.create(
      ranges.map((range) =>
        EditorSelection.cursor(changeSet.mapPos(range.from, -1) + 2)),
      view.state.selection.mainIndex,
    ),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

function toggleTaskAtCursor(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const changes = new Map<number, ChangeSpec>();
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);
    if (protectedMarkdownAt(view, line.from)) return false;
    const match = /^([\t ]*(?:[-+*]|\d+[.)])[\t ]+\[)( |x|X)(\])/u.exec(line.text);
    if (!match) return false;
    const from = line.from + match[1].length;
    changes.set(from, { from, to: from + 1, insert: match[2] === " " ? "x" : " " });
  }
  if (changes.size === 0) return false;
  view.dispatch({
    changes: [...changes.values()],
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

function taskListInput(view: EditorView, from: number, to: number, text: string) {
  if (!isEditable(view) || view.composing || text !== " ") return false;
  const line = view.state.doc.lineAt(from);
  if (to !== from || from !== line.to) return false;
  const before = line.text.slice(0, from - line.from);
  const match = /^([\t ]*)\[\]$/u.exec(before);
  if (!match || protectedMarkdownAt(view, from)) return false;
  const insertion = `${match[1]}- [ ] `;
  view.dispatch({
    changes: { from: line.from, to: from, insert: insertion },
    selection: EditorSelection.cursor(line.from + insertion.length),
    userEvent: "input",
  });
  return true;
}

function protectedMarkdownAt(view: EditorView, position: number) {
  if (isInsidePreformattedBlock(view.state, position)) return true;
  let mathRanges = mathRangesByDocument.get(view.state.doc);
  if (!mathRanges) {
    mathRanges = findCodeMirrorMathRanges(view.state);
    mathRangesByDocument.set(view.state.doc, mathRanges);
  }
  if (
    mathRanges.some((range) => position >= range.from && position <= range.to)
  ) return true;
  const tree = ensureSyntaxTree(view.state, position, 100) ?? syntaxTree(view.state);
  const node = tree.resolveInner(position, 1);
  return Boolean(ancestor(node, [
    "Blockquote",
    "FencedCode",
    "CodeBlock",
    "Table",
    "TableCell",
    "TableHeader",
    "HTMLBlock",
    "Frontmatter",
  ]));
}

function hasProtectedSelection(view: EditorView) {
  return selectedLines(view.state).some((line) =>
    protectedMarkdownAt(view, line.from)
  );
}

function previousListItem(item: MarkdownBlockNode) {
  let previous = item.prevSibling;
  while (previous && previous.name !== "ListItem") previous = previous.prevSibling;
  return previous;
}

function lastListItem(node: MarkdownBlockNode) {
  let found: MarkdownBlockNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListItem") found = child;
  }
  return found;
}

function listMarkerAt(view: EditorView, item: MarkdownBlockNode) {
  return /^([\t ]*)([-+*]|\d+[.)])([\t ]+)/u.exec(
    view.state.doc.lineAt(item.from).text,
  );
}

function contentIndent(view: EditorView, item: MarkdownBlockNode) {
  const line = view.state.doc.lineAt(item.from);
  const match = /^([\t ]*)(?:[-+*]|\d+[.)])([\t ]+)/u.exec(line.text);
  if (!match) return "  ";
  return " ".repeat(markdownColumnWidth(`${match[1]}${match[0].slice(match[1].length)}`));
}

function markdownColumnWidth(value: string) {
  let column = 0;
  for (const character of value) {
    column += character === "\t" ? 4 - column % 4 : 1;
  }
  return column;
}

function nodeLines(view: EditorView, node: MarkdownBlockNode) {
  const start = view.state.doc.lineAt(node.from).number;
  const end = view.state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
  const lines = [];
  for (let number = start; number <= end; number += 1) {
    const line = view.state.doc.line(number);
    if (line.from <= node.to) lines.push(line);
  }
  return lines;
}

function rootOutdentChanges(view: EditorView, item: MarkdownBlockNode) {
  const line = view.state.doc.lineAt(item.from);
  const marker = listMarkerAt(view, item);
  if (!marker) return [];
  const delta = markdownColumnWidth(marker[0]);
  const changes: ChangeSpec[] = [{
    from: line.from + marker[1].length,
    to: line.from + marker[0].length,
  }];
  if (line.number > 1 && view.state.doc.line(line.number - 1).text.length > 0) {
    changes.push({ from: line.from, insert: "\n" });
  }
  const lines = nodeLines(view, item);
  // A list-looking line inside code or a lazy paragraph is content, not a
  // child list. Only real list nodes need a new paragraph boundary here.
  const childListStarts = new Set<number>();
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === "BulletList" || child.name === "OrderedList") {
      childListStarts.add(view.state.doc.lineAt(child.from).from);
    }
  }
  for (const childLine of lines) {
    if (childLine.from === line.from) continue;
    const leading = /^[\t ]*/u.exec(childLine.text)?.[0] ?? "";
    let remove = 0;
    let columns = 0;
    while (remove < leading.length && columns < delta) {
      const width = leading[remove] === "\t" ? 4 - columns % 4 : 1;
      if (columns + width > delta) break;
      columns += width;
      remove += 1;
    }
    if (
      childListStarts.has(childLine.from) &&
      view.state.doc.line(childLine.number - 1).text.trim().length > 0
    ) {
      changes.push({
        from: childLine.from,
        to: childLine.from + remove,
        insert: "\n",
      });
    } else if (remove) {
      changes.push({ from: childLine.from, to: childLine.from + remove });
    }
  }
  return changes;
}

const protectedListDescendants = new Set([
  "FencedCode", "CodeBlock", "Table", "TableCell", "TableHeader",
  "HTMLBlock", "BlockMath", "MathBlock", "Mermaid", "Frontmatter",
]);

function hasProtectedListDescendant(view: EditorView, item: MarkdownBlockNode) {
  let protectedNode = false;
  const visit = (node: MarkdownBlockNode) => {
    if (protectedListDescendants.has(node.name)) {
      protectedNode = true;
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  for (let child = item.firstChild; child; child = child.nextSibling) visit(child);
  const linesContainProtectedContent = nodeLines(view, item).some((line) =>
    hasProtectedMarkdownInRange(view.state, line.from, line.to)
  );
  return protectedNode || linesContainProtectedContent;
}

/**
 * Remove only complete root list items, using the same source-aware handling
 * as Shift+Tab. Returns null when the selection is not a list, false when a
 * list selection cannot be safely unwrapped, and true after a successful edit.
 */
export function unwrapRootListSelection(view: EditorView): boolean | null {
  if (!isEditable(view) || view.composing) return false;
  const items = selectedListItems(view);
  if (items.length === 0) return null;
  if (view.state.selection.ranges.length !== 1) return false;

  const range = view.state.selection.main;
  const first = items[0]!;
  const last = items.at(-1)!;
  const firstLine = view.state.doc.lineAt(first.from);
  const lastLine = view.state.doc.lineAt(Math.max(last.from, last.to - 1));
  if (
    range.empty || range.from !== firstLine.from || range.to !== lastLine.to ||
    items.some((item) => ancestor(item.parent, ["ListItem"]) || hasProtectedListDescendant(view, item))
  ) return false;

  for (const line of selectedLines(view.state)) {
    const belongsToSelectedItem = items.some((item) =>
      item.from <= line.from && item.to >= line.to
    );
    if (!belongsToSelectedItem) return false;
  }

  const changes = items.flatMap((item) => rootOutdentChanges(view, item));
  return dispatchWithSelection(view, changes);
}

function indentNodeChanges(view: EditorView, node: MarkdownBlockNode, delta: number) {
  const changes: ChangeSpec[] = [];
  for (const line of nodeLines(view, node)) {
    if (delta > 0) {
      changes.push({ from: line.from, insert: " ".repeat(delta) });
      continue;
    }
    const match = /^[\t ]*/u.exec(line.text)?.[0] ?? "";
    let remove = 0;
    let columns = 0;
    while (remove < match.length && columns < -delta) {
      const next = match[remove] === "\t" ? 4 - columns % 4 : 1;
      if (columns + next > -delta) break;
      columns += next;
      remove += 1;
    }
    if (remove) changes.push({ from: line.from, to: line.from + remove });
  }
  return changes;
}

function paragraphListChanges(
  view: EditorView,
  paragraph: MarkdownBlockNode,
  prefix: string,
  continuation: string,
) {
  const changes: ChangeSpec[] = [];
  const lines = nodeLines(view, paragraph);
  lines.forEach((line, index) => {
    const leading = /^[\t ]*/u.exec(line.text)?.[0] ?? "";
    const trim = index === 0 ? Math.min(3, leading.length) : leading.length;
    changes.push({
      from: line.from,
      to: line.from + trim,
      insert: index === 0 ? prefix : continuation,
    });
  });
  return changes;
}

function dispatchWithSelection(view: EditorView, changes: readonly ChangeSpec[], selectionPosition?: number) {
  if (changes.length === 0) return false;
  const changeSet = view.state.changes(changes);
  const selection = selectionPosition === undefined
    ? EditorSelection.create(
      view.state.selection.ranges.map((range) =>
        EditorSelection.range(
          changeSet.mapPos(range.anchor, 1),
          changeSet.mapPos(range.head, 1),
        )),
      view.state.selection.mainIndex,
    )
    : EditorSelection.cursor(selectionPosition);
  view.dispatch({
    changes: changeSet,
    selection,
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  view.focus();
  return true;
}

function replaceDocument(view: EditorView, next: string, cursor: number) {
  const current = view.state.doc.toString();
  if (current === next) return false;
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from += 1;
  let currentTo = current.length;
  let nextTo = next.length;
  while (currentTo > from && nextTo > from && current[currentTo - 1] === next[nextTo - 1]) {
    currentTo -= 1;
    nextTo -= 1;
  }
  view.dispatch({
    changes: { from, to: currentTo, insert: next.slice(from, nextTo) },
    selection: EditorSelection.cursor(cursor),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
  });
  view.focus();
  return true;
}

function outdentListItem(view: EditorView, item: MarkdownBlockNode) {
  const parentItem = ancestor(item.parent, ["ListItem"]);
  if (!parentItem) {
    return dispatchWithSelection(view, rootOutdentChanges(view, item));
  }

  const document = view.state.doc.toString();
  const itemFrom = view.state.doc.lineAt(item.from).from;
  const parentMarker = listMarkerAt(view, parentItem);
  if (!parentMarker) return false;
  const parentTo = parentItem.to;
  const nodeEnd = view.state.doc.lineAt(Math.max(item.from, item.to - 1)).to;
  let itemTo = nodeEnd;
  if (document[itemTo] === "\n" && itemTo < parentTo) itemTo += 1;
  let source = document.slice(itemFrom, nodeEnd);
  const currentIndent = /^[\t ]*/u.exec(view.state.doc.lineAt(item.from).text)?.[0] ?? "";
  const delta = markdownColumnWidth(currentIndent) - markdownColumnWidth(parentMarker[1]);
  if (delta <= 0) return false;
  source = source.split("\n").map((line) => {
    const leading = /^[\t ]*/u.exec(line)?.[0] ?? "";
    let remove = 0;
    let columns = 0;
    while (remove < leading.length && columns < delta) {
      const width = leading[remove] === "\t" ? 4 - columns % 4 : 1;
      if (columns + width > delta) break;
      columns += width;
      remove += 1;
    }
    return line.slice(remove);
  }).join("\n");
  const without = document.slice(0, itemFrom) + document.slice(itemTo);
  const target = parentItem.to - (itemTo - itemFrom);
  const left = without.slice(0, target);
  const right = without.slice(target);
  const prefix = left.length > 0 && !left.endsWith("\n") ? "\n" : "";
  const insertedFrom = left.length + prefix.length;
  const next = `${left}${prefix}${source}${right.startsWith("\n") || right.length === 0 ? "" : "\n"}${right}`;
  if (next === document) return true;
  return replaceDocument(
    view,
    next,
    insertedFrom + parentMarker[1].length + parentMarker[2].length + parentMarker[3].length,
  );
}

function indentListItem(view: EditorView, item: MarkdownBlockNode) {
  const previous = previousListItem(item);
  if (!previous) return true;
  const currentIndent = /^[\t ]*/u.exec(view.state.doc.lineAt(item.from).text)?.[0] ?? "";
  const delta = markdownColumnWidth(contentIndent(view, previous)) - markdownColumnWidth(currentIndent);
  if (delta <= 0) return true;
  return dispatchWithSelection(view, indentNodeChanges(view, item, delta));
}

function selectedListItems(view: EditorView) {
  const items = new Map<number, MarkdownBlockNode>();
  for (const line of selectedLines(view.state)) {
    const item = listItemAt(view, line.from);
    if (item) items.set(item.from, item);
  }
  const candidates = [...items.values()].sort((left, right) => left.from - right.from);
  return candidates.filter((item) => {
    const parent = ancestor(item.parent, ["ListItem"]);
    return !parent || !items.has(parent.from);
  });
}

function selectedSiblingGroups(items: readonly MarkdownBlockNode[]) {
  const groups: MarkdownBlockNode[][] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && sameNode(group[group.length - 1] ?? null, previousListItem(item))) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function reindentText(value: string, delta: number) {
  return value.split("\n").map((line) => {
    if (delta === 0) return line;
    if (delta > 0) return `${" ".repeat(delta)}${line}`;
    const leading = /^[\t ]*/u.exec(line)?.[0] ?? "";
    let remove = 0;
    let columns = 0;
    while (remove < leading.length && columns < -delta) {
      const width = leading[remove] === "\t" ? 4 - columns % 4 : 1;
      if (columns + width > -delta) break;
      columns += width;
      remove += 1;
    }
    return line.slice(remove);
  }).join("\n");
}

function outdentSelectedListItems(view: EditorView, items: readonly MarkdownBlockNode[]) {
  const parents = items.map((item) => ancestor(item.parent, ["ListItem"]));
  if (parents.every((parent) => parent === null)) {
    const changes: ChangeSpec[] = [];
    for (const item of items) {
      changes.push(...rootOutdentChanges(view, item));
    }
    return changes.length > 0 ? dispatchWithSelection(view, changes) : true;
  }
  const parent = parents[0];
  if (!parent || parents.some((value) => !sameNode(value, parent))) return true;

  const document = view.state.doc.toString();
  const parentIndent = /^[\t ]*/u.exec(view.state.doc.lineAt(parent.from).text)?.[0] ?? "";
  const sourceBlocks: Array<{ from: number; to: number; text: string }> = [];
  for (const item of items) {
    const from = view.state.doc.lineAt(item.from).from;
    const nodeEnd = view.state.doc.lineAt(Math.max(item.from, item.to - 1)).to;
    let to = nodeEnd;
    if (document[to] === "\n" && to < parent.to) to += 1;
    const itemIndent = /^[\t ]*/u.exec(view.state.doc.lineAt(item.from).text)?.[0] ?? "";
    sourceBlocks.push({
      from,
      to,
      text: reindentText(document.slice(from, nodeEnd), markdownColumnWidth(parentIndent) - markdownColumnWidth(itemIndent)),
    });
  }
  const removed = [...sourceBlocks].sort((left, right) => right.from - left.from);
  let without = document;
  for (const block of removed) without = without.slice(0, block.from) + without.slice(block.to);
  const removedBeforeTarget = sourceBlocks.reduce((total, block) => total + block.to - block.from, 0);
  const target = parent.to - removedBeforeTarget;
  const left = without.slice(0, target);
  const right = without.slice(target);
  const moved = sourceBlocks.map((block) => block.text).join("\n");
  const prefix = left.length > 0 && !left.endsWith("\n") ? "\n" : "";
  const suffix = right.startsWith("\n") || right.length === 0 ? "" : "\n";
  const insertedFrom = left.length + prefix.length;
  const next = `${left}${prefix}${moved}${suffix}${right}`;
  const marker = listMarkerAt(view, items[0]!);
  const markerOffset = parentIndent.length + (marker?.[2].length ?? 1) + (marker?.[3].length ?? 1);
  return replaceDocument(view, next, insertedFrom + markerOffset);
}

function indentSelectedListItems(view: EditorView, outdent: boolean) {
  const items = selectedListItems(view);
  if (items.length === 0) return false;
  if (items.length === 1) {
    return outdent ? outdentListItem(view, items[0]!) : indentListItem(view, items[0]!);
  }
  if (outdent) return outdentSelectedListItems(view, items);
  const changes: ChangeSpec[] = [];
  for (const group of selectedSiblingGroups(items)) {
    const first = group[0]!;
    const previous = previousListItem(first);
    if (!previous) continue;
    const firstIndent = /^[\t ]*/u.exec(view.state.doc.lineAt(first.from).text)?.[0] ?? "";
    const delta = markdownColumnWidth(contentIndent(view, previous)) - markdownColumnWidth(firstIndent);
    if (delta <= 0) continue;
    for (const item of group) changes.push(...indentNodeChanges(view, item, delta));
  }
  if (changes.length === 0) return true;
  return dispatchWithSelection(view, changes);
}

function tabParagraph(view: EditorView, paragraph: MarkdownBlockNode) {
  const tree = (ensureSyntaxTree(view.state, paragraph.to, 100) ?? syntaxTree(view.state)).topNode;
  let previous: MarkdownBlockNode | null = paragraph.prevSibling;
  if (!previous) {
    let current = tree.firstChild;
    while (current && current.from !== paragraph.from) {
      if (["Paragraph", "BulletList", "OrderedList"].includes(current.name)) previous = current;
      current = current.nextSibling;
    }
  }

  if (previous?.name === "Paragraph") {
    const parentPrefix = "- ";
    const parentChanges = paragraphListChanges(view, previous, parentPrefix, "  ");
    const currentChanges = paragraphListChanges(view, paragraph, "  - ", "    ");
    return dispatchWithSelection(view, [...parentChanges, ...currentChanges]);
  }
  const parentItem = previous && ["BulletList", "OrderedList"].includes(previous.name)
    ? lastListItem(previous)
    : null;
  const prefix = parentItem ? `${contentIndent(view, parentItem)}- ` : "- ";
  const continuation = " ".repeat(markdownColumnWidth(prefix));
  return dispatchWithSelection(view, paragraphListChanges(view, paragraph, prefix, continuation));
}

function handleTab(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const range = view.state.selection.main;
  if (!range.empty || view.state.selection.ranges.length > 1) {
    if (hasProtectedSelection(view)) return insertPlainIndentation(view);
    const items = selectedListItems(view);
    if (items.length > 0) return indentSelectedListItems(view, false);
    const paragraphs = new Map<number, MarkdownBlockNode>();
    for (const selection of view.state.selection.ranges) {
      const paragraph = paragraphAt(view, selection.from);
      if (paragraph && sameNode(paragraphAt(view, selection.to), paragraph)) {
        paragraphs.set(paragraph.from, paragraph);
      }
    }
    if (paragraphs.size === 1) return tabParagraph(view, [...paragraphs.values()][0]!);
    return insertPlainIndentation(view);
  }
  if (protectedMarkdownAt(view, range.head)) return insertPlainIndentation(view);
  const item = listItemAt(view, range.head);
  if (item) return indentListItem(view, item);
  const paragraph = paragraphAt(view, range.head);
  if (paragraph) return tabParagraph(view, paragraph);
  return insertPlainIndentation(view);
}

function handleShiftTab(view: EditorView) {
  if (!isEditable(view) || view.composing) return false;
  const range = view.state.selection.main;
  if (!range.empty || view.state.selection.ranges.length > 1) {
    if (hasProtectedSelection(view)) return false;
    return indentSelectedListItems(view, true);
  }
  if (protectedMarkdownAt(view, range.head)) return false;
  const item = listItemAt(view, range.head);
  if (item) return outdentListItem(view, item);
  return false;
}

function insertPlainIndentation(view: EditorView) {
  if (!isEditable(view)) return false;
  const changes = view.state.selection.ranges.map((range) => ({
    from: range.to,
    insert: indentation,
  }));
  return dispatchChanges(view, changes);
}

function selectTripleClickedLine(view: EditorView, event: MouseEvent) {
  if (event.button !== 0 || event.detail < 3) return null;

  const clickedPosition = view.posAtCoords({
    x: event.clientX,
    y: event.clientY,
  });
  if (clickedPosition === null) return null;
  let start = clickedPosition;
  let startSelection = view.state.selection;

  return {
    get(currentEvent: MouseEvent, extend: boolean, multiple: boolean) {
      const head = view.posAtCoords({
        x: currentEvent.clientX,
        y: currentEvent.clientY,
      });
      if (head === null) return startSelection;

      const anchor = extend ? startSelection.main.anchor : start;
      const anchorLine = view.state.doc.lineAt(anchor);
      const headLine = view.state.doc.lineAt(head);
      // CodeMirror includes the trailing line break in triple-click selections.
      // Leave it outside the visual-editor selection so replacement cannot
      // merge lines.
      const range = head >= anchor
        ? EditorSelection.range(anchorLine.from, headLine.to)
        : EditorSelection.range(anchorLine.to, headLine.from);
      return multiple
        ? startSelection.addRange(range)
        : EditorSelection.create([range]);
    },
    update(update: ViewUpdate) {
      start = update.changes.mapPos(start);
      startSelection = startSelection.map(update.changes);
    },
  };
}

function selectLinesWithoutTrailingBreak(view: EditorView) {
  const blocks: Array<{ from: number; to: number }> = [];
  let coveredThroughLine = -1;

  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from);
    let endLine = view.state.doc.lineAt(range.to);
    if (!range.empty && range.to === endLine.from) {
      endLine = view.state.doc.lineAt(range.to - 1);
    }

    if (coveredThroughLine >= startLine.number) {
      // Adjacent line selections would touch across their shared line break,
      // so keep them in one valid CodeMirror selection range.
      const previous = blocks[blocks.length - 1];
      if (previous) previous.to = Math.max(previous.to, endLine.to);
    } else {
      blocks.push({ from: startLine.from, to: endLine.to });
    }
    coveredThroughLine = Math.max(coveredThroughLine, endLine.number + 1);
  }

  view.dispatch({
    selection: EditorSelection.create(
      blocks.map(({ from, to }) => EditorSelection.range(from, to)),
    ),
    userEvent: "select",
  });
  return true;
}

function keepJoinedLineCaretsAfterText(transaction: Transaction) {
  if (!transaction.docChanged || !transaction.isUserEvent("delete.backward")) {
    return transaction;
  }

  const affectedPositions = new Set<number>();
  for (const range of transaction.startState.selection.ranges) {
    if (!range.empty) continue;
    if (range.head === 0) {
      if (
        transaction.startState.doc.lines > 1 &&
        transaction.startState.doc.line(1).length === 0
      ) {
        affectedPositions.add(0);
      }
      continue;
    }
    const line = transaction.startState.doc.lineAt(range.head);
    if (
      line.from === range.head &&
      transaction.startState.doc.lineAt(range.head - 1).length === 0
    ) {
      affectedPositions.add(transaction.changes.mapPos(range.head, -1));
    }
  }
  if (affectedPositions.size === 0) return transaction;

  let corrected = false;
  const selection = EditorSelection.create(
    transaction.newSelection.ranges.map((range) => {
      if (
        range.empty &&
        range.assoc !== 1 &&
        affectedPositions.has(range.head)
      ) {
        corrected = true;
        return EditorSelection.cursor(
          range.head,
          1,
          range.bidiLevel ?? undefined,
          range.goalColumn ?? undefined,
        );
      }
      return range;
    }),
    transaction.newSelection.mainIndex,
  );
  if (!corrected) return transaction;

  // Apply affinity in the deleting transaction. A later selection-only
  // update is treated as an equivalent DOM boundary beside inline widgets.
  return [
    transaction,
    {
      selection,
      sequential: true,
    },
  ];
}

function removeLeadingEmptyLineBackward(view: EditorView) {
  if (!isEditable(view)) return false;
  const { ranges } = view.state.selection;
  if (
    ranges.length !== 1 ||
    !ranges[0]?.empty ||
    ranges[0].head !== 0 ||
    view.state.doc.lines === 1 ||
    view.state.doc.line(1).length !== 0
  ) {
    return false;
  }

  view.dispatch({
    changes: { from: 0, to: 1 },
    selection: EditorSelection.cursor(0, 1),
    userEvent: "delete.backward",
  });
  return true;
}

function confirmIncompleteInlineDestination(view: EditorView) {
  if (!isEditable(view)) return false;
  const { ranges } = view.state.selection;
  if (ranges.length !== 1 || !ranges[0]?.empty) return false;

  const position = ranges[0].head;
  const line = view.state.doc.lineAt(position);
  if (position !== line.to) return false;
  const sourceBeforeCursor = view.state.sliceDoc(line.from, position);
  if (!incompleteInlineDestinationPattern.test(sourceBeforeCursor)) {
    return false;
  }

  // Enter confirms the destination instead of placing a line break inside
  // Markdown link syntax, which would leave both links and images unparseable.
  view.dispatch({
    changes: { from: position, insert: ")\n" },
    selection: EditorSelection.cursor(position + 2),
    userEvent: "input",
  });
  return true;
}

function insideTableCell(view: EditorView, position: number) {
  let node: ReturnType<typeof syntaxTree>["topNode"] | null =
    syntaxTree(view.state).resolveInner(position, -1);
  while (node) {
    if (node.name === "TableCell" || node.name === "TableHeader") return true;
    node = node.parent;
  }
  return false;
}

function insertContextualHardBreak(view: EditorView) {
  if (!isEditable(view)) return false;
  const range = view.state.selection.main;
  if (!range.empty) return false;

  if (insideTableCell(view, range.head)) {
    view.dispatch({
      changes: { from: range.head, insert: "<br>" },
      selection: EditorSelection.cursor(range.head + 4),
      userEvent: "input",
    });
    return true;
  }

  const line = view.state.doc.lineAt(range.head);
  const quotePrefix = quotePrefixPattern.exec(line.text)?.[1];
  if (!quotePrefix) return false;
  const inserted = `\n${quotePrefix}`;
  view.dispatch({
    changes: { from: range.head, insert: inserted },
    selection: EditorSelection.cursor(range.head + inserted.length),
    userEvent: "input",
  });
  return true;
}

export function markdownEditingPlugin() {
  return defineMarkraPlugin({
    id: "markra.markdown-editing",
    extension: [
      EditorView.mouseSelectionStyle.of(selectTripleClickedLine),
      EditorView.inputHandler.of(taskListInput),
      EditorState.transactionFilter.of(keepJoinedLineCaretsAfterText),
      Prec.highest(keymap.of([
        { key: "Enter", run: endEmptyListItem },
      ])),
      Prec.high(keymap.of([
        { key: "Backspace", run: removeLeadingEmptyLineBackward },
        {
          key: "Enter",
          run: confirmIncompleteInlineDestination,
        },
        {
          key: "Enter",
          run(view) {
            return continueMarkdownList(view) || insertParagraphBreak(view);
          },
        },
        { key: "Ctrl-Enter", run: toggleTaskAtCursor },
        {
          key: "Alt-l",
          mac: "Ctrl-l",
          run: selectLinesWithoutTrailingBreak,
        },
        { key: "Tab", run: handleTab, shift: handleShiftTab },
        {
          key: "Shift-Enter",
          run(view) {
            return insertContextualHardBreak(view) || insertMarkdownHardBreak(view);
          },
        },
      ])),
    ],
  });
}
