import { type ComposerState, graphemes } from "./composer";
import type { ConversionResult } from "./converter";
import { getModelMetadata } from "./prediction/models";
import type { PredictionBackend, PredictionInput } from "./prediction/types";

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

export type ScreenName =
  | "composer"
  | "settings"
  | "prediction-engine"
  | "model-download";

export interface ScreenView {
  readonly screen: ScreenName;
  readonly width: number;
  readonly height: number;
  readonly tooSmall: boolean;
  readonly lines: readonly ViewLine[];
  readonly cursor: ViewCursor;
}

export interface ComposerView extends ScreenView {
  readonly screen: "composer";
}

export interface SettingsView extends ScreenView {
  readonly screen: "settings";
  readonly selectedRow: number;
  readonly backend: PredictionBackend;
}

export interface PredictionEngineView extends ScreenView {
  readonly screen: "prediction-engine";
  readonly selectedRow: number;
  readonly backend: PredictionBackend;
}

export interface ModelDownloadView extends ScreenView {
  readonly screen: "model-download";
  readonly selectedButton: number;
  readonly backend: Exclude<PredictionBackend, "dictionary">;
}

export type TuiView =
  | ComposerView
  | SettingsView
  | PredictionEngineView
  | ModelDownloadView;

export interface ViewOptions {
  readonly status?: string | null;
  readonly backend?: PredictionBackend;
  readonly prediction?: PredictionViewState;
}

export type PredictionPhase =
  | "processing"
  | "generated"
  | "fallback"
  | "skipped"
  | "failed";

/** Provenance and input for the current optional AI preview. */
export interface PredictionViewState {
  readonly phase: PredictionPhase;
  /** The exact PredictionInput passed to the prediction engine. */
  readonly input?: PredictionInput;
  /** The result currently shown in the Kanji row, when one exists. */
  readonly result?: string;
  /** A concise reason for a skipped/fallback/failed prediction. */
  readonly reason?: string;
}

export interface ScreenViewOptions {
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

/** Keep user/model text from emitting terminal controls in status lines. */
function safeStatusText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cs}]/gu, "�");
}

function predictionPhaseLabel(prediction: PredictionViewState): string {
  switch (prediction.phase) {
    case "processing":
      return "Processing…";
    case "generated":
      return "Generated";
    case "fallback":
      return "Dictionary fallback";
    case "failed":
      return "Failed → dictionary fallback";
    case "skipped":
      return "Skipped";
  }
}

function predictionDetails(prediction: PredictionViewState): string {
  if (!prediction.input) {
    return `AI input: not sent${prediction.reason ? ` (${safeStatusText(prediction.reason)})` : ""}`;
  }

  const reading = safeStatusText(prediction.input.reading) || "∅";
  const context = safeStatusText(prediction.input.context ?? "") || "∅";
  const input = `reading=${reading} context=${context}`;
  if (prediction.phase === "processing") return `AI input: ${input}`;

  const result = safeStatusText(prediction.result ?? "") || "∅";
  const reason = prediction.reason
    ? ` (${safeStatusText(prediction.reason)})`
    : "";
  return `AI input: ${input} → result=${result}${reason}`;
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
      screen: "composer",
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
  const backend = options.backend ?? "dictionary";
  const lines: ViewLine[] = [
    line(margin, 1, safeWidth, [
      { text: "jpn", tone: "accent" },
      { text: "  Japanese composer", tone: "neutral" },
      ...(backend !== "dictionary"
        ? ([
            { text: "  ·  ", tone: "muted" },
            { text: getModelMetadata(backend).label, tone: "muted" },
          ] as const)
        : []),
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

  const prediction = options.prediction;
  const hasPredictionDetails =
    backend !== "dictionary" && prediction !== undefined;
  const backendStatus =
    backend === "dictionary"
      ? "Kanji │ Dictionary"
      : `Kanji │ AI: ${getModelMetadata(backend).label}${prediction ? ` · ${predictionPhaseLabel(prediction)}` : ""}`;
  if (backend !== "dictionary" || state.focus === 2) {
    lines.push(
      line(
        margin,
        safeHeight - (hasPredictionDetails ? 4 : options.status ? 4 : 3),
        safeWidth,
        [{ text: backendStatus, tone: "muted" }],
      ),
    );
  }
  if (hasPredictionDetails) {
    const detail = predictionDetails(prediction);
    lines.push(
      line(margin, safeHeight - 3, safeWidth, [
        {
          text: options.status
            ? `${detail} · ${safeStatusText(options.status)}`
            : detail,
          tone: options.status ? "accent" : "muted",
        },
      ]),
    );
  } else if (options.status) {
    lines.push(
      line(margin, safeHeight - 3, safeWidth, [
        { text: options.status, tone: "accent" },
      ]),
    );
  }
  lines.push(
    line(margin, safeHeight - 2, safeWidth, [
      {
        text: "i/a edit · Esc normal · s settings · j/k/Tab focus · 1/2/3 select · Enter choose · y copy · q quit",
        tone: "muted",
      },
    ]),
  );

  return {
    screen: "composer",
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

export interface ModelDownloadViewOptions extends ScreenViewOptions {
  readonly downloading?: boolean;
}

function safeDimensions(
  width: number,
  height: number,
): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: Math.max(1, Math.trunc(width)),
    height: Math.max(1, Math.trunc(height)),
  };
}

function smallScreenLines(
  width: number,
  height: number,
): { readonly lines: readonly ViewLine[]; readonly cursor: ViewCursor } {
  const message = `Terminal too small (${width}x${height}). Resize to at least ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}.`;
  return {
    lines: [
      line(1, Math.min(2, height - 1), width, [
        { text: message, tone: "neutral" },
      ]),
    ],
    cursor: { x: 0, y: 0, visible: false, style: "block" },
  };
}

function backendPredictionLabel(backend: PredictionBackend): string {
  if (backend === "dictionary") return "Off";
  return backend === "jinen-small" ? "Jinen small" : "Jinen xsmall";
}

function selectedScreenRow(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(2, Math.trunc(value)));
}

/** Render the settings screen without depending on OpenTUI or a terminal. */
export function renderSettingsView(
  backend: PredictionBackend,
  selectedRow: number,
  width: number,
  height: number,
  options: ScreenViewOptions = {},
): SettingsView {
  const dimensions = safeDimensions(width, height);
  const selected = selectedScreenRow(selectedRow);
  if (
    dimensions.width < MIN_TERMINAL_WIDTH ||
    dimensions.height < MIN_TERMINAL_HEIGHT
  ) {
    return {
      screen: "settings",
      ...dimensions,
      tooSmall: true,
      selectedRow: selected,
      backend,
      ...smallScreenLines(dimensions.width, dimensions.height),
    };
  }

  const margin = 2;
  const rows = [
    "1. Input Mode          Romaji",
    "2. Default Output      Kanji",
    `3. AI Prediction       ${backendPredictionLabel(backend)} >`,
  ];
  const lines: ViewLine[] = [
    line(margin, 1, dimensions.width, [{ text: "Settings", tone: "accent" }]),
  ];
  rows.forEach((text, index) => {
    const focused = index === selected;
    lines.push(
      line(margin, 5 + index * 2, dimensions.width, [
        { text: focused ? "› " : "  ", tone: focused ? "accent" : "muted" },
        { text, tone: focused ? "accent" : "neutral" },
      ]),
    );
  });
  if (options.status) {
    lines.push(
      line(margin, dimensions.height - 3, dimensions.width, [
        { text: options.status, tone: "accent" },
      ]),
    );
  }
  lines.push(
    line(margin, dimensions.height - 2, dimensions.width, [
      {
        text: "Esc back · j/k/arrows/Tab select · Enter choose",
        tone: "muted",
      },
    ]),
  );
  return {
    screen: "settings",
    ...dimensions,
    tooSmall: false,
    selectedRow: selected,
    backend,
    lines,
    cursor: { x: 0, y: 0, visible: false, style: "block" },
  };
}

/** Render the prediction engine radio list as a pure view model. */
export function renderPredictionEngineView(
  backend: PredictionBackend,
  selectedRow: number,
  width: number,
  height: number,
  options: ScreenViewOptions = {},
): PredictionEngineView {
  const dimensions = safeDimensions(width, height);
  const selected = selectedScreenRow(selectedRow);
  if (
    dimensions.width < MIN_TERMINAL_WIDTH ||
    dimensions.height < MIN_TERMINAL_HEIGHT
  ) {
    return {
      screen: "prediction-engine",
      ...dimensions,
      tooSmall: true,
      selectedRow: selected,
      backend,
      ...smallScreenLines(dimensions.width, dimensions.height),
    };
  }

  const rows: ReadonlyArray<{
    readonly backend: PredictionBackend;
    readonly label: string;
  }> = [
    { backend: "dictionary", label: "Dictionary only" },
    {
      backend: "jinen-xsmall",
      label: `Jinen xsmall ${Math.round(getModelMetadata("jinen-xsmall").size / 1_000_000)} MB Recommended`,
    },
    {
      backend: "jinen-small",
      label: `Jinen small ${Math.round(getModelMetadata("jinen-small").size / 1_000_000)} MB More accurate`,
    },
  ];
  const margin = 2;
  const lines: ViewLine[] = [
    line(margin, 1, dimensions.width, [
      { text: "Prediction Engine", tone: "accent" },
    ]),
  ];
  rows.forEach((row, index) => {
    const focused = index === selected;
    const active = row.backend === backend;
    lines.push(
      line(margin, 5 + index * 2, dimensions.width, [
        { text: focused ? "› " : "  ", tone: focused ? "accent" : "muted" },
        { text: active ? "● " : "○ ", tone: active ? "accent" : "muted" },
        { text: row.label, tone: focused ? "accent" : "neutral" },
      ]),
    );
  });
  if (options.status) {
    lines.push(
      line(margin, dimensions.height - 3, dimensions.width, [
        { text: options.status, tone: "accent" },
      ]),
    );
  }
  lines.push(
    line(margin, dimensions.height - 2, dimensions.width, [
      {
        text: "Esc back · j/k/arrows/Tab select · Enter choose",
        tone: "muted",
      },
    ]),
  );
  return {
    screen: "prediction-engine",
    ...dimensions,
    tooSmall: false,
    selectedRow: selected,
    backend,
    lines,
    cursor: { x: 0, y: 0, visible: false, style: "block" },
  };
}

/** Render the explicit model-download confirmation and progress status. */
export function renderModelDownloadView(
  backend: Exclude<PredictionBackend, "dictionary">,
  selectedRow: number,
  width: number,
  height: number,
  options: ModelDownloadViewOptions = {},
): ModelDownloadView {
  const dimensions = safeDimensions(width, height);
  const selectedButton = selectedRow === 1 ? 1 : 0;
  if (
    dimensions.width < MIN_TERMINAL_WIDTH ||
    dimensions.height < MIN_TERMINAL_HEIGHT
  ) {
    return {
      screen: "model-download",
      ...dimensions,
      tooSmall: true,
      selectedButton,
      backend,
      ...smallScreenLines(dimensions.width, dimensions.height),
    };
  }

  const metadata = getModelMetadata(backend);
  const size = Math.round(metadata.size / 1_000_000);
  const lines: ViewLine[] = [
    line(2, 1, dimensions.width, [
      { text: "Prediction Engine", tone: "accent" },
    ]),
    line(2, 4, dimensions.width, [
      { text: `${metadata.label} is not installed.`, tone: "neutral" },
    ]),
    line(2, 6, dimensions.width, [
      { text: `Model size: ~${size} MB`, tone: "neutral" },
    ]),
    line(2, 8, dimensions.width, [
      { text: "Download and enable?", tone: "neutral" },
    ]),
    line(2, 10, dimensions.width, [
      {
        text: "[ Download ]",
        tone: selectedButton === 0 ? "accent" : "muted",
      },
      { text: "  ", tone: "muted" },
      {
        text: "[ Cancel ]",
        tone: selectedButton === 1 ? "accent" : "muted",
      },
    ]),
  ];
  if (options.status) {
    lines.push(
      line(2, dimensions.height - 3, dimensions.width, [
        { text: options.status, tone: "accent" },
      ]),
    );
  }
  lines.push(
    line(2, dimensions.height - 2, dimensions.width, [
      {
        text: options.downloading
          ? "Downloading…"
          : "Tab/arrows select · Enter confirm · Esc back",
        tone: "muted",
      },
    ]),
  );
  return {
    screen: "model-download",
    ...dimensions,
    tooSmall: false,
    selectedButton,
    backend,
    lines,
    cursor: { x: 0, y: 0, visible: false, style: "block" },
  };
}

/** Stable text form used by snapshot tests and non-terminal diagnostics. */
export function serializeView(view: ScreenView): string {
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
