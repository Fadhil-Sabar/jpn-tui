import {
  type ComposerEffect,
  type ComposerState,
  composerReducer,
  graphemes,
  keyAction,
} from "./composer";
import type { ConversionResult } from "./converter";

export interface OpenTuiKeyLike {
  readonly name: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
}

export interface AdapterAction {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export type AdapterEffect =
  | { readonly type: "submit"; readonly value: string }
  | { readonly type: "yank"; readonly value: string; readonly sequence: string }
  | { readonly type: "quit" }
  | { readonly type: "interrupt" };

export interface AppUpdate {
  readonly state: ComposerState;
  readonly preview: ConversionResult;
  readonly effects: readonly AdapterEffect[];
}

const namedKeys: Readonly<Record<string, string>> = {
  return: "Enter",
  enter: "Enter",
  linefeed: "Enter",
  escape: "Esc",
  esc: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  up: "Up",
  down: "Down",
};

/** Translate OpenTUI 0.5 key events into the composer reducer vocabulary. */
export function mapOpenTuiKey(event: OpenTuiKeyLike): AdapterAction {
  const lowerName = event.name.toLowerCase();
  let key: string;
  let ctrl = event.ctrl === true;
  if (event.sequence === "\x03") {
    // Some terminal parsers expose ETX without annotating its Ctrl modifier.
    key = "c";
    ctrl = true;
  } else if (lowerName === "tab") {
    key = event.shift ? "Shift-Tab" : "Tab";
  } else if (lowerName === "space") {
    key = " ";
  } else if (ctrl && /^[a-z]$/i.test(event.name)) {
    // OpenTUI keeps the printable key name alongside the control sequence.
    // The reducer needs the former so it can recognise Ctrl-W/U, etc.
    key = event.name;
  } else {
    key = namedKeys[lowerName] ?? event.sequence ?? event.name;
  }
  return {
    key,
    ctrl,
    shift: event.shift === true,
    alt: event.meta === true || event.option === true,
  };
}

export function selectedPreview(
  preview: ConversionResult,
  focus: number,
): string {
  return [preview.hiragana, preview.katakana, preview.kanji][focus] ?? "";
}

/** Exact OSC 52 clipboard sequence (BEL terminated) for the terminal. */
export function osc52Sequence(value: string): string {
  return `\x1b]52;c;${Buffer.from(value, "utf8").toString("base64")}\x07`;
}

function adaptEffect(
  effect: ComposerEffect,
  preview: ConversionResult,
): AdapterEffect {
  // Deliberately select from the preview. reducer effect.value is the source
  // buffer and is not the value represented by a conversion row.
  const value = selectedPreview(preview, effect.focus);
  switch (effect.type) {
    case "submit":
      return { type: "submit", value };
    case "yank":
      return { type: "yank", value, sequence: osc52Sequence(value) };
    case "quit":
      return { type: "quit" };
    case "interrupt":
      return { type: "interrupt" };
  }
}

export function applyAdapterKey(
  state: ComposerState,
  preview: ConversionResult,
  event: OpenTuiKeyLike | AdapterAction,
  convert: (value: string) => ConversionResult,
): AppUpdate {
  const action =
    "sequence" in event || "name" in event
      ? mapOpenTuiKey(event as OpenTuiKeyLike)
      : event;
  const result = composerReducer(
    state,
    keyAction(action.key, {
      ctrl: action.ctrl,
      shift: action.shift,
      alt: action.alt,
    }),
  );
  const nextPreview =
    result.state.buffer === state.buffer
      ? preview
      : convert(result.state.buffer);
  return {
    state: result.state,
    preview: nextPreview,
    effects: result.effects.map((effect) => adaptEffect(effect, nextPreview)),
  };
}

/** Paste only into INSERT mode, one grapheme at a time, after removing CR/LF. */
export function applyPaste(
  state: ComposerState,
  preview: ConversionResult,
  pasted: string,
  convert: (value: string) => ConversionResult,
): AppUpdate {
  if (state.mode !== "INSERT") {
    return { state, preview, effects: [] };
  }
  let nextState = state;
  const effects: AdapterEffect[] = [];
  const oneLine = pasted.replace(/[\r\n]/g, "");
  for (const part of graphemes(oneLine)) {
    const result = composerReducer(nextState, keyAction(part));
    nextState = result.state;
  }
  const nextPreview =
    nextState.buffer === state.buffer ? preview : convert(nextState.buffer);
  return { state: nextState, preview: nextPreview, effects };
}

export type CompletionReason =
  | { readonly type: "submit"; readonly value: string }
  | { readonly type: "quit" }
  | { readonly type: "interrupt" }
  | { readonly type: "signal"; readonly code: number }
  | {
      readonly type: "fatal";
      readonly message: string;
      readonly code?: number;
    };

export interface Destroyable {
  destroy(): void;
}

export interface Writable {
  write(value: string): unknown;
}

/** Idempotent shutdown ordering, isolated so it can be tested without a PTY. */
export class Completion {
  private renderer: Destroyable | undefined;
  private finished = false;
  private readonly cleanups: Array<() => void> = [];
  private resolve!: (code: number) => void;
  readonly promise: Promise<number>;

  constructor(
    private readonly stdout: Writable,
    private readonly stderr: Writable,
  ) {
    this.promise = new Promise<number>((resolve) => {
      this.resolve = resolve;
    });
  }

  get done(): boolean {
    return this.finished;
  }

  attach(renderer: Destroyable): void {
    if (this.finished) renderer.destroy();
    else this.renderer = renderer;
  }

  addCleanup(cleanup: () => void): void {
    if (this.finished) cleanup();
    else this.cleanups.push(cleanup);
  }

  finish(reason: CompletionReason): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.renderer?.destroy();
    } catch {
      // A renderer failure must not prevent the remaining terminal cleanup.
    }
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Cleanup is best-effort; always run every registered callback.
      }
    }

    let code = 0;
    if (reason.type === "interrupt") code = 130;
    if (reason.type === "signal") code = reason.code;
    if (reason.type === "fatal") code = reason.code ?? 1;
    try {
      if (reason.type === "submit") this.stdout.write(`${reason.value}\n`);
      if (reason.type === "fatal") this.stderr.write(`${reason.message}\n`);
    } finally {
      this.resolve(code);
    }
  }
}
