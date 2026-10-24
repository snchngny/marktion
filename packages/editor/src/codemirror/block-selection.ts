import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { EditorSelection, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { moveCodeMirrorBlock, readCodeMirrorBlockRanges } from "./block-drag.ts";
import type { CodeMirrorBlockRange } from "./block-drag.ts";
import { isInsidePreformattedBlock } from "./blank-lines.ts";
import { defineMarkraPlugin, runMarkraCommand } from "./plugin.ts";
import { getMarkraSlashMenuState } from "./slash-menu.ts";

type SelectionMode = "block" | "document" | "none";

const setBlockSelection = StateEffect.define<SelectionMode>();

const blockSelectionField = StateField.define<SelectionMode>({
  create: () => "none",
  update(active, transaction) {
    const effect = transaction.effects.find((candidate) => candidate.is(setBlockSelection));
    if (effect) return effect.value;
    if (transaction.docChanged || transaction.selection !== undefined) return "none";
    return active;
  },
});

function editable(view: EditorView) {
  return !view.state.facet(EditorState.readOnly) && !view.composing;
}

function atomicBlocks(view: EditorView) {
  return readCodeMirrorBlockRanges(view.state).filter((range) =>
    range.name !== "EmptyLine" && range.name !== "BulletList" &&
    range.name !== "OrderedList"
  );
}

function protectedBlock(block: CodeMirrorBlockRange) {
  return /^Frontmatter|^(?:FencedCode|CodeBlock|Table|HTMLBlock|BlockMath|Mermaid)/u.test(block.name);
}

function blockAt(view: EditorView, position: number) {
  return atomicBlocks(view)
    .filter((block) => block.from <= position && position <= block.to)
    .sort((left, right) => (left.to - left.from) - (right.to - right.from))[0] ?? null;
}

function blocksWithinSelection(view: EditorView) {
  const selection = view.state.selection.main;
  if (selection.empty || view.state.selection.ranges.length !== 1) return [];
  const candidates = atomicBlocks(view).filter((block) =>
    block.from >= selection.from && block.to <= selection.to
  );
  return candidates.filter((block) => !candidates.some((other) =>
    other !== block && other.from <= block.from && other.to >= block.to &&
    (other.from < block.from || other.to > block.to)
  ));
}

function listContainer(view: EditorView, block: CodeMirrorBlockRange) {
  if (block.name !== "ListItem") return null;
  let node: SyntaxNode | null = syntaxTree(view.state).resolve(block.from, 1);
  while (node && node.name !== "BulletList" && node.name !== "OrderedList") {
    node = node.parent;
  }
  return node ? `${node.name}:${node.from}:${node.to}` : null;
}

function sameListSiblings(
  view: EditorView,
  left: CodeMirrorBlockRange,
  right: CodeMirrorBlockRange,
) {
  return left.name === "ListItem" && right.name === "ListItem" &&
    left.depth === right.depth && listContainer(view, left) === listContainer(view, right) &&
    listContainer(view, left) !== null;
}

function adjacentBlock(
  view: EditorView,
  selected: readonly CodeMirrorBlockRange[],
  direction: -1 | 1,
) {
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const all = atomicBlocks(view);
  if (selected.every((block) => block.name === "ListItem" && sameListSiblings(view, first, block))) {
    const siblings = all.filter((block) => sameListSiblings(view, first, block));
    const edge = direction < 0 ? first : last;
    const index = siblings.findIndex((block) => block.from === edge.from);
    return direction < 0 ? siblings[index - 1] ?? null : siblings[index + 1] ?? null;
  }
  const candidates = all.filter((block) => direction < 0
    ? block.to <= first.from
    : block.from >= last.to);
  return direction < 0
    ? candidates.sort((left, right) => right.to - left.to)[0] ?? null
    : candidates.sort((left, right) => left.from - right.from)[0] ?? null;
}

function setSelection(view: EditorView, blocks: readonly CodeMirrorBlockRange[], active = true) {
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) return false;
  view.dispatch({
    effects: setBlockSelection.of(active ? "block" : "none"),
    selection: EditorSelection.range(first.from, last.to),
    userEvent: "select",
  });
  return true;
}

function selectCurrentBlock(view: EditorView) {
  const selection = view.state.selection;
  if (!editable(view) || selection.ranges.length !== 1 || !selection.main.empty) return false;
  if (isInsidePreformattedBlock(view.state, selection.main.head)) return false;
  const block = blockAt(view, selection.main.head);
  if (!block || protectedBlock(block)) return false;
  return setSelection(view, [block]);
}

function escapeBlockSelection(view: EditorView) {
  if (getMarkraSlashMenuState(view).open) return false;
  const mode = view.state.field(blockSelectionField, false);
  if (mode === "block" || mode === "document") {
    const from = view.state.selection.main.from;
    view.dispatch({
      effects: setBlockSelection.of("none"),
      selection: EditorSelection.cursor(from),
      userEvent: "select",
    });
    return true;
  }
  return selectCurrentBlock(view);
}

function enterBlockSelection(view: EditorView) {
  if (getMarkraSlashMenuState(view).open || view.state.field(blockSelectionField, false) !== "block") return false;
  const from = view.state.selection.main.from;
  view.dispatch({
    effects: setBlockSelection.of("none"),
    selection: EditorSelection.cursor(from),
    userEvent: "select",
  });
  return true;
}

function selectAll(view: EditorView) {
  const mode = view.state.field(blockSelectionField, false);
  if (mode === "block") {
    view.dispatch({
      effects: setBlockSelection.of("document"),
      selection: EditorSelection.single(0, view.state.doc.length),
      userEvent: "select",
    });
    return true;
  }
  if (mode === "document") return true;
  return selectCurrentBlock(view);
}

function extendBlockSelection(view: EditorView, direction: -1 | 1) {
  if (view.state.field(blockSelectionField, false) !== "block") return false;
  const selected = blocksWithinSelection(view);
  if (!selected.length) return false;
  const next = adjacentBlock(view, selected, direction);
  if (!next || protectedBlock(next)) return false;
  return setSelection(view, direction < 0 ? [next, ...selected] : [...selected, next]);
}

function deleteSelectedBlocks(view: EditorView) {
  if (!editable(view) || view.state.field(blockSelectionField, false) !== "block") return false;
  const selected = blocksWithinSelection(view);
  if (!selected.length) return false;
  if (selected.some(protectedBlock)) return false;
  const first = selected[0]!;
  const last = selected.at(-1)!;
  let from = first.from;
  let to = last.to;
  const prefix = view.state.sliceDoc(0, from);
  const hasPreviousContent = /\S/u.test(prefix);
  const precedingNewlines = /(?:\r?\n)+$/u.exec(prefix)?.[0];
  const precedingParts = precedingNewlines?.match(/\r?\n/gu) ?? [];
  const suffix = view.state.sliceDoc(to);
  const followingNewlines = /^(?:\r?\n)+/u.exec(suffix)?.[0];
  if (followingNewlines) {
    const followingParts = followingNewlines.match(/\r?\n/gu) ?? [];
    const consumeCount = hasPreviousContent
      ? Math.min(followingParts.length, Math.min(precedingParts.length, 2))
      : Math.min(followingParts.length, 2);
    to += followingParts.slice(0, consumeCount).join("").length;
  } else if (precedingParts.length > 0) {
    from -= precedingParts.slice(-2).join("").length;
  }
  view.dispatch({
    changes: { from, to },
    annotations: isolateHistory.of("full"),
    effects: setBlockSelection.of("none"),
    selection: EditorSelection.cursor(from),
    userEvent: "delete",
  });
  return true;
}

function duplicateSelectedBlocks(view: EditorView) {
  if (!editable(view) || view.state.field(blockSelectionField, false) !== "block") return false;
  const selected = blocksWithinSelection(view);
  if (!selected.length || selected.some(protectedBlock)) return false;
  const first = selected[0]!;
  const last = selected.at(-1)!;
  const markdown = view.state.sliceDoc(first.from, last.to);
  const listGroup = selected.every((block) => block.name === "ListItem" && block.depth === first.depth);
  const separator = listGroup ? "\n" : "\n\n";
  const from = last.to;
  const insert = `${separator}${markdown}`;
  view.dispatch({
    changes: { from, insert },
    annotations: isolateHistory.of("full"),
    effects: setBlockSelection.of("block"),
    selection: EditorSelection.range(from + separator.length, from + insert.length),
    userEvent: "input",
  });
  return true;
}

function moveSelectedBlocks(view: EditorView, direction: -1 | 1) {
  if (!editable(view) || view.state.field(blockSelectionField, false) !== "block") return false;
  const selected = blocksWithinSelection(view);
  if (!selected.length || selected.some(protectedBlock)) return false;
  const target = adjacentBlock(view, selected, direction);
  if (!target || protectedBlock(target)) return false;

  if (selected.length === 1) {
    const source = selected[0]!;
    view.dispatch({ annotations: isolateHistory.of("before") });
    const moved = moveCodeMirrorBlock(
      view,
      source.from,
      target.from,
      direction < 0 ? "before" : "after",
      source.depth,
    );
    if (!moved) {
      view.dispatch({ annotations: isolateHistory.of("after") });
      return false;
    }
    view.dispatch({ annotations: isolateHistory.of("after") });
    const current = blockAt(view, view.state.selection.main.head);
    if (current && !protectedBlock(current)) setSelection(view, [current]);
    return true;
  }

  if (selected.some((block) => block.depth !== selected[0]?.depth)) return false;
  if (selected[0]?.name === "ListItem" &&
    selected.some((block) => !sameListSiblings(view, selected[0]!, block))) return false;
  const state = view.state;
  const first = selected[0]!;
  const last = selected.at(-1)!;
  const selectedMarkdown = state.sliceDoc(first.from, last.to);
  const targetMarkdown = state.sliceDoc(target.from, target.to);
  const sourceIsList = first.name === "ListItem";
  if (sourceIsList !== (target.name === "ListItem")) return false;

  let from: number;
  let to: number;
  let insert: string;
  let movedFrom: number;
  if (direction < 0) {
    const separator = state.sliceDoc(target.to, first.from);
    from = target.from;
    to = last.to;
    insert = `${selectedMarkdown}${separator}${targetMarkdown}`;
    movedFrom = from;
  } else {
    const separator = state.sliceDoc(last.to, target.from);
    from = first.from;
    to = target.to;
    insert = `${targetMarkdown}${separator}${selectedMarkdown}`;
    movedFrom = from + targetMarkdown.length + separator.length;
  }
  const change = state.changes({ from, to, insert });
  view.dispatch({
    changes: change,
    annotations: isolateHistory.of("full"),
    effects: setBlockSelection.of("block"),
    selection: EditorSelection.range(movedFrom, movedFrom + selectedMarkdown.length),
    userEvent: "move",
  });
  return true;
}

function toggleTaskList(view: EditorView) {
  if (!editable(view)) return false;
  const keepBlockSelection = view.state.field(blockSelectionField, false) === "block";
  const selection = view.state.selection.main;
  if (isInsidePreformattedBlock(view.state, selection.head)) return false;
  const selected = keepBlockSelection ? blocksWithinSelection(view) : [blockAt(view, selection.head)].filter(
    (block): block is CodeMirrorBlockRange => block !== null,
  );
  if (selected.some(protectedBlock)) return false;
  if (!runMarkraCommand(view, "block.task-list")) return false;
  if (keepBlockSelection) view.dispatch({ effects: setBlockSelection.of("block") });
  return true;
}

export function blockSelectionPlugin() {
  return defineMarkraPlugin({
    id: "markra.block-selection",
    extension: [
      blockSelectionField,
      Prec.highest(keymap.of([
      { key: "Escape", run: escapeBlockSelection },
      { key: "Enter", run: enterBlockSelection },
      { key: "Mod-a", run: selectAll },
      { key: "Shift-ArrowUp", run: (view) => extendBlockSelection(view, -1) },
      { key: "Shift-ArrowDown", run: (view) => extendBlockSelection(view, 1) },
      { key: "Mod-d", run: duplicateSelectedBlocks },
      { key: "Mod-Shift-4", run: toggleTaskList },
      { key: "Backspace", run: deleteSelectedBlocks },
      { key: "Delete", run: deleteSelectedBlocks },
      { key: "Mod-Shift-ArrowUp", run: (view) => moveSelectedBlocks(view, -1) },
      { key: "Mod-Shift-ArrowDown", run: (view) => moveSelectedBlocks(view, 1) },
      ])),
    ],
  });
}
