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
  type OpenTuiKeyLike,
  type Writable,
} from "./app";
import { type ComposerState, createInitialState } from "./composer";
import { type ConversionResult, convert } from "./converter";
import {
  closeDefaultDictionary,
  DictionaryError,
  getDictionary,
} from "./dictionary";
import {
  type ComposerView,
  displayWidth,
  renderView,
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
  readonly render: (view: ComposerView) => void;
  readonly width?: number;
  readonly height?: number;
  readonly statusDurationMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Testable state/effect driver. OpenTUI is only responsible for terminal I/O. */
export class TuiSession {
  private state: ComposerState = createInitialState();
  private preview: ConversionResult = { hiragana: "", katakana: "", kanji: "" };
  private width: number;
  private height: number;
  private status: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly convertValue: (value: string) => ConversionResult;

  constructor(private readonly options: TuiSessionOptions) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    this.convertValue = options.convert ?? convert;
    options.completion.addCleanup(() => {
      if (this.statusTimer !== undefined) clearTimeout(this.statusTimer);
    });
  }

  get snapshot(): ComposerView {
    return renderView(this.state, this.preview, this.width, this.height, {
      status: this.status,
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
      const update = applyAdapterKey(
        this.state,
        this.preview,
        event,
        this.convertValue,
      );
      this.state = update.state;
      this.preview = update.preview;
      this.handleEffects(update.effects);
      this.draw();
    } catch (error) {
      this.fail(error);
    }
  }

  paste(value: string): void {
    if (this.options.completion.done) return;
    try {
      const update = applyPaste(
        this.state,
        this.preview,
        value,
        this.convertValue,
      );
      this.state = update.state;
      this.preview = update.preview;
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

  private handleEffects(effects: readonly AdapterEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "yank") {
        this.options.terminal.write(effect.sequence);
        this.showStatus("Clipboard sequence sent");
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

function paint(renderer: CliRenderer, view: ComposerView): void {
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
