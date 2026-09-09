import { describe, expect, test } from "bun:test";
import {
  type ComposerResult,
  type ComposerState,
  composerReducer,
  createInitialState,
  graphemes,
  handleKey,
  keyAction,
} from "../src/composer";

function step(
  state: ComposerState,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
): ComposerState {
  return composerReducer(state, keyAction(key, modifiers)).state;
}

function result(
  state: ComposerState,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
): ComposerResult {
  return composerReducer(state, keyAction(key, modifiers));
}

describe("composer startup, focus, and effects", () => {
  test("starts in NORMAL with an empty input row and bounded focus", () => {
    const state = createInitialState();

    expect(state.mode).toBe("NORMAL");
    expect(state.buffer).toBe("");
    expect(state.cursor).toBe(0);
    expect(state.focus).toBe(0);
    expect(state.pending).toBeNull();
    expect(state.undo).toEqual([]);
    expect(state.redo).toEqual([]);
  });

  test("j/k are bounded, Tab wraps rows, Shift-Tab reverses, and 1/2/3 select", () => {
    let state = createInitialState();

    state = step(state, "k");
    expect(state.focus).toBe(0);
    state = step(state, "j");
    state = step(state, "j");
    state = step(state, "j");
    expect(state.focus).toBe(2);
    state = step(state, "k");
    expect(state.focus).toBe(1);

    state = step(state, "Tab");
    expect(state.focus).toBe(2);
    state = step(state, "Tab");
    expect(state.focus).toBe(0);
    state = step(state, "Shift-Tab");
    expect(state.focus).toBe(2);
    state = step(state, "1");
    expect(state.focus).toBe(0);
    state = step(state, "2");
    expect(state.focus).toBe(1);
    state = step(state, "3");
    expect(state.focus).toBe(2);
  });

  test("y, Enter, q, and Ctrl-C produce pure effects", () => {
    let state = createInitialState({ buffer: "かな", focus: 1 });

    let output = result(state, "y");
    expect(output.state.buffer).toBe("かな");
    expect(output.state.yank).toBe("かな");
    expect(output.effects).toEqual([{ type: "yank", value: "かな", focus: 1 }]);

    state = output.state;
    output = result(state, "Enter");
    expect(output.effects).toEqual([
      { type: "submit", value: "かな", focus: 1 },
    ]);
    expect(output.state.buffer).toBe("かな");

    output = result(state, "q");
    expect(output.effects).toEqual([{ type: "quit", focus: 1 }]);

    output = result(step(state, "i"), "c", { ctrl: true });
    expect(output.effects).toEqual([{ type: "interrupt", focus: 1 }]);
    expect(output.state.buffer).toBe("かな");
  });

  test("the reducer does not mutate its input state or its history arrays", () => {
    const before = createInitialState({ buffer: "abc" });
    const afterInsertMode = composerReducer(before, keyAction("i")).state;
    const afterEdit = composerReducer(afterInsertMode, keyAction("x")).state;

    expect(before.mode).toBe("NORMAL");
    expect(before.buffer).toBe("abc");
    expect(before.undo).toEqual([]);
    expect(afterEdit.undo).not.toBe(before.undo);
    expect(afterEdit.buffer).toBe("xabc");
  });
});

describe("grapheme-safe INSERT mode", () => {
  test("inserts printable Unicode as graphemes and Esc returns to NORMAL", () => {
    let state = createInitialState({ buffer: "a" });
    state = step(state, "i");
    state = step(state, "👩‍💻");
    state = step(state, "e\u0301");

    expect(state.buffer).toBe("👩‍💻éa");
    expect(graphemes(state.buffer)).toEqual(["👩‍💻", "é", "a"]);
    expect(state.cursor).toBe(2);
    expect(step(state, "Esc").mode).toBe("NORMAL");
    expect(step(state, "Esc").cursor).toBe(1);
  });

  test("supports backspace, delete, left, right, home, and end at boundaries", () => {
    let state = step(createInitialState({ buffer: "abc" }), "i");
    state = step(state, "Right");
    state = step(state, "Backspace");
    expect(state.buffer).toBe("bc");
    expect(state.cursor).toBe(0);

    state = step(state, "Delete");
    expect(state.buffer).toBe("c");
    expect(state.cursor).toBe(0);
    state = step(state, "Backspace");
    expect(state.buffer).toBe("c");
    state = step(state, "End");
    expect(state.cursor).toBe(1);
    state = step(state, "Left");
    state = step(state, "Home");
    expect(state.cursor).toBe(0);
    state = step(state, "Right");
    expect(state.cursor).toBe(1);
    state = step(state, "Delete");
    expect(state.buffer).toBe("c");
    expect(step(state, "Right").cursor).toBe(1);
  });

  test("Ctrl-W removes the previous word and Ctrl-U removes to the line start", () => {
    let state = step(createInitialState({ buffer: "one two" }), "i");
    state = step(state, "End");
    state = step(state, "w", { ctrl: true });
    expect(state.buffer).toBe("one ");
    expect(state.cursor).toBe(4);

    state = step(state, "u", { ctrl: true });
    expect(state.buffer).toBe("");
    expect(state.cursor).toBe(0);
  });

  test("Enter submits in INSERT and Ctrl-C interrupts without editing", () => {
    const state = step(createInitialState({ buffer: "入力" }), "i");
    let output = result(state, "Enter");
    expect(output.effects[0]).toEqual({
      type: "submit",
      value: "入力",
      focus: 0,
    });
    expect(output.state.mode).toBe("INSERT");

    output = result(state, "Ctrl-C");
    expect(output.effects[0]).toEqual({ type: "interrupt", focus: 0 });
    expect(output.state.buffer).toBe("入力");
  });

  test("structured and terminal-style key names are accepted", () => {
    let state = createInitialState({ buffer: "ab" });
    state = composerReducer(state, keyAction("i")).state;
    state = handleKey(state, "ArrowRight").state;
    state = handleKey(state, "Backspace").state;
    expect(state.buffer).toBe("b");
    state = handleKey(state, "\x1b").state;
    expect(state.mode).toBe("NORMAL");
  });
});

describe("grapheme-safe NORMAL mode", () => {
  test("h/l, 0/$, w/b move over grapheme positions", () => {
    let state = createInitialState({ buffer: "one two" });
    state = step(state, "l");
    expect(state.cursor).toBe(1);
    state = step(state, "h");
    expect(state.cursor).toBe(0);
    state = step(state, "$");
    expect(state.cursor).toBe(6);
    state = step(state, "0");
    expect(state.cursor).toBe(0);
    state = step(state, "w");
    expect(state.cursor).toBe(4);
    state = step(state, "b");
    expect(state.cursor).toBe(0);
    state = step(state, "b");
    expect(state.cursor).toBe(0);

    state = createInitialState({ buffer: "👩‍💻é🇯🇵" });
    state = step(state, "$");
    expect(state.cursor).toBe(2);
    state = step(state, "h");
    expect(state.cursor).toBe(1);
    state = step(state, "h");
    expect(state.cursor).toBe(0);
  });

  test("e moves to word ends and advances from an end or non-word", () => {
    let state = createInitialState({ buffer: "one two" });
    state = step(state, "e");
    expect(state.cursor).toBe(2);
    state = step(state, "e");
    expect(state.cursor).toBe(6);

    state = createInitialState({ buffer: "one two" });
    state = step(state, "l");
    state = step(state, "l");
    state = step(state, "l");
    state = step(state, "e");
    expect(state.cursor).toBe(6);
  });

  test("i/a/I/A enter at the Vim-style positions", () => {
    let state = createInitialState({ buffer: "abc" });
    state = step(state, "l");
    state = step(state, "i");
    expect([state.mode, state.cursor]).toEqual(["INSERT", 1]);

    state = step(step(createInitialState({ buffer: "abc" }), "l"), "a");
    expect([state.mode, state.cursor]).toEqual(["INSERT", 2]);

    state = step(createInitialState({ buffer: "abc" }), "I");
    expect([state.mode, state.cursor]).toEqual(["INSERT", 0]);
    state = step(createInitialState({ buffer: "abc" }), "A");
    expect([state.mode, state.cursor]).toEqual(["INSERT", 3]);
  });

  test("x, D, and the deterministic dd prefix edit one grapheme-aware line", () => {
    let state = createInitialState({ buffer: "a👩‍💻é" });
    state = step(state, "x");
    expect(state.buffer).toBe("👩‍💻é");
    expect(graphemes(state.buffer)).toHaveLength(2);

    state = step(state, "D");
    expect(state.buffer).toBe("");
    expect(state.cursor).toBe(0);

    state = createInitialState({ buffer: "abc" });
    state = step(state, "d");
    expect(state.pending).toBe("d");
    state = step(state, "d");
    expect(state.buffer).toBe("");
    expect(state.pending).toBeNull();

    state = createInitialState({ buffer: "abc" });
    state = step(state, "d");
    state = step(state, "x"); // invalid continuation is consumed
    expect(state.buffer).toBe("abc");
    expect(state.pending).toBeNull();
  });
});

describe("bounded undo and redo", () => {
  test("undo/redo restore deterministic snapshots and edits clear redo", () => {
    let state = createInitialState({ buffer: "abc", historyLimit: 2 });
    state = step(state, "x"); // bc
    state = step(state, "x"); // c
    expect(state.undo).toHaveLength(2);

    state = step(state, "u");
    expect(state.buffer).toBe("bc");
    state = step(state, "u");
    expect(state.buffer).toBe("abc");
    state = step(state, "u"); // bounded: the original empty history is not inventable
    expect(state.buffer).toBe("abc");
    expect(state.undo).toHaveLength(0);
    expect(state.redo).toHaveLength(2);

    state = step(state, "Ctrl-R");
    expect(state.buffer).toBe("bc");
    state = step(state, "x");
    expect(state.buffer).toBe("c");
    expect(state.redo).toEqual([]);
    expect(state.undo).toHaveLength(2);
  });

  test("dd is one history edit and history remains bounded", () => {
    let state = createInitialState({ buffer: "日本語", historyLimit: 1 });
    state = step(state, "d");
    state = step(state, "d");
    expect(state.undo).toHaveLength(1);
    state = step(state, "u");
    expect(state.buffer).toBe("日本語");
    state = step(state, "Ctrl-R");
    expect(state.buffer).toBe("");
  });
});
