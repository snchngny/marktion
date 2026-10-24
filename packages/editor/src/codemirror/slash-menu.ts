import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { history, isolateHistory } from "@codemirror/commands";
import { hasProtectedMarkdownInRange } from "./markdown-editing.ts";
import {
  Annotation,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import {
  runMarkraCommand,
  searchMarkraUi,
  type MarkraUiAction,
} from "./plugin.ts";

export type MarkraSlashMenuSource = "block-selection" | "typed" | "virtual";

export interface MarkraSlashMenuState {
  readonly actions: readonly MarkraUiAction[];
  readonly from: number | null;
  readonly open: boolean;
  readonly query: string;
  readonly selectedIndex: number;
  readonly source: MarkraSlashMenuSource | null;
  readonly to: number | null;
}

interface SlashMenuRange {
  deleteFrom: number;
  from: number;
  query: string;
  source: MarkraSlashMenuSource;
  to: number;
}

interface SuppressedRange {
  from: number;
  to: number;
}

interface InternalSlashMenuState {
  active: SlashMenuRange | null;
  selectedIndex: number;
  suppressed: SuppressedRange | null;
}

type SlashMenuEffect =
  | { type: "close" }
  | { source: "block-selection" | "virtual"; type: "open" }
  | { index: number; type: "select" };

interface SyntaxNodeLike {
  name: string;
  parent: SyntaxNodeLike | null;
}

const updateSlashMenu = StateEffect.define<SlashMenuEffect>();
const setSlashHistoryPending = StateEffect.define<boolean>();
const slashHistoryPart = Annotation.define<boolean>();
const slashHistoryUserEvent = "input.type.markra-slash";

const slashHistoryField = StateField.define<boolean>({
  create: () => false,
  update(pending, transaction) {
    const pendingEffect = transaction.effects.find((effect) =>
      effect.is(setSlashHistoryPending)
    );
    if (pendingEffect) return pendingEffect.value;
    return transaction.docChanged ? false : pending;
  },
});

const slashHistoryExtension: Extension = [
  slashHistoryField,
  EditorState.transactionExtender.of((transaction) => {
    if (
      !transaction.docChanged ||
      !transaction.startState.field(slashHistoryField, false)
    ) return null;
    return {
      annotations: slashHistoryPart.of(true),
    };
  }),
  history({
    joinToEvent: (transaction, adjacent) => {
      return transaction.annotation(slashHistoryPart) === true;
    },
  }),
];

function isEditable(state: EditorState) {
  return !state.facet(EditorState.readOnly);
}

const protectedBlockNames = new Set([
  "FencedCode", "CodeBlock", "Frontmatter", "Table", "TableCell",
  "TableHeader", "HTMLBlock", "BlockMath", "MathBlock", "Mermaid",
]);

function hasProtectedBlock(state: EditorState, from: number, to: number) {
  return hasProtectedMarkdownInRange(state, from, to);
}

function isParagraphPosition(state: EditorState, position: number) {
  const tree = ensureSyntaxTree(state, position, 100) ?? syntaxTree(state);
  let node: SyntaxNodeLike | null = tree.resolve(position, -1);
  let paragraph = false;
  while (node) {
    if (
      protectedBlockNames.has(node.name) || node.name === "Blockquote" ||
      node.name === "ListItem" || node.name.startsWith("ATXHeading") ||
      node.name.startsWith("SetextHeading")
    ) return false;
    if (node.name === "Paragraph") paragraph = true;
    node = node.parent;
  }
  return paragraph;
}

function typedRangeFromState(state: EditorState): SlashMenuRange | null {
  if (!isEditable(state) || state.selection.ranges.length !== 1) return null;
  const selection = state.selection.main;
  if (!selection.empty) return null;

  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return null;
  if (hasProtectedMarkdownInRange(state, selection.head, selection.head)) return null;

  const beforeCursor = state.sliceDoc(line.from, selection.head);
  const startMatch = /^([\t ]*)([/、])([^\s/、]*)$/u.exec(beforeCursor);
  const tailMatch = /^([\t ]*)(.+?)([\t ]+)([/、])([^\s/、]*)$/u.exec(beforeCursor);
  const match = startMatch ?? tailMatch;
  if (!match) return null;
  const body = startMatch ? "" : (tailMatch?.[2] ?? "");
  const delimiter = startMatch ? "" : (tailMatch?.[3] ?? "");
  if (!startMatch && !body.trim()) return null;

  const indentLength = match[1]?.length ?? 0;
  const from = startMatch
    ? line.from + indentLength
    : line.from + indentLength + body.length + delimiter.length;
  if (
    !isParagraphPosition(state, selection.head) ||
    hasProtectedBlock(state, selection.head, selection.head)
  ) return null;
  return {
    deleteFrom: from - delimiter.length,
    from,
    query: startMatch ? (startMatch[3] ?? "") : (tailMatch?.[5] ?? ""),
    source: "typed",
    to: selection.head,
  };
}

function virtualRangeFromState(
  state: EditorState,
  from = state.selection.main.head,
): SlashMenuRange | null {
  if (!isEditable(state) || state.selection.ranges.length !== 1) return null;
  const selection = state.selection.main;
  if (!selection.empty || from > selection.head) return null;

  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to || from < line.from) return null;
  if (hasProtectedMarkdownInRange(state, selection.head, selection.head)) return null;

  const query = state.sliceDoc(from, selection.head);
  if (/\s|[/、]/u.test(query)) return null;

  return {
    deleteFrom: from,
    from,
    query,
    source: "virtual",
    to: selection.head,
  };
}

function blockSelectionRangeFromState(state: EditorState): SlashMenuRange | null {
  if (!isEditable(state) || state.selection.ranges.length !== 1) return null;
  const selection = state.selection.main;
  if (
    selection.empty || selection.from !== state.doc.lineAt(selection.from).from ||
    selection.to !== state.doc.lineAt(selection.to).to ||
    hasProtectedBlock(state, selection.from, selection.to)
  ) return null;
  return {
    deleteFrom: selection.from,
    from: selection.from,
    query: "",
    source: "block-selection",
    to: selection.to,
  };
}

function continuedVirtualRange(
  transaction: Transaction,
  previous: InternalSlashMenuState,
) {
  if (previous.active?.source !== "virtual") return null;
  const from = transaction.changes.mapPos(previous.active.from, -1);
  return virtualRangeFromState(transaction.state, from);
}

function sameRange(
  left: SuppressedRange | null,
  right: SuppressedRange | null,
) {
  return Boolean(
    left && right && left.from === right.from && left.to === right.to,
  );
}

function effectFrom(transaction: Transaction) {
  return transaction.effects.find((effect) => effect.is(updateSlashMenu))?.value;
}

const slashMenuField = StateField.define<InternalSlashMenuState>({
  create(state) {
    return {
      active: typedRangeFromState(state),
      selectedIndex: 0,
      suppressed: null,
    };
  },
  update(previous, transaction) {
    const effect = effectFrom(transaction);
    const typedRange = typedRangeFromState(transaction.state);

    if (effect?.type === "close") {
      return {
        active: null,
        selectedIndex: 0,
        // Keep the exact typed range suppressed until its text or selection
        // changes, otherwise any later transaction would reopen the menu.
        suppressed:
          typedRange?.source === "typed"
            ? { from: typedRange.from, to: typedRange.to }
            : null,
      };
    }

    if (effect?.type === "open") {
      return {
        active: effect.source === "block-selection"
          ? blockSelectionRangeFromState(transaction.state)
          : virtualRangeFromState(transaction.state),
        selectedIndex: 0,
        suppressed: null,
      };
    }

    const continuedBlockSelection = previous.active?.source === "block-selection" &&
      !transaction.docChanged && !transaction.selection
      ? blockSelectionRangeFromState(transaction.state)
      : null;
    const active = typedRange ?? continuedVirtualRange(transaction, previous) ??
      continuedBlockSelection;
    if (sameRange(active, previous.suppressed)) {
      return { active: null, selectedIndex: 0, suppressed: previous.suppressed };
    }

    const keepSelection =
      active?.from === previous.active?.from &&
      active?.query === previous.active?.query &&
      active?.source === previous.active?.source;

    return {
      active,
      selectedIndex:
        effect?.type === "select"
          ? effect.index
          : keepSelection
            ? previous.selectedIndex
            : 0,
      suppressed: null,
    };
  },
});

function internalState(view: EditorView) {
  return view.state.field(slashMenuField, false);
}

function moveSelection(view: EditorView, amount: -1 | 1) {
  const menu = getMarkraSlashMenuState(view);
  if (!menu.open) return false;
  const count = menu.actions.length;
  const index = count === 0 ? 0 : (menu.selectedIndex + amount + count) % count;
  view.dispatch({ effects: updateSlashMenu.of({ index, type: "select" }) });
  return true;
}

function runSelectedAction(view: EditorView) {
  const menu = getMarkraSlashMenuState(view);
  if (!menu.open || menu.actions.length === 0) return false;
  return runMarkraSlashMenuAction(
    view,
    menu.actions[menu.selectedIndex]?.command,
  );
}

const slashMenuKeymap = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (view) => moveSelection(view, 1) },
    { key: "ArrowUp", run: (view) => moveSelection(view, -1) },
    { key: "Enter", run: runSelectedAction },
    { key: "Tab", run: runSelectedAction },
    { key: "Escape", run: closeMarkraSlashMenu },
  ]),
);

export function markraSlashMenu(): Extension {
  return [slashHistoryExtension, slashMenuField, slashMenuKeymap];
}

export function slashCommandUserEvent(state: EditorState) {
  return state.field(slashHistoryField, false)
    ? slashHistoryUserEvent
    : "input";
}

export function getMarkraSlashMenuState(
  view: EditorView,
): MarkraSlashMenuState {
  const state = internalState(view);
  if (!state?.active) {
    return {
      actions: [],
      from: null,
      open: false,
      query: "",
      selectedIndex: 0,
      source: null,
      to: null,
    };
  }

  const { active } = state;
  const actions = searchMarkraUi(view, "slash-menu", active.query).map(
    (action) => ({
      ...action,
      run: () => runMarkraSlashMenuAction(view, action.command),
    }),
  );
  const selectedIndex = Math.min(
    state.selectedIndex,
    Math.max(actions.length - 1, 0),
  );

  return {
    actions,
    from: active.from,
    open: true,
    query: active.query,
    selectedIndex,
    source: active.source,
    to: active.to,
  };
}

export function openMarkraSlashMenu(
  view: EditorView,
  options: { source?: "block-selection" } = {},
) {
  if (view.composing || !isEditable(view.state)) return false;
  const source = options.source ?? "virtual";
  const range = source === "block-selection"
    ? blockSelectionRangeFromState(view.state)
    : virtualRangeFromState(view.state);
  if (!range) return false;
  view.dispatch({ effects: updateSlashMenu.of({ source, type: "open" }) });
  // Toolbar buttons take DOM focus before their click handler runs. Restore it
  // so CodeMirror receives the menu's Arrow/Enter/Escape keybindings.
  view.focus();
  return true;
}

export function closeMarkraSlashMenu(view: EditorView) {
  if (!internalState(view)?.active) return false;
  view.dispatch({ effects: updateSlashMenu.of({ type: "close" }) });
  return true;
}

export function runMarkraSlashMenuAction(
  view: EditorView,
  commandId?: string,
) {
  const menu = getMarkraSlashMenuState(view);
  if (!menu.open) return false;
  const action = commandId
    ? menu.actions.find((candidate) => candidate.command === commandId)
    : menu.actions[menu.selectedIndex];
  if (
    !action?.enabled || menu.from === null || menu.to === null ||
    view.composing || !isEditable(view.state)
  ) return false;
  const query = menu.query;

  if (menu.source === "block-selection") {
    if (!blockSelectionRangeFromState(view.state)) return false;
    // Keep the block range intact while the chosen block command runs.
    view.dispatch({ effects: updateSlashMenu.of({ type: "close" }) });
  } else {
    const active = internalState(view)?.active;
    if (!active) return false;
    view.dispatch({
      changes: { from: active.deleteFrom, to: menu.to },
      effects: [
        updateSlashMenu.of({ type: "close" }),
        setSlashHistoryPending.of(true),
      ],
      annotations: [
        Transaction.userEvent.of(slashHistoryUserEvent),
        isolateHistory.of("before"),
      ],
    });
  }
  const beforeTransform = view.state.doc;
  const handled = runMarkraCommand(view, action.command, {
    query,
    source: "slash-menu",
  });
  if (menu.source !== "block-selection") {
    const transformed = view.state.doc !== beforeTransform;
    view.dispatch({
      effects: transformed ? [] : [setSlashHistoryPending.of(false)],
      annotations: isolateHistory.of("after"),
    });
  }
  if (handled) view.focus();
  return handled;
}
