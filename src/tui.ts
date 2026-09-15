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
  type AdapterAction,
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
import {
  type ConversionResult,
  convert,
  toJinenReading,
  upgradeKanaSpans,
} from "./converter";
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
  clipWithEllipsis,
  displayWidth,
  PREVIEW_LABELS,
  type PredictionViewState,
  renderHelpView,
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
  readonly isModelInstalled?: (backend: JinenBackend) => Promise<boolean>;
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

/** True when a mapped key event is the `?` help shortcut. */
function isHelpKey(action: AdapterAction): boolean {
  return action.key === "?" || (action.key === "/" && action.shift === true);
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
  private predictionAbort: AbortController | null = null;
  private readonly modelAvailability = new Map<
    JinenBackend,
    Promise<boolean>
  >();
  private prediction: PredictionViewState = {
    phase: "skipped",
    reason: "no eligible input",
  };
  private readonly engines = new Map<JinenBackend, PredictionEngine>();
  private readonly convertValue: (value: string) => ConversionResult;
  private readonly copyToClipboard: ClipboardCopy;
  private readonly save: (config: PredictionConfig) => void;
  private readonly installed: (backend: JinenBackend) => Promise<boolean>;
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
  private engineVerifyToken = 0;
  private downloadToken = 0;
  private downloadAbort: AbortController | null = null;
  private copyToken = 0;
  private copyBusy = false;
  private copyAbort: AbortController | null = null;

  constructor(private readonly options: TuiSessionOptions) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    this.convertValue = options.convert ?? convert;
    this.copyToClipboard =
      options.copyToClipboard ??
      ((value, signal) => copyToNativeClipboard(value, { signal }));
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
      this.cancelCopy();
      this.cancelDownload();
    });
  }

  get snapshot(): TuiView {
    if (this.screen === "help") {
      return renderHelpView(this.width, this.height, { status: this.status });
    }
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
      // Settings and Help are session-level screens. In particular, they must
      // not be added to the composer reducer or change its default focus.
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
      if (
        this.state.mode === "NORMAL" &&
        this.state.pending === null &&
        isHelpKey(action) &&
        !action.ctrl &&
        !action.alt
      ) {
        this.screen = "help";
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
    }, this.options.statusDurationMs ?? 3000);
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
    // Abort the in-flight request so the native model stops generating instead
    // of finishing work whose result will be discarded.
    this.predictionAbort?.abort();
    this.predictionAbort = null;
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
    const controller = new AbortController();
    this.predictionAbort = controller;
    this.prediction = { phase: "processing", input };
    this.predictionTimer = setTimeout(() => {
      this.predictionTimer = undefined;
      void this.runPrediction(
        version,
        backend,
        buffer,
        input,
        fallback,
        controller.signal,
      );
    }, this.debounceDuration);
    this.predictionTimer.unref?.();
  }

  /** True once this request has been superseded, cancelled, or shut down. */
  private stalePrediction(
    version: number,
    backend: JinenBackend,
    buffer: string,
    signal: AbortSignal,
  ): boolean {
    return (
      this.options.completion.done ||
      signal.aborted ||
      version !== this.predictionVersion ||
      this.backend !== backend ||
      this.state.buffer !== buffer
    );
  }

  /**
   * Hash-verify a model once per session before it is handed to llama. The
   * check is local and offline; a missing or corrupt file stays unavailable
   * and the deterministic dictionary result is used instead.
   */
  private verifyAvailable(backend: JinenBackend): Promise<boolean> {
    let verification = this.modelAvailability.get(backend);
    if (!verification) {
      verification = Promise.resolve()
        .then(() => this.installed(backend))
        .catch(() => false);
      this.modelAvailability.set(backend, verification);
    }
    return verification;
  }

  private async runPrediction(
    version: number,
    backend: JinenBackend,
    buffer: string,
    input: PredictionInput,
    fallback: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.stalePrediction(version, backend, buffer, signal)) return;

    const available = await this.verifyAvailable(backend);
    if (this.stalePrediction(version, backend, buffer, signal)) return;
    if (!available) {
      this.preview = { ...this.basePreview, kanji: fallback };
      this.prediction = {
        phase: "failed",
        input,
        result: fallback,
        reason: "model not installed or corrupt",
      };
      this.showStatus(
        `${getModelMetadata(backend).label} unavailable — press s to reinstall`,
      );
      this.draw();
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
      generated = await engine.predict(input, { signal });
    } catch (error) {
      if (this.stalePrediction(version, backend, buffer, signal)) return;
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
    if (this.stalePrediction(version, backend, buffer, signal)) return;
    // Never replace the deterministic kana rows; only the Kanji preview is
    // owned by asynchronous prediction. A valid prediction is upgraded with
    // the dictionary so it cannot under-convert below the deterministic row.
    const valid = isValidJinenOutput(generated);
    const result = valid
      ? upgradeKanaSpans(generated, getDictionary())
      : fallback;
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
    if (this.screen === "help") {
      if (key === "Esc" || key === "?") {
        this.screen = "composer";
        this.clearStatus();
      }
      return;
    }

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
      if (key === "Enter") void this.selectEngine(this.engineFocus);
      return;
    }

    if (this.screen !== "model-download" || this.confirmationBackend === null) {
      return;
    }
    if (this.downloading) {
      // Escape is the only key that does anything mid-download: it cancels and
      // returns to engine selection.
      if (key === "Esc") {
        this.cancelDownload();
        this.screen = "prediction-engine";
        this.clearStatus();
        this.draw();
      }
      return;
    }
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

  private async selectEngine(row: number): Promise<void> {
    const backend: PredictionBackend =
      row === 0 ? "dictionary" : row === 1 ? "jinen-xsmall" : "jinen-small";
    this.engineFocus = row;
    if (backend === "dictionary") {
      this.activateBackend(backend);
      return;
    }
    // Hash-verify the existing file before it can be activated. Verification is
    // asynchronous, so a newer selection or navigation invalidates this one.
    const token = ++this.engineVerifyToken;
    let installed = false;
    try {
      installed = await this.installed(backend);
    } catch (error) {
      if (token !== this.engineVerifyToken || this.options.completion.done)
        return;
      this.showStatus(
        `Unable to check ${getModelMetadata(backend).label}: ${messageOf(error)}`,
      );
      this.draw();
      return;
    }
    if (token !== this.engineVerifyToken || this.options.completion.done)
      return;
    if (this.screen !== "prediction-engine") return;
    if (installed) {
      this.modelAvailability.set(backend, Promise.resolve(true));
      this.activateBackend(backend);
      return;
    }
    this.confirmationBackend = backend;
    this.confirmationButton = 0;
    this.downloading = false;
    this.screen = "model-download";
    this.clearStatus();
    this.draw();
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
    const token = ++this.downloadToken;
    const controller = new AbortController();
    this.downloadAbort = controller;
    this.downloading = true;
    this.status = `Downloading ${getModelMetadata(backend).label}… 0%`;
    this.draw();
    const report = (downloaded: number, total?: number): void => {
      // Late progress after cancellation, shutdown, or a newer download is
      // discarded rather than being drawn over the current screen.
      if (token !== this.downloadToken || this.options.completion.done) return;
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
      result = this.download(backend, {
        onProgress: report,
        signal: controller.signal,
      });
    } catch (error) {
      this.downloadFailed(token, error);
      return;
    }
    void Promise.resolve(result).then(
      () => {
        if (token !== this.downloadToken || this.options.completion.done)
          return;
        this.downloading = false;
        this.downloadAbort = null;
        this.modelAvailability.set(backend, Promise.resolve(true));
        this.activateBackend(backend);
      },
      (error: unknown) => this.downloadFailed(token, error),
    );
  }

  private downloadFailed(token: number, error: unknown): void {
    if (token !== this.downloadToken || this.options.completion.done) return;
    this.downloading = false;
    this.downloadAbort = null;
    this.showStatus(`Download failed: ${messageOf(error)}`);
    this.draw();
  }

  private cancelDownload(): void {
    this.downloadToken += 1;
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.downloading = false;
  }

  private startCopy(effect: Extract<AdapterEffect, { type: "yank" }>): void {
    if (this.copyBusy) {
      this.showStatus("Copy already in progress…");
      this.draw();
      return;
    }
    const label = PREVIEW_LABELS[effect.focus] ?? "preview";
    const summary = clipWithEllipsis(effect.value, 20);
    const token = ++this.copyToken;
    const controller = new AbortController();
    this.copyBusy = true;
    this.copyAbort = controller;
    this.showStatus(`Copying ${label}: ${summary}…`);
    void this.finishCopy(effect, label, summary, token, controller);
  }

  private async finishCopy(
    effect: Extract<AdapterEffect, { type: "yank" }>,
    label: string,
    summary: string,
    token: number,
    controller: AbortController,
  ): Promise<void> {
    let copied: NativeClipboardResult | null = null;
    try {
      copied = await this.copyToClipboard(effect.value, controller.signal);
    } catch {
      // Clipboard integrations are best-effort; preserve the OSC 52 path.
      copied = null;
    }
    // A cancelled copy, a newer copy, or shutdown must never touch the status
    // line or the terminal again.
    if (token !== this.copyToken || this.options.completion.done) return;
    this.copyBusy = false;
    this.copyAbort = null;
    if (copied) {
      this.showStatus(`Copied ${label}: ${summary} via ${copied.backend}`);
    } else {
      this.options.terminal.write(effect.sequence);
      this.showStatus(`OSC 52 fallback sent: ${summary} (unconfirmed)`);
    }
    this.draw();
  }

  private cancelCopy(): void {
    this.copyToken += 1;
    this.copyAbort?.abort();
    this.copyAbort = null;
    this.copyBusy = false;
  }

  private handleEffects(effects: readonly AdapterEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "yank") {
        if (effect.value.length === 0) {
          this.showStatus("Nothing to copy — preview is empty");
          continue;
        }
        this.startCopy(effect);
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
