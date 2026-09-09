/**
 * The small, UI-independent state machine used by the Japanese composer.
 *
 * `cursor` is a grapheme index, not a UTF-16 offset.  In NORMAL mode it
 * points at a grapheme (and is therefore at most `graphemes(buffer).length -
 * 1`); in INSERT mode it is a caret between graphemes and may equal the
 * grapheme count.
 */

export type Mode = "NORMAL" | "INSERT";
export type Pending = "d" | null;

export interface HistoryEntry {
  readonly buffer: string;
  readonly cursor: number;
}

export interface ComposerState {
  readonly mode: Mode;
  readonly buffer: string;
  readonly cursor: number;
  /** The selected composer row. Always in the inclusive range 0..2. */
  readonly focus: number;
  readonly pending: Pending;
  readonly yank: string | null;
  readonly undo: readonly HistoryEntry[];
  readonly redo: readonly HistoryEntry[];
  readonly historyLimit: number;
}

export type State = ComposerState;

export interface KeyAction {
  readonly type: "key";
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export type ComposerAction = KeyAction;
export type Action = ComposerAction;

export interface SubmitEffect {
  readonly type: "submit";
  readonly value: string;
  readonly focus: number;
}

export interface YankEffect {
  readonly type: "yank";
  readonly value: string;
  readonly focus: number;
}

export interface QuitEffect {
  readonly type: "quit";
  readonly focus: number;
}

export interface InterruptEffect {
  readonly type: "interrupt";
  readonly focus: number;
}

export type ComposerEffect =
  | SubmitEffect
  | YankEffect
  | QuitEffect
  | InterruptEffect;
export type Effect = ComposerEffect;

export interface ComposerResult {
  readonly state: ComposerState;
  readonly effects: readonly ComposerEffect[];
}

export interface ComposerOptions {
  readonly buffer?: string;
  readonly focus?: number;
  readonly historyLimit?: number;
}

const MAX_FOCUS = 2;
const DEFAULT_HISTORY_LIMIT = 100;

// Keeping one segmenter also makes it difficult for a future call site to
// accidentally fall back to Array.from(), which would split emoji and marks.
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Return the extended grapheme clusters in a string. */
export function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/** Number of user-visible cursor positions in a string. */
export function graphemeLength(value: string): number {
  return graphemes(value).length;
}

function clampFocus(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_FOCUS, Math.trunc(value)));
}

function normalCursor(cursor: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.trunc(cursor)));
}

function insertCursor(cursor: number, count: number): number {
  return Math.max(0, Math.min(count, Math.trunc(cursor)));
}

function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_LIMIT;
  return Math.max(0, Math.trunc(value));
}

function boundedPush<T>(items: readonly T[], item: T, limit: number): T[] {
  if (limit <= 0) return [];
  const next = [...items, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function makeState(
  buffer: string,
  focus: number,
  historyLimit: number,
): ComposerState {
  return {
    mode: "NORMAL",
    buffer,
    cursor: 0,
    focus: clampFocus(focus),
    pending: null,
    yank: null,
    undo: [],
    redo: [],
    historyLimit: clampHistoryLimit(historyLimit),
  };
}

/**
 * Construct the initial state. The overload accepting an options object is
 * useful to callers and tests that need a non-empty one-line buffer.
 */
export function createInitialState(
  buffer?: string,
  focus?: number,
  historyLimit?: number,
): ComposerState;
export function createInitialState(options?: ComposerOptions): ComposerState;
export function createInitialState(
  bufferOrOptions: string | ComposerOptions = "",
  focus = 0,
  historyLimit = DEFAULT_HISTORY_LIMIT,
): ComposerState {
  if (typeof bufferOrOptions === "string") {
    return makeState(bufferOrOptions, focus, historyLimit);
  }

  return makeState(
    bufferOrOptions.buffer ?? "",
    bufferOrOptions.focus ?? 0,
    bufferOrOptions.historyLimit ?? DEFAULT_HISTORY_LIMIT,
  );
}

export const initialState = createInitialState();

/** Build the action consumed by the reducer. */
export function keyAction(
  key: string,
  modifiers: Pick<KeyAction, "ctrl" | "shift" | "alt"> = {},
): KeyAction {
  return { type: "key", key, ...modifiers };
}

export const pressKey = keyAction;
export const press = keyAction;

function normaliseKey(action: KeyAction | string): string {
  let key = typeof action === "string" ? action : action.key;
  let ctrl = typeof action !== "string" && action.ctrl === true;
  const shift = typeof action !== "string" && action.shift === true;

  // Accept the spellings commonly produced by a TUI adapter as well as the
  // structured modifier fields above.
  const modifierMatch = key.match(/^(?:ctrl|control)\s*[-+ ]\s*(.+)$/i);
  if (modifierMatch) {
    ctrl = true;
    key = modifierMatch[1];
  }
  const shiftMatch = key.match(/^shift\s*[-+ ]\s*(.+)$/i);
  if (shiftMatch) {
    key = shiftMatch[1];
    if (key.toLowerCase() === "tab") return "Shift-Tab";
  }

  if (key === "\r" || key === "\n" || /^enter$/i.test(key)) return "Enter";
  if (key === "\t" || /^tab$/i.test(key)) {
    return shift ? "Shift-Tab" : "Tab";
  }
  if (key === "\x1b" || /^esc(?:ape)?$/i.test(key)) return "Esc";
  if (key === "\x7f" || /^backspace$/i.test(key)) return "Backspace";
  if (/^delete$/i.test(key)) return "Delete";
  if (/^(?:left|arrowleft)$/i.test(key)) return "Left";
  if (/^(?:right|arrowright)$/i.test(key)) return "Right";
  if (/^(?:home)$/i.test(key)) return "Home";
  if (/^(?:end)$/i.test(key)) return "End";

  if (ctrl) return `Ctrl-${key.length === 1 ? key.toUpperCase() : key}`;
  if (shift && key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

function isWordGrapheme(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}

function wordStartBefore(parts: readonly string[], cursor: number): number {
  if (parts.length === 0 || cursor <= 0) return 0;

  let index = Math.min(cursor, parts.length) - 1;
  while (index >= 0 && !isWordGrapheme(parts[index])) index -= 1;
  while (index > 0 && isWordGrapheme(parts[index - 1])) index -= 1;
  return index < 0 ? 0 : index;
}

function nextWord(parts: readonly string[], cursor: number): number {
  let index = Math.max(0, Math.min(cursor, parts.length));
  if (index < parts.length && isWordGrapheme(parts[index])) {
    while (index < parts.length && isWordGrapheme(parts[index])) index += 1;
  }
  while (index < parts.length && !isWordGrapheme(parts[index])) index += 1;
  return index;
}

function normaliseState(state: ComposerState): ComposerState {
  const count = graphemeLength(state.buffer);
  const cursor =
    state.mode === "INSERT"
      ? insertCursor(state.cursor, count)
      : normalCursor(state.cursor, count);
  const focus = clampFocus(state.focus);

  if (cursor === state.cursor && focus === state.focus) return state;
  return { ...state, cursor, focus };
}

function withCursor(state: ComposerState, cursor: number): ComposerState {
  const count = graphemeLength(state.buffer);
  return {
    ...state,
    cursor:
      state.mode === "INSERT"
        ? insertCursor(cursor, count)
        : normalCursor(cursor, count),
  };
}

function recordEdit(
  state: ComposerState,
  buffer: string,
  cursor: number,
): ComposerState {
  if (buffer === state.buffer) return withCursor(state, cursor);

  const count = graphemeLength(buffer);
  const boundedCursor =
    state.mode === "INSERT"
      ? insertCursor(cursor, count)
      : normalCursor(cursor, count);
  const undo = boundedPush(
    state.undo,
    { buffer: state.buffer, cursor: state.cursor },
    state.historyLimit,
  );

  return {
    ...state,
    buffer,
    cursor: boundedCursor,
    pending: null,
    undo,
    redo: [],
  };
}

function replaceRange(
  state: ComposerState,
  start: number,
  end: number,
  cursor: number,
): ComposerState {
  const parts = graphemes(state.buffer);
  const next = [...parts.slice(0, start), ...parts.slice(end)].join("");
  return recordEdit(state, next, cursor);
}

function cursorForUtf16Offset(value: string, offset: number): number {
  const segments = Array.from(graphemeSegmenter.segment(value));
  let cursor = 0;
  for (const segment of segments) {
    if (segment.index >= offset) break;
    cursor += 1;
  }
  return cursor;
}

function insertText(state: ComposerState, value: string): ComposerState {
  const parts = graphemes(state.buffer);
  const prefix = parts.slice(0, state.cursor).join("");
  const suffix = parts.slice(state.cursor).join("");
  const next = prefix + value + suffix;
  // Re-segment the result. This matters for a combining mark or ZWJ that
  // joins with a neighbouring cluster: the caret must not land inside it.
  const cursor = cursorForUtf16Offset(next, prefix.length + value.length);
  return recordEdit(state, next, cursor);
}

function isPrintable(value: string): boolean {
  if (value.length === 0) return false;
  // Format characters (for example the ZWJ in an emoji sequence) are valid
  // members of a printable grapheme, so only reject actual controls and line
  // separators here.
  return !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

function focusState(state: ComposerState, focus: number): ComposerState {
  return { ...state, focus: clampFocus(focus), pending: null };
}

function textEffect(
  type: "submit" | "yank",
  value: string,
  focus: number,
): SubmitEffect | YankEffect {
  return { type, value, focus } as SubmitEffect | YankEffect;
}

function undo(state: ComposerState): ComposerState {
  if (state.undo.length === 0) return { ...state, pending: null };
  const entry = state.undo[state.undo.length - 1];
  const current: HistoryEntry = { buffer: state.buffer, cursor: state.cursor };
  const nextUndo = state.undo.slice(0, -1);
  const nextRedo = boundedPush(state.redo, current, state.historyLimit);
  const count = graphemeLength(entry.buffer);

  return {
    ...state,
    buffer: entry.buffer,
    cursor: normalCursor(entry.cursor, count),
    pending: null,
    undo: nextUndo,
    redo: nextRedo,
  };
}

function redo(state: ComposerState): ComposerState {
  if (state.redo.length === 0) return { ...state, pending: null };
  const entry = state.redo[state.redo.length - 1];
  const current: HistoryEntry = { buffer: state.buffer, cursor: state.cursor };
  const nextRedo = state.redo.slice(0, -1);
  const nextUndo = boundedPush(state.undo, current, state.historyLimit);
  const count = graphemeLength(entry.buffer);

  return {
    ...state,
    buffer: entry.buffer,
    cursor: normalCursor(entry.cursor, count),
    pending: null,
    undo: nextUndo,
    redo: nextRedo,
  };
}

function normalKey(state: ComposerState, key: string): ComposerResult {
  // A pending d is a deliberately tiny operator-prefix state. An invalid
  // continuation is consumed, rather than accidentally becoming another
  // command, which makes the sequence deterministic.
  if (state.pending === "d") {
    if (key === "d") {
      return {
        state: replaceRange(state, 0, graphemeLength(state.buffer), 0),
        effects: [],
      };
    }
    return { state: { ...state, pending: null }, effects: [] };
  }

  switch (key) {
    case "d":
      return { state: { ...state, pending: "d" }, effects: [] };
    case "h":
      return { state: withCursor(state, state.cursor - 1), effects: [] };
    case "l":
      return { state: withCursor(state, state.cursor + 1), effects: [] };
    case "0":
      return { state: withCursor(state, 0), effects: [] };
    case "$":
      return {
        state: withCursor(state, graphemeLength(state.buffer) - 1),
        effects: [],
      };
    case "w":
      return {
        state: withCursor(
          state,
          normalCursor(
            nextWord(graphemes(state.buffer), state.cursor),
            graphemeLength(state.buffer),
          ),
        ),
        effects: [],
      };
    case "b":
      return {
        state: withCursor(
          state,
          wordStartBefore(graphemes(state.buffer), state.cursor),
        ),
        effects: [],
      };
    case "i":
      return {
        state: { ...state, mode: "INSERT", pending: null },
        effects: [],
      };
    case "a": {
      const count = graphemeLength(state.buffer);
      return {
        state: {
          ...state,
          cursor: insertCursor(state.cursor + 1, count),
          mode: "INSERT",
          pending: null,
        },
        effects: [],
      };
    }
    case "I":
      return {
        state: { ...withCursor(state, 0), mode: "INSERT", pending: null },
        effects: [],
      };
    case "A":
      return {
        state: {
          ...state,
          cursor: graphemeLength(state.buffer),
          mode: "INSERT",
          pending: null,
        },
        effects: [],
      };
    case "x": {
      const count = graphemeLength(state.buffer);
      if (count === 0 || state.cursor >= count) {
        return { state: { ...state, pending: null }, effects: [] };
      }
      const nextCursor = normalCursor(state.cursor, count - 1);
      return {
        state: replaceRange(state, state.cursor, state.cursor + 1, nextCursor),
        effects: [],
      };
    }
    case "D": {
      const count = graphemeLength(state.buffer);
      if (state.cursor >= count) {
        return { state: { ...state, pending: null }, effects: [] };
      }
      return {
        state: replaceRange(state, state.cursor, count, state.cursor),
        effects: [],
      };
    }
    case "u":
      return { state: undo(state), effects: [] };
    case "Ctrl-R":
      return { state: redo(state), effects: [] };
    case "y":
      return {
        state: { ...state, pending: null, yank: state.buffer },
        effects: [textEffect("yank", state.buffer, state.focus)],
      };
    case "q":
      return {
        state: { ...state, pending: null },
        effects: [{ type: "quit", focus: state.focus }],
      };
    case "j":
      return { state: focusState(state, state.focus + 1), effects: [] };
    case "k":
      return { state: focusState(state, state.focus - 1), effects: [] };
    case "Tab":
      return { state: focusState(state, (state.focus + 1) % 3), effects: [] };
    case "Shift-Tab":
      return { state: focusState(state, (state.focus + 2) % 3), effects: [] };
    case "1":
    case "2":
    case "3":
      return { state: focusState(state, Number(key) - 1), effects: [] };
    default:
      return { state: { ...state, pending: null }, effects: [] };
  }
}

function insertKey(state: ComposerState, key: string): ComposerResult {
  switch (key) {
    case "Esc":
      return {
        state: {
          ...state,
          mode: "NORMAL",
          cursor: normalCursor(state.cursor - 1, graphemeLength(state.buffer)),
          pending: null,
        },
        effects: [],
      };
    case "Backspace":
      if (state.cursor === 0) return { state, effects: [] };
      return {
        state: replaceRange(
          state,
          state.cursor - 1,
          state.cursor,
          state.cursor - 1,
        ),
        effects: [],
      };
    case "Delete":
      if (state.cursor >= graphemeLength(state.buffer))
        return { state, effects: [] };
      return {
        state: replaceRange(
          state,
          state.cursor,
          state.cursor + 1,
          state.cursor,
        ),
        effects: [],
      };
    case "Left":
      return { state: withCursor(state, state.cursor - 1), effects: [] };
    case "Right":
      return { state: withCursor(state, state.cursor + 1), effects: [] };
    case "Home":
      return { state: withCursor(state, 0), effects: [] };
    case "End":
      return {
        state: withCursor(state, graphemeLength(state.buffer)),
        effects: [],
      };
    case "Ctrl-W": {
      const parts = graphemes(state.buffer);
      const start = wordStartBefore(parts, state.cursor);
      return {
        state: replaceRange(state, start, state.cursor, start),
        effects: [],
      };
    }
    case "Ctrl-U":
      return {
        state: replaceRange(state, 0, state.cursor, 0),
        effects: [],
      };
    default:
      if (isPrintable(key)) {
        return { state: insertText(state, key), effects: [] };
      }
      return { state, effects: [] };
  }
}

/** Pure reducer. No input object or returned state is mutated. */
export function composerReducer(
  inputState: ComposerState,
  action: ComposerAction | string,
): ComposerResult {
  const state = normaliseState(inputState);
  const key = normaliseKey(action);

  // These controls are global so that a terminal interrupt and submit behave
  // identically while editing and while navigating.
  if (key === "Ctrl-C") {
    return {
      state: { ...state, pending: null },
      effects: [{ type: "interrupt", focus: state.focus }],
    };
  }
  if (key === "Enter") {
    return {
      state: { ...state, pending: null },
      effects: [textEffect("submit", state.buffer, state.focus)],
    };
  }

  return state.mode === "NORMAL"
    ? normalKey(state, key)
    : insertKey(state, key);
}

export const reducer = composerReducer;
export const reduceComposer = composerReducer;

/** Convenience wrapper for callers that already have a raw terminal key. */
export function handleKey(
  state: ComposerState,
  key: string,
  modifiers: Pick<KeyAction, "ctrl" | "shift" | "alt"> = {},
): ComposerResult {
  return composerReducer(state, keyAction(key, modifiers));
}
