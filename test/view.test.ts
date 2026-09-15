import { describe, expect, test } from "bun:test";
import { createInitialState } from "../src/composer";
import type { ConversionResult } from "../src/converter";
import {
  displayWidth,
  footerFor,
  INSERT_FOOTER,
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  NORMAL_FOOTER,
  renderHelpView,
  renderModelDownloadView,
  renderPredictionEngineView,
  renderSettingsView,
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
13|  i edit · j/k pick · Enter accept · y copy · ? help
14|"
`);
  });

  test("renders Settings labels", () => {
    const text = serializeView(renderSettingsView("dictionary", 0, 80, 24));
    expect(text).toContain("Settings");
    expect(text).toContain("1. Input Mode          Romaji");
    expect(text).toContain("2. Default Output      Kanji");
    expect(text).toContain("3. AI Prediction       Off >");
  });

  test("renders active Prediction Engine radios independently of focused row", () => {
    const view = renderPredictionEngineView("jinen-small", 0, 80, 24);
    const text = serializeView(view);
    expect(text).toContain("› ○ Dictionary only");
    expect(text).toContain("○ Jinen xsmall");
    expect(text).toContain("● Jinen small");
    expect(view.selectedRow).toBe(0);
    expect(view.backend).toBe("jinen-small");
  });

  test("renders model download labels and button focus", () => {
    const download = renderModelDownloadView("jinen-xsmall", 0, 80, 24);
    const cancel = renderModelDownloadView("jinen-xsmall", 1, 80, 24);
    const downloadLine = download.lines.find((line) => line.y === 10);
    const cancelLine = cancel.lines.find((line) => line.y === 10);
    expect(serializeView(download)).toContain("Jinen xsmall is not installed.");
    expect(serializeView(download)).toContain("Download and enable?");
    expect(serializeView(download)).toContain("[ Download ]");
    expect(serializeView(download)).toContain("[ Cancel ]");
    expect(downloadLine?.spans[0]).toEqual({
      text: "[ Download ]",
      tone: "accent",
    });
    expect(cancelLine?.spans[2]).toEqual({
      text: "[ Cancel ]",
      tone: "accent",
    });
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

  test("renders enabled prediction model in header and status", () => {
    const xsmall = renderView(createInitialState("nihongo"), preview, 80, 20, {
      backend: "jinen-xsmall",
    });
    const xsmallText = serializeView(xsmall);
    expect(xsmallText).toContain("jpn  Japanese composer  ·  Jinen xsmall");
    expect(xsmallText).toContain("Kanji │ AI: Jinen xsmall");

    const small = renderView(createInitialState("nihongo"), preview, 80, 20, {
      backend: "jinen-small",
    });
    const smallText = serializeView(small);
    expect(smallText).toContain("jpn  Japanese composer  ·  Jinen small");
    expect(smallText).toContain("Kanji │ AI: Jinen small");

    const dict = renderView(createInitialState("nihongo"), preview, 80, 20, {
      backend: "dictionary",
    });
    const dictText = serializeView(dict);
    expect(dictText).toContain("jpn  Japanese composer");
    expect(dictText).not.toContain("·  Jinen");
    expect(dictText).not.toContain("Kanji │ AI:");
  });

  test("renders AI provenance, exact engine input, and result", () => {
    const processing = serializeView(
      renderView(createInitialState("tabemono"), preview, 80, 20, {
        backend: "jinen-xsmall",
        prediction: {
          phase: "processing",
          input: { reading: "たべもの", context: "昨日の食事" },
        },
      }),
    );
    expect(processing).toContain("Kanji │ AI: Jinen xsmall · Processing…");
    expect(processing).toContain(
      "AI input: reading=たべもの context=昨日の食事",
    );
    expect(processing).not.toContain("result=");

    const generated = serializeView(
      renderView(createInitialState("tabemono"), preview, 80, 20, {
        backend: "jinen-xsmall",
        prediction: {
          phase: "generated",
          input: { reading: "たべもの", context: "昨日の食事" },
          result: "食べ物",
        },
      }),
    );
    expect(generated).toContain("Kanji │ AI: Jinen xsmall · Generated");
    expect(generated).toContain(
      "AI input: reading=たべもの context=昨日の食事 → result=食べ物",
    );

    const skipped = serializeView(
      renderView(createInitialState(), preview, 80, 20, {
        backend: "jinen-xsmall",
        prediction: { phase: "skipped", reason: "no eligible input" },
      }),
    );
    expect(skipped).toContain("Kanji │ AI: Jinen xsmall · Skipped");
    expect(skipped).toContain("AI input: not sent (no eligible input)");
  });

  test("sanitizes terminal controls in prediction details", () => {
    const text = serializeView(
      renderView(createInitialState(), preview, 80, 20, {
        backend: "jinen-xsmall",
        prediction: {
          phase: "generated",
          input: { reading: "あ\u001b[31m", context: "\n" },
          result: "漢字\u0007",
        },
      }),
    );
    expect(text).toContain("reading=あ�[31m context=� → result=漢字�");
    expect(text).not.toContain("\u001b");
  });
});

describe("mode-aware footer", () => {
  test("each footer fits inside the minimum terminal width", () => {
    for (const footer of [NORMAL_FOOTER, INSERT_FOOTER]) {
      expect(displayWidth(`  ${footer}`)).toBeLessThanOrEqual(
        MIN_TERMINAL_WIDTH,
      );
    }
  });

  test("INSERT mode shows only insert-mode keys", () => {
    const state = { ...createInitialState("nihongo"), mode: "INSERT" as const };
    const text = serializeView(renderView(state, preview, 60, 15));
    expect(text).toContain(INSERT_FOOTER);
    expect(text).not.toContain(NORMAL_FOOTER);
    expect(text).not.toContain("j/k pick");
  });

  test("NORMAL mode footer is fully visible at the minimum width", () => {
    const text = serializeView(
      renderView(createInitialState("nihongo"), preview, 60, 15),
    );
    expect(text).toContain(NORMAL_FOOTER);
    expect(text).toMatch(/help\s*$/m);
  });

  test("the two footers differ so only live bindings are advertised", () => {
    expect(footerFor("NORMAL")).toBe(NORMAL_FOOTER);
    expect(footerFor("INSERT")).toBe(INSERT_FOOTER);
  });
});

describe("help overlay", () => {
  test("lists the bindings that the footer omits", () => {
    const text = serializeView(renderHelpView(60, 15));
    expect(text).toContain("Help");
    for (const fragment of [
      "h l 0 $ w b e",
      "i a I A",
      "x D dd",
      "dw de db d$ d0",
      "p P",
      "u Ctrl-R",
      "j k Tab 1 2 3",
      "s settings",
      "q quit",
      "Ctrl-W word",
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).toContain("Esc close");
  });

  test("keeps every help row inside the minimum terminal width", () => {
    const view = renderHelpView(MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT);
    for (const item of view.lines) {
      const width =
        item.x +
        item.spans.reduce((sum, span) => sum + displayWidth(span.text), 0);
      expect(width).toBeLessThanOrEqual(MIN_TERMINAL_WIDTH);
    }
    expect(view.lines.at(-1)?.spans[0]?.text).toBe("Esc close");
  });

  test("small terminals show only resize guidance", () => {
    const view = renderHelpView(MIN_TERMINAL_WIDTH - 1, MIN_TERMINAL_HEIGHT);
    expect(view.tooSmall).toBe(true);
    expect(serializeView(view)).toContain("Terminal too small");
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

describe("pending operator and truncation feedback", () => {
  test("shows the open operator only while a d sequence is pending", () => {
    const waiting = { ...createInitialState("abc"), pending: "d" as const };
    expect(serializeView(renderView(waiting, preview, 80, 20))).toContain(
      "NORMAL  -- d --  Input  abc",
    );
    expect(
      serializeView(renderView(createInitialState("abc"), preview, 80, 20)),
    ).not.toContain("-- d --");
  });

  test("marks a truncated preview row with an ellipsis inside the width", () => {
    const long = { ...preview, kanji: "漢".repeat(60) };
    const view = renderView(createInitialState("x"), long, 60, 15);
    const row = view.lines.find((line) => line.y === 10);
    const text = row?.spans.map((span) => span.text).join("") ?? "";
    expect(text.endsWith("…")).toBe(true);
    expect(displayWidth(text)).toBeLessThanOrEqual(60);
  });

  test("leaves a preview row untouched when it fits", () => {
    const view = renderView(createInitialState("x"), preview, 80, 20);
    const row = view.lines.find((line) => line.y === 10);
    const text = row?.spans.map((span) => span.text).join("") ?? "";
    expect(text).toBe("  3 漢字  日本語");
  });
});
