import { type ComposerState, graphemes } from "./composer";
import type { ConversionResult } from "./converter";

export const MIN_TERMINAL_WIDTH = 60;
export const MIN_TERMINAL_HEIGHT = 15;

export type ViewTone = "neutral" | "muted" | "accent";

export interface ViewSpan {
  readonly text: string;
  readonly tone: ViewTone;
}

export interface ViewLine {
  readonly x: number;
  readonly y: number;
  readonly spans: readonly ViewSpan[];
}

export interface ViewCursor {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly style: "block" | "line";
}

export interface ComposerView {
  readonly width: number;
  readonly height: number;
  readonly tooSmall: boolean;
  readonly lines: readonly ViewLine[];
  readonly cursor: ViewCursor;
}

export interface ViewOptions {
  readonly status?: string | null;
}

const labels = ["ひらがな", "カタカナ", "漢字"] as const;

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/** Display columns for terminal text, measured by extended grapheme cluster. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const part of graphemes(value)) {
    if (/^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]+$/u.test(part)) continue;
    if (/\p{Extended_Pictographic}/u.test(part)) {
      width += 2;
      continue;
    }
    const first = part.codePointAt(0);
    width += first !== undefined && isWideCodePoint(first) ? 2 : 1;
  }
  return width;
}

function clipText(value: string, columns: number): string {
  if (columns <= 0) return "";
  let result = "";
  let used = 0;
  for (const part of graphemes(value)) {
    const width = displayWidth(part);
    if (used + width > columns) break;
    result += part;
    used += width;
  }
  return result;
}

function clipSpans(spans: readonly ViewSpan[], columns: number): ViewSpan[] {
  const result: ViewSpan[] = [];
  let remaining = columns;
  for (const span of spans) {
    const text = clipText(span.text, remaining);
    if (text.length > 0) result.push({ ...span, text });
    remaining -= displayWidth(text);
    if (remaining <= 0 || text !== span.text) break;
  }
  return result;
}

function line(
  x: number,
  y: number,
  width: number,
  spans: readonly ViewSpan[],
): ViewLine {
  return { x, y, spans: clipSpans(spans, Math.max(0, width - x)) };
}

interface InputViewport {
  readonly text: string;
  readonly cursorColumn: number;
}

function inputViewport(state: ComposerState, columns: number): InputViewport {
  const parts = graphemes(state.buffer);
  const widths = parts.map(displayWidth);
  const cursor = Math.max(0, Math.min(state.cursor, parts.length));
  const caretOffset = widths
    .slice(0, cursor)
    .reduce((sum, value) => sum + value, 0);
  const cursorWidth =
    state.mode === "NORMAL" && cursor < widths.length ? widths[cursor] : 1;
  const requiredEnd = caretOffset + cursorWidth;

  let start = 0;
  let startOffset = 0;
  while (start < cursor && requiredEnd - startOffset > columns) {
    startOffset += widths[start];
    start += 1;
  }

  let text = "";
  let used = 0;
  for (let index = start; index < parts.length; index += 1) {
    if (used + widths[index] > columns) break;
    text += parts[index];
    used += widths[index];
  }

  return {
    text,
    cursorColumn: Math.max(0, Math.min(columns - 1, caretOffset - startOffset)),
  };
}

function rowValues(preview: ConversionResult): readonly string[] {
  return [preview.hiragana, preview.katakana, preview.kanji];
}

/** Build a deterministic, renderer-independent full-screen view model. */
export function renderView(
  state: ComposerState,
  preview: ConversionResult,
  width: number,
  height: number,
  options: ViewOptions = {},
): ComposerView {
  const safeWidth = Math.max(1, Math.trunc(width));
  const safeHeight = Math.max(1, Math.trunc(height));
  const hiddenCursor: ViewCursor = {
    x: 0,
    y: 0,
    visible: false,
    style: "block",
  };

  if (safeWidth < MIN_TERMINAL_WIDTH || safeHeight < MIN_TERMINAL_HEIGHT) {
    const message = `Terminal too small (${safeWidth}x${safeHeight}). Resize to at least ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}.`;
    return {
      width: safeWidth,
      height: safeHeight,
      tooSmall: true,
      lines: [
        line(1, Math.min(2, safeHeight - 1), safeWidth, [
          { text: message, tone: "neutral" },
        ]),
      ],
      cursor: hiddenCursor,
    };
  }

  const margin = 2;
  const modePrefix = `${state.mode}  Input  `;
  const inputColumns = Math.max(
    1,
    safeWidth - margin * 2 - displayWidth(modePrefix),
  );
  const input = inputViewport(state, inputColumns);
  const lines: ViewLine[] = [
    line(margin, 1, safeWidth, [
      { text: "jpn", tone: "accent" },
      { text: "  Japanese composer", tone: "neutral" },
    ]),
    line(margin, 3, safeWidth, [
      { text: state.mode, tone: "accent" },
      { text: "  Input  ", tone: "muted" },
      { text: input.text, tone: "neutral" },
    ]),
  ];

  const values = rowValues(preview);
  for (let index = 0; index < values.length; index += 1) {
    const focused = state.focus === index;
    lines.push(
      line(margin, 6 + index * 2, safeWidth, [
        { text: focused ? "› " : "  ", tone: focused ? "accent" : "muted" },
        {
          text: `${index + 1} ${labels[index]}`,
          tone: focused ? "accent" : "muted",
        },
        { text: "  ", tone: "muted" },
        { text: values[index] || "—", tone: "neutral" },
      ]),
    );
  }

  if (options.status) {
    lines.push(
      line(margin, safeHeight - 3, safeWidth, [
        { text: options.status, tone: "accent" },
      ]),
    );
  }
  lines.push(
    line(margin, safeHeight - 2, safeWidth, [
      {
        text: "i/a edit · Esc normal · j/k/Tab focus · 1/2/3 select · Enter choose · y copy · q quit",
        tone: "muted",
      },
    ]),
  );

  return {
    width: safeWidth,
    height: safeHeight,
    tooSmall: false,
    lines,
    cursor: {
      x: margin + displayWidth(modePrefix) + input.cursorColumn,
      y: 3,
      visible: true,
      style: state.mode === "INSERT" ? "line" : "block",
    },
  };
}

/** Stable text form used by snapshot tests and non-terminal diagnostics. */
export function serializeView(view: ComposerView): string {
  const rows = Array.from({ length: view.height }, () => "");
  for (const item of view.lines) {
    if (item.y < 0 || item.y >= rows.length) continue;
    rows[item.y] =
      " ".repeat(item.x) + item.spans.map((span) => span.text).join("");
  }
  return rows
    .map((row, index) => `${String(index).padStart(2, "0")}|${row}`)
    .join("\n");
}
