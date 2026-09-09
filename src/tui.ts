import {
  CliRenderEvents,
  type CliRenderer,
  type CliRendererErrorEvent,
  createCliRenderer,
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  TextRenderable,
} from "@opentui/core";
import {
  type AdapterEffect,
  applyAdapterKey,
  applyPaste,
  Completion,
  mapOpenTuiKey,
  type OpenTuiKeyLike,
  type Writable,
} from "./app";
import {
  type ClipboardCopy,
  copyToNativeClipboard,
  type NativeClipboardResult,
} from "./clipboard";
import { type ComposerState, createInitialState, graphemes } from "./composer";
import {
  loadPredictionConfig,
  type PredictionConfig,
  savePredictionConfig,
} from "./config";
import { type ConversionResult, convert, toJinenReading } from "./converter";
import {
  closeDefaultDictionary,
  DictionaryError,
  getDictionary,
} from "./dictionary";
import {
  createPredictionEngine,
  isValidJinenOutput,
  type PredictionEngine,
} from "./prediction";
import {
  downloadModel,
  getModelMetadata,
  isModelInstalled,
  type JinenBackend,
  type ModelDownloadOptions,
} from "./prediction/models";
import type { PredictionBackend, PredictionInput } from "./prediction/types";
import {
  displayWidth,
  type PredictionViewState,
  renderModelDownloadView,
  renderPredictionEngineView,
  renderSettingsView,
  renderView,
  type ScreenName,
  type TuiView,
  type ViewCursor,
  type ViewTone,
} from "./view";

export const TUI_COLORS: Readonly<Record<ViewTone, string>> = {
  neutral: "#e5e7eb",
  muted: "#6b7280",
  accent: "#818cf8",
};

export interface TuiSessionOptions {
  readonly completion: Completion;
  readonly terminal: Writable;
  readonly convert?: (value: string) => ConversionResult;
  readonly copyToClipboard?: ClipboardCopy;
  readonly render: (view: TuiView) => void;
  readonly width?: number;
  readonly height?: number;
  readonly statusDurationMs?: number;
  readonly config?: PredictionConfig;
  readonly saveConfig?: (config: PredictionConfig) => void;
  readonly isModelInstalled?: (backend: JinenBackend) => boolean;
  readonly downloadModel?: (
    backend: JinenBackend,
    options?: ModelDownloadOptions,
  ) => Promise<unknown>;
  readonly predictionEngineFactory?: (
    backend: JinenBackend,
  ) => PredictionEngine;
  readonly predictionDebounceMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Japanese context before the current whitespace-delimited segment. */
function leftJapaneseContext(buffer: string): string {
  let delimiter = -1;
  for (const match of buffer.matchAll(/\s/gu)) {
    delimiter = match.index ?? delimiter;
  }
  if (delimiter < 0) return "";
  return graphemes(buffer.slice(0, delimiter))
    .filter((part) =>
      /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(part),
    )
    .slice(-64)
    .join("");
}

/** Testable state/effect driver. OpenTUI is only responsible for terminal I/O. */
export class TuiSession {
  private state: ComposerState = createInitialState();
  /** The deterministic conversion, kept separate from the async preview. */
  private basePreview: ConversionResult = {
    hiragana: "",
    katakana: "",
    kanji: "",
  };
  private preview: ConversionResult = this.basePreview;
  private width: number;
  private height: number;
  private status: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private predictionTimer: ReturnType<typeof setTimeout> | undefined;
  private predictionVersion = 0;
  private prediction: PredictionViewState = {
    phase: "skipped",
    reason: "no eligible input",
  };
  private readonly engines = new Map<JinenBackend, PredictionEngine>();
  private readonly convertValue: (value: string) => ConversionResult;
  private readonly copyToClipboard: ClipboardCopy;
  private readonly save: (config: PredictionConfig) => void;
  private readonly installed: (backend: JinenBackend) => boolean;
  private readonly download: (
    backend: JinenBackend,
    options?: ModelDownloadOptions,
  ) => Promise<unknown>;
  private readonly makeEngine: (backend: JinenBackend) => PredictionEngine;
  private readonly debounceDuration: number;
  private backend: PredictionBackend;
  private screen: ScreenName = "composer";
  private settingsFocus = 0;
  private engineFocus = 0;
  private confirmationBackend: JinenBackend | null = null;
  private confirmationButton = 0;
  private downloading = false;

  constructor(private readonly options: TuiSessionOptions) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    this.convertValue = options.convert ?? convert;
    this.copyToClipboard = options.copyToClipboard ?? copyToNativeClipboard;
    this.backend = options.config?.backend ?? "dictionary";
    this.save = options.saveConfig ?? savePredictionConfig;
    this.installed = options.isModelInstalled ?? isModelInstalled;
    this.download = options.downloadModel ?? downloadModel;
    this.makeEngine = options.predictionEngineFactory ?? createPredictionEngine;
    this.debounceDuration = Math.max(0, options.predictionDebounceMs ?? 150);
    this.engineFocus = this.engineRowForBackend(this.backend);
    options.completion.addCleanup(() => {
      if (this.statusTimer !== undefined) clearTimeout(this.statusTimer);
      this.cancelPrediction();
    });
  }

  get snapshot(): TuiView {
    if (this.screen === "settings") {
      return renderSettingsView(
        this.backend,
        this.settingsFocus,
        this.width,
        this.height,
        {
          status: this.status,
        },
      );
    }
    if (this.screen === "prediction-engine") {
      return renderPredictionEngineView(
        this.backend,
        this.engineFocus,
        this.width,
        this.height,
        { status: this.status },
      );
    }
    if (this.screen === "model-download" && this.confirmationBackend) {
      return renderModelDownloadView(
        this.confirmationBackend,
        this.confirmationButton,
        this.width,
        this.height,
        {
          status: this.status,
          downloading: this.downloading,
        },
      );
    }
    return renderView(this.state, this.preview, this.width, this.height, {
      status: this.status,
      backend: this.backend,
      prediction: this.prediction,
    });
  }

  draw(): void {
    if (this.options.completion.done) return;
    try {
      this.options.render(this.snapshot);
    } catch (error) {
      this.fatal(error, "jpn render error");
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.draw();
  }

  key(event: OpenTuiKeyLike): void {
    if (this.options.completion.done) return;
    try {
      const action = mapOpenTuiKey(event);
      if (action.ctrl && action.key === "c") {
        this.options.completion.finish({ type: "interrupt" });
        return;
      }
      if (this.screen !== "composer") {
        this.screenKey(action.key);
        this.draw();
        return;
      }
      // Settings is a session-level screen. In particular, it must not be
      // added to the composer reducer or change its default focus.
      if (
        this.state.mode === "NORMAL" &&
        this.state.pending === null &&
        action.key === "s" &&
        !action.ctrl &&
        !action.alt
      ) {
        this.settingsFocus = 0;
        this.screen = "settings";
        this.clearStatus();
        this.draw();
        return;
      }
      const previousBuffer = this.state.buffer;
      const update = applyAdapterKey(
        this.state,
        this.preview,
        event,
        this.convertValue,
      );
      this.state = update.state;
      if (previousBuffer !== this.state.buffer) {
        this.basePreview = update.preview;
        this.preview = update.preview;
        this.inputChanged();
      }
      this.handleEffects(update.effects);
      this.draw();
    } catch (error) {
      this.fail(error);
    }
  }

  paste(value: string): void {
    if (this.options.completion.done) return;
    try {
      const previousBuffer = this.state.buffer;
      const update = applyPaste(
        this.state,
        this.preview,
        value,
        this.convertValue,
      );
      this.state = update.state;
      if (previousBuffer !== this.state.buffer) {
        this.basePreview = update.preview;
        this.preview = update.preview;
        this.inputChanged();
      }
      this.draw();
    } catch (error) {
      this.fail(error);
    }
  }

  fatal(error: unknown, prefix = "jpn"): void {
    this.options.completion.finish({
      type: "fatal",
      message: `${prefix}: ${messageOf(error)}`,
    });
  }

  private fail(error: unknown): void {
    if (error instanceof DictionaryError) {
      this.options.completion.finish({ type: "fatal", message: error.message });
      return;
    }
    this.fatal(error);
  }

  private clearStatus(): void {
    this.status = null;
    if (this.statusTimer !== undefined) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }
  }

  private showStatus(value: string): void {
    this.status = value;
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.status = null;
      this.statusTimer = undefined;
      this.draw();
    }, this.options.statusDurationMs ?? 1200);
    this.statusTimer.unref?.();
  }

  private inputChanged(): void {
    this.schedulePrediction();
  }

  private isJinen(backend: PredictionBackend): backend is JinenBackend {
    return backend !== "dictionary";
  }

  private cancelPrediction(): void {
    this.predictionVersion += 1;
    if (this.predictionTimer !== undefined) {
      clearTimeout(this.predictionTimer);
      this.predictionTimer = undefined;
    }
  }

  private schedulePrediction(): void {
    this.cancelPrediction();
    const version = this.predictionVersion;
    const backend = this.backend;
    const buffer = this.state.buffer;
    // Jinen's training format uses Katakana readings. The visible Katakana
    // row intentionally preserves incomplete/ordinary ASCII, so only when
    // the deterministic Kanji fallback contains a Katakana transliteration
    // do we reuse the converter's narrow, dictionary-aware preparation for
    // the model input. Never use the Kanji result itself as the reading.
    const visibleReading = this.basePreview.katakana;
    const reading =
      /[A-Za-z]/u.test(visibleReading) &&
      /[\p{Script=Katakana}]/u.test(this.basePreview.kanji)
        ? toJinenReading(buffer, getDictionary())
        : visibleReading;
    if (!this.isJinen(backend)) {
      this.prediction = { phase: "skipped", reason: "dictionary mode" };
      return;
    }
    if (reading.trim().length === 0) {
      this.prediction = { phase: "skipped", reason: "no eligible input" };
      return;
    }
    if (!/[\p{Script=Katakana}]/u.test(reading) || /[A-Za-z]/u.test(reading)) {
      this.prediction = { phase: "skipped", reason: "input not eligible" };
      return;
    }
    const fallback = this.basePreview.kanji;
    const context = leftJapaneseContext(buffer);
    const input: PredictionInput = { reading, context };
    this.prediction = { phase: "processing", input };
    this.predictionTimer = setTimeout(() => {
      this.predictionTimer = undefined;
      void this.runPrediction(version, backend, buffer, input, fallback);
    }, this.debounceDuration);
    this.predictionTimer.unref?.();
  }

  private async runPrediction(
    version: number,
    backend: JinenBackend,
    buffer: string,
    input: PredictionInput,
    fallback: string,
  ): Promise<void> {
    if (
      this.options.completion.done ||
      version !== this.predictionVersion ||
      this.backend !== backend ||
      this.state.buffer !== buffer
    ) {
      return;
    }
    let engine: PredictionEngine;
    try {
      engine = this.engines.get(backend) ?? this.makeEngine(backend);
      this.engines.set(backend, engine);
    } catch (error) {
      // Loading native prediction code is deliberately outside the TUI's
      // fatal path. The deterministic preview remains visible.
      this.prediction = {
        phase: "failed",
        input,
        result: fallback,
        reason: messageOf(error),
      };
      this.draw();
      return;
    }
    let generated: string;
    try {
      generated = await engine.predict(input);
    } catch (error) {
      if (
        this.options.completion.done ||
        version !== this.predictionVersion ||
        this.backend !== backend ||
        this.state.buffer !== buffer
      ) {
        return;
      }
      this.preview = { ...this.basePreview, kanji: fallback };
      this.prediction = {
        phase: "failed",
        input,
        result: fallback,
        reason: messageOf(error),
      };
      this.draw();
      return;
    }
    if (
      this.options.completion.done ||
      version !== this.predictionVersion ||
      this.backend !== backend ||
      this.state.buffer !== buffer
    ) {
      return;
    }
    // Never replace the deterministic kana rows; only the Kanji preview is
    // owned by asynchronous prediction.
    const valid = isValidJinenOutput(generated);
    const result = valid ? generated : fallback;
    this.preview = { ...this.basePreview, kanji: result };
    this.prediction = valid
      ? { phase: "generated", input, result }
      : {
          phase: "fallback",
          input,
          result,
          reason: "invalid AI output",
        };
    this.draw();
  }

  private engineRowForBackend(backend: PredictionBackend): number {
    if (backend === "jinen-xsmall") return 1;
    if (backend === "jinen-small") return 2;
    return 0;
  }

  private moveRow(current: number, key: string): number | null {
    if (key === "j" || key === "Down") return Math.min(2, current + 1);
    if (key === "k" || key === "Up") return Math.max(0, current - 1);
    if (key === "Tab") return (current + 1) % 3;
    if (key === "Shift-Tab") return (current + 2) % 3;
    if (/^[123]$/.test(key)) return Number(key) - 1;
    return null;
  }

  private screenKey(key: string): void {
    if (this.screen === "settings") {
      if (key === "Esc") {
        this.screen = "composer";
        this.clearStatus();
        return;
      }
      const next = this.moveRow(this.settingsFocus, key);
      if (next !== null) {
        this.settingsFocus = next;
        return;
      }
      if (key === "Enter" && this.settingsFocus === 2) {
        this.engineFocus = this.engineRowForBackend(this.backend);
        this.screen = "prediction-engine";
        this.clearStatus();
      }
      return;
    }

    if (this.screen === "prediction-engine") {
      if (key === "Esc") {
        this.screen = "settings";
        this.clearStatus();
        return;
      }
      const next = this.moveRow(this.engineFocus, key);
      if (next !== null) {
        this.engineFocus = next;
        return;
      }
      if (key === "Enter") this.selectEngine(this.engineFocus);
      return;
    }

    if (this.screen !== "model-download" || this.confirmationBackend === null) {
      return;
    }
    if (this.downloading) return;
    if (key === "Esc") {
      this.screen = "prediction-engine";
      this.clearStatus();
      return;
    }
    if (key === "Tab" || key === "Shift-Tab") {
      this.confirmationButton = this.confirmationButton === 0 ? 1 : 0;
      return;
    }
    if (key === "Left" || key === "h" || key === "Up" || key === "1") {
      this.confirmationButton = 0;
      return;
    }
    if (key === "Right" || key === "l" || key === "Down" || key === "2") {
      this.confirmationButton = 1;
      return;
    }
    if (key === "Enter") {
      if (this.confirmationButton === 1) {
        this.screen = "prediction-engine";
        this.clearStatus();
      } else {
        this.startDownload(this.confirmationBackend);
      }
    }
  }

  private selectEngine(row: number): void {
    const backend: PredictionBackend =
      row === 0 ? "dictionary" : row === 1 ? "jinen-xsmall" : "jinen-small";
    this.engineFocus = row;
    if (backend === "dictionary") {
      this.activateBackend(backend);
      return;
    }
    let installed = false;
    try {
      installed = this.installed(backend);
    } catch (error) {
      this.showStatus(
        `Unable to check ${getModelMetadata(backend).label}: ${messageOf(error)}`,
      );
      return;
    }
    if (installed) {
      this.activateBackend(backend);
      return;
    }
    this.confirmationBackend = backend;
    this.confirmationButton = 0;
    this.downloading = false;
    this.screen = "model-download";
    this.clearStatus();
  }

  private activateBackend(backend: PredictionBackend): void {
    try {
      this.save({ backend });
    } catch (error) {
      this.showStatus(`Unable to save settings: ${messageOf(error)}`);
      this.draw();
      return;
    }
    this.backend = backend;
    this.preview = this.basePreview;
    this.screen = "settings";
    this.settingsFocus = 2;
    this.engineFocus = this.engineRowForBackend(backend);
    this.confirmationBackend = null;
    this.clearStatus();
    this.schedulePrediction();
    this.draw();
  }

  private startDownload(backend: JinenBackend): void {
    if (this.downloading) return;
    this.downloading = true;
    this.status = `Downloading ${getModelMetadata(backend).label}… 0%`;
    this.draw();
    const report = (downloaded: number, total?: number): void => {
      const expected =
        total && total > 0 ? total : getModelMetadata(backend).size;
      const percent = Math.max(
        0,
        Math.min(100, Math.round((downloaded / expected) * 100)),
      );
      this.status = `Downloading ${getModelMetadata(backend).label}… ${percent}%`;
      this.draw();
    };
    let result: Promise<unknown>;
    try {
      result = this.download(backend, { onProgress: report });
    } catch (error) {
      this.downloadFailed(error);
      return;
    }
    void Promise.resolve(result).then(
      () => {
        if (this.options.completion.done) return;
        this.downloading = false;
        this.activateBackend(backend);
      },
      (error: unknown) => this.downloadFailed(error),
    );
  }

  private downloadFailed(error: unknown): void {
    this.downloading = false;
    this.showStatus(`Download failed: ${messageOf(error)}`);
    this.draw();
  }

  private handleEffects(effects: readonly AdapterEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "yank") {
        let copied: NativeClipboardResult | null = null;
        try {
          copied = this.copyToClipboard(effect.value);
        } catch {
          // Clipboard integrations are best-effort; preserve the OSC 52 path.
        }
        if (copied) {
          this.showStatus(`Copied via ${copied.backend}`);
        } else {
          this.options.terminal.write(effect.sequence);
          this.showStatus(
            "OSC 52 fallback sent (clipboard change unconfirmed)",
          );
        }
      } else if (effect.type === "submit") {
        this.options.completion.finish(effect);
      } else if (effect.type === "quit") {
        this.options.completion.finish(effect);
      } else {
        this.options.completion.finish(effect);
      }
    }
  }
}

/** Translate zero-based view coordinates to OpenTUI's one-based CSI position. */
export function toOpenTuiCursorPosition(
  cursor: Pick<ViewCursor, "x" | "y" | "visible">,
): Pick<ViewCursor, "x" | "y" | "visible"> {
  return {
    x: cursor.x + 1,
    y: cursor.y + 1,
    visible: cursor.visible,
  };
}

function paint(renderer: CliRenderer, view: TuiView): void {
  for (const child of renderer.root.getChildren()) {
    renderer.root.remove(child);
    child.destroyRecursively();
  }

  for (const line of view.lines) {
    let x = line.x;
    for (const span of line.spans) {
      const text = new TextRenderable(renderer, {
        content: span.text,
        fg: TUI_COLORS[span.tone],
        position: "absolute",
        left: x,
        top: line.y,
        height: 1,
        width: Math.max(1, displayWidth(span.text)),
        wrapMode: "none",
        selectable: false,
      });
      renderer.root.add(text);
      x += displayWidth(span.text);
    }
  }
  renderer.setCursorStyle({ style: view.cursor.style, blinking: false });
  const cursor = toOpenTuiCursorPosition(view.cursor);
  renderer.setCursorPosition(cursor.x, cursor.y, cursor.visible);
  renderer.requestRender();
}

export interface LaunchTuiOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly terminal?: NodeJS.WriteStream;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly convert?: (value: string) => ConversionResult;
  readonly copyToClipboard?: ClipboardCopy;
}

/** Launch the full-screen composer and resolve only after its single cleanup path. */
export async function launchTui(
  options: LaunchTuiOptions = {},
): Promise<number> {
  const terminal = options.terminal ?? process.stdout;
  const completion = new Completion(
    options.stdout ?? process.stdout,
    options.stderr ?? process.stderr,
  );

  const onSigint = (): void => completion.finish({ type: "signal", code: 130 });
  const onSigterm = (): void =>
    completion.finish({ type: "signal", code: 143 });
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  completion.addCleanup(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    closeDefaultDictionary();
  });

  try {
    // Validate bundled data before OpenTUI can enter the alternate screen.
    getDictionary();
    // Loading is intentionally done once at launch and injected into the
    // session, so a test-created TuiSession never reads the user's home.
    const config = loadPredictionConfig();
    const renderer = await createCliRenderer({
      stdin: options.stdin ?? process.stdin,
      stdout: terminal,
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      screenMode: "alternate-screen",
    });
    completion.attach(renderer);
    if (completion.done) return completion.promise;

    const session = new TuiSession({
      completion,
      terminal,
      convert: options.convert,
      copyToClipboard: options.copyToClipboard,
      config,
      width: renderer.width,
      height: renderer.height,
      render: (view) => paint(renderer, view),
    });
    renderer.keyInput.on("keypress", (event: KeyEvent) => session.key(event));
    renderer.keyInput.on("paste", (event: PasteEvent) => {
      session.paste(decodePasteBytes(event.bytes));
    });
    renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => {
      session.resize(width, height);
    });
    renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) =>
      session.fatal(event.error, "jpn render error"),
    );
    session.draw();
    renderer.start();
  } catch (error) {
    if (error instanceof DictionaryError) {
      completion.finish({ type: "fatal", message: error.message });
    } else {
      completion.finish({
        type: "fatal",
        message: `jpn: unable to start terminal UI: ${messageOf(error)}`,
      });
    }
  }

  return completion.promise;
}
