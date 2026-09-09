import { describe, expect, test } from "bun:test";
import { createInitialState } from "../src/composer";
import type { ConversionResult } from "../src/converter";
import {
  displayWidth,
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  renderView,
  serializeView,
} from "../src/view";

const preview: ConversionResult = {
  hiragana: "にほんご",
  katakana: "ニホンゴ",
  kanji: "日本語",
};

describe("view model", () => {
  test("renders plain focused rows and stable normal-mode snapshot", () => {
    const text = serializeView(
      renderView(createInitialState("nihongo"), preview, 60, 15),
    );
    expect(text).toContain("ひらがな");
    expect(text).toContain("カタカナ");
    expect(text).toContain("漢字");
    expect(text).not.toMatch(/Hiragana|Katakana|Kanji/);
    expect(text).toMatchInlineSnapshot(`
"00|
01|  jpn  Japanese composer
02|
03|  NORMAL  Input  nihongo
04|
05|
06|  › 1 ひらがな  にほんご
07|
08|    2 カタカナ  ニホンゴ
09|
10|    3 漢字  日本語
11|
12|
13|  i/a edit · Esc normal · j/k/Tab focus · 1/2/3 select · Ent
14|"
`);
  });

  test("shows insert cursor style, selected state, and status", () => {
    const state = {
      ...createInitialState("日本"),
      mode: "INSERT" as const,
      cursor: 2,
      focus: 2,
    };
    const view = renderView(state, preview, 80, 20, { status: "Copied" });
    expect(view.cursor).toEqual({ x: 21, y: 3, visible: true, style: "line" });
    expect(view.lines.find((line) => line.y === 10)?.spans[0].text).toBe("› ");
    expect(serializeView(view)).toContain("17|  Copied");
  });

  test("small terminals show only resize guidance and hide cursor", () => {
    for (const [width, height] of [
      [MIN_TERMINAL_WIDTH - 1, MIN_TERMINAL_HEIGHT],
      [MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT - 1],
      [1, 1],
    ]) {
      const view = renderView(createInitialState(), preview, width, height);
      expect(view.tooSmall).toBe(true);
      expect(view.cursor.visible).toBe(false);
      if (width > 20)
        expect(serializeView(view)).toContain("Terminal too small");
    }
  });

  test("clips long Japanese input by terminal columns without splitting graphemes", () => {
    const input = "日本語".repeat(30);
    const state = { ...createInitialState(input), cursor: 89 };
    const view = renderView(state, preview, 60, 15);
    const inputLine = view.lines.find((line) => line.y === 3);
    const shown = inputLine?.spans.at(-1)?.text ?? "";
    expect(displayWidth(shown)).toBeLessThanOrEqual(42);
    expect(view.cursor.x).toBeLessThan(60);
    expect(shown).toMatch(/^[日本語]+$/u);
  });
});

describe("terminal display width", () => {
  test("counts Japanese, combining clusters, and emoji", () => {
    expect(displayWidth("abc日本")).toBe(7);
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("👩‍💻")).toBe(2);
    expect(displayWidth("\u200d")).toBe(0);
  });
});
