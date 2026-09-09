import { describe, expect, test } from "bun:test";
import { Completion } from "../src/app";
import type { PredictionConfig } from "../src/config";
import { type ConversionResult, convert } from "../src/converter";
import type {
  JinenBackend,
  ModelDownloadOptions,
  PredictionEngine,
  PredictionInput,
} from "../src/prediction";
import { TuiSession, toOpenTuiCursorPosition } from "../src/tui";
import { serializeView, type TuiView } from "../src/view";

const converted = (value: string): ConversionResult => ({
  hiragana: `ひ:${value}`,
  katakana: `カ:${value}`,
  kanji: `辞書:${value}`,
});

function memoryStream(log: string[] = []): { write(value: string): void } {
  return { write: (value) => void log.push(value) };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface SessionFakes {
  readonly config?: PredictionConfig;
  readonly convert?: (value: string) => ConversionResult;
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
  readonly render?: (view: TuiView) => void;
}

function makeSession(options: SessionFakes = {}): {
  readonly completion: Completion;
  readonly session: TuiSession;
} {
  const completion = new Completion(memoryStream(), memoryStream());
  return {
    completion,
    session: new TuiSession({
      completion,
      terminal: memoryStream(),
      convert: options.convert ?? converted,
      config: options.config ?? { backend: "dictionary" },
      saveConfig: options.saveConfig ?? (() => {}),
      isModelInstalled: options.isModelInstalled ?? (() => false),
      downloadModel: options.downloadModel ?? (async () => "fake-model"),
      predictionEngineFactory:
        options.predictionEngineFactory ??
        ((backend) => ({
          id: backend,
          predict: async () => "予測",
        })),
      predictionDebounceMs: options.predictionDebounceMs ?? 1,
      render: options.render ?? (() => {}),
    }),
  };
}

function press(session: TuiSession, name: string, sequence = name): void {
  session.key({ name, sequence });
}

function openXsmallEngine(session: TuiSession): void {
  press(session, "s");
  press(session, "j");
  press(session, "j");
  press(session, "return", "\r");
  if (session.snapshot.screen === "prediction-engine") {
    if (session.snapshot.selectedRow === 0) press(session, "j");
    press(session, "return", "\r");
  }
}

async function settlePrediction(): Promise<void> {
  await Bun.sleep(10);
  await Promise.resolve();
}

function composerText(session: TuiSession): string {
  return serializeView(session.snapshot);
}

describe("OpenTUI cursor adapter", () => {
  test("converts zero-based view coordinates to one-based terminal coordinates", () => {
    expect(toOpenTuiCursorPosition({ x: 23, y: 3, visible: true })).toEqual({
      x: 24,
      y: 4,
      visible: true,
    });
  });

  test("preserves a hidden cursor while converting its coordinates", () => {
    expect(toOpenTuiCursorPosition({ x: 23, y: 3, visible: false })).toEqual({
      x: 24,
      y: 4,
      visible: false,
    });
  });
});

describe("TuiSession optional prediction", () => {
  test("does not download until explicit confirmation", () => {
    let downloads = 0;
    const fixture = makeSession({
      isModelInstalled: () => false,
      downloadModel: async () => {
        downloads += 1;
        return "fake-model";
      },
    });

    openXsmallEngine(fixture.session);
    expect(fixture.session.snapshot.screen).toBe("model-download");
    expect(downloads).toBe(0);
    fixture.completion.finish({ type: "quit" });
  });

  test("activates an installed model without downloading", () => {
    const saved: PredictionConfig[] = [];
    let downloads = 0;
    const fixture = makeSession({
      isModelInstalled: () => true,
      downloadModel: async () => {
        downloads += 1;
        return "fake-model";
      },
      saveConfig: (config) => saved.push(config),
    });

    openXsmallEngine(fixture.session);
    expect(fixture.session.snapshot).toMatchObject({
      screen: "settings",
      backend: "jinen-xsmall",
    });
    expect(downloads).toBe(0);
    expect(saved).toEqual([{ backend: "jinen-xsmall" }]);
    fixture.completion.finish({ type: "quit" });
  });

  test("activates and persists a backend after a confirmed successful download", async () => {
    const saved: PredictionConfig[] = [];
    const download = deferred<unknown>();
    const renders: TuiView[] = [];
    let downloads = 0;
    const fixture = makeSession({
      isModelInstalled: () => false,
      downloadModel: async () => {
        downloads += 1;
        return download.promise;
      },
      saveConfig: (config) => saved.push(config),
      render: (view) => renders.push(view),
    });

    openXsmallEngine(fixture.session);
    press(fixture.session, "return", "\r");
    expect(downloads).toBe(1);
    expect(saved).toEqual([]);
    renders.length = 0;

    download.resolve("fake-model");
    await settlePrediction();
    expect(fixture.session.snapshot).toMatchObject({
      screen: "settings",
      backend: "jinen-xsmall",
    });
    expect(renders.length).toBeGreaterThanOrEqual(1);
    expect(renders.at(-1)?.screen).toBe("settings");
    expect(saved).toEqual([{ backend: "jinen-xsmall" }]);
    fixture.completion.finish({ type: "quit" });
  });

  test("cancel leaves an uninstalled backend inactive", () => {
    const saved: PredictionConfig[] = [];
    let downloads = 0;
    const fixture = makeSession({
      isModelInstalled: () => false,
      downloadModel: async () => {
        downloads += 1;
        return "fake-model";
      },
      saveConfig: (config) => saved.push(config),
    });

    openXsmallEngine(fixture.session);
    press(fixture.session, "tab", "\t");
    press(fixture.session, "return", "\r");
    expect(fixture.session.snapshot.screen).toBe("prediction-engine");
    expect(downloads).toBe(0);
    expect(saved).toEqual([]);
    fixture.completion.finish({ type: "quit" });
  });

  test("Ctrl-C interrupts while a model download is active", async () => {
    const pending = deferred<unknown>();
    let downloads = 0;
    const fixture = makeSession({
      isModelInstalled: () => false,
      downloadModel: async () => {
        downloads += 1;
        return pending.promise;
      },
    });

    openXsmallEngine(fixture.session);
    press(fixture.session, "return", "\r");
    expect(downloads).toBe(1);
    fixture.session.key({ name: "c", sequence: "\x03", ctrl: true });
    expect(await fixture.completion.promise).toBe(130);
    pending.resolve("fake-model");
  });

  test("a failed download leaves the backend inactive and keeps error visible", async () => {
    const saved: PredictionConfig[] = [];
    const renders: TuiView[] = [];
    const fixture = makeSession({
      isModelInstalled: () => false,
      downloadModel: async () => {
        throw new Error("offline");
      },
      saveConfig: (config) => saved.push(config),
      render: (view) => renders.push(view),
    });

    openXsmallEngine(fixture.session);
    press(fixture.session, "return", "\r");
    await settlePrediction();
    expect(fixture.session.snapshot.screen).toBe("model-download");
    expect(composerText(fixture.session)).toContain("Download failed: offline");
    expect(renders.at(-1)?.screen).toBe("model-download");
    expect(saved).toEqual([]);
    fixture.completion.finish({ type: "quit" });
  });

  test("composer UI clearly identifies the enabled model regardless of focus or mode", async () => {
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
    });

    // In normal mode with candidate 1 (hiragana) focused (matching reported screenshot)
    expect(composerText(fixture.session)).toContain("Jinen xsmall");
    expect(composerText(fixture.session)).toContain("Kanji │ AI: Jinen xsmall");

    // Moving focus to candidate 2 (katakana)
    press(fixture.session, "j");
    expect(composerText(fixture.session)).toContain("Jinen xsmall");
    expect(composerText(fixture.session)).toContain("Kanji │ AI: Jinen xsmall");

    // In insert mode
    press(fixture.session, "i");
    fixture.session.paste("tabemono wa nani ga desuka");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("Jinen xsmall");
    expect(composerText(fixture.session)).toContain("Kanji │ AI: Jinen xsmall");

    fixture.completion.finish({ type: "quit" });
  });

  test("empty input does not schedule or create a predictor", async () => {
    let factories = 0;
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => {
        factories += 1;
        return { id: backend, predict: async () => "予測" };
      },
    });

    press(fixture.session, "i");
    await settlePrediction();
    expect(factories).toBe(0);
    expect(composerText(fixture.session)).toContain(
      "Kanji │ AI: Jinen xsmall · Skipped",
    );
    expect(composerText(fixture.session)).toContain(
      "AI input: not sent (no eligible input)",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("plain English and raw romaji do not create the predictor", async () => {
    let factories = 0;
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => {
        factories += 1;
        return { id: backend, predict: async () => "予測" };
      },
    });

    press(fixture.session, "i");
    fixture.session.paste("nihongo");
    await settlePrediction();
    expect(factories).toBe(0);
    expect(composerText(fixture.session)).toContain(
      "AI input: not sent (input not eligible)",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("debounce coalesces to the latest input and success changes only Kanji", async () => {
    const inputs: PredictionInput[] = [];
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          inputs.push(input);
          return "予測";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    fixture.session.paste("い");
    await settlePrediction();
    expect(inputs).toEqual([{ reading: "カ:あい", context: "" }]);
    expect(composerText(fixture.session)).toContain("1 ひらがな  ひ:あい");
    expect(composerText(fixture.session)).toContain("2 カタカナ  カ:あい");
    expect(composerText(fixture.session)).toContain("3 漢字  予測");
    expect(composerText(fixture.session)).not.toContain("辞書:あい");
    fixture.completion.finish({ type: "quit" });
  });

  test("passes Jinen the Katakana reading for a real kana-kanji input", async () => {
    const inputs: PredictionInput[] = [];
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      convert: () => ({
        hiragana: "わたしの",
        katakana: "ワタシノ",
        kanji: "私の",
      }),
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          inputs.push(input);
          return "私の";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("わたしの");
    await settlePrediction();

    expect(inputs).toEqual([{ reading: "ワタシノ", context: "" }]);
    expect(composerText(fixture.session)).toContain(
      "Kanji │ AI: Jinen xsmall · Generated",
    );
    expect(composerText(fixture.session)).toContain(
      "AI input: reading=ワタシノ context=∅ → result=私の",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("normalizes a mixed romaji foreign name before Jinen prediction", async () => {
    const inputs: PredictionInput[] = [];
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      convert,
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          inputs.push(input);
          return "予測";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("watashi no namae wa fadhil desu");
    await settlePrediction();

    expect(inputs).toEqual([
      { reading: "ワタシノナマエハファディルデス", context: "" },
    ]);
    expect(composerText(fixture.session)).toContain(
      "Kanji │ AI: Jinen xsmall · Generated",
    );
    expect(composerText(fixture.session)).toContain(
      "AI input: reading=ワタシノナマエハファディルデス context=∅ → result=予測",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("shows the exact processing input and AI result provenance", async () => {
    const pending = deferred<string>();
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async () => pending.promise,
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    await settlePrediction();
    const processing = composerText(fixture.session);
    expect(processing).toContain("Kanji │ AI: Jinen xsmall · Processing…");
    expect(processing).toContain("AI input: reading=カ:あ context=∅");
    expect(processing).not.toContain("result=");

    pending.resolve("予測");
    await settlePrediction();
    const generated = composerText(fixture.session);
    expect(generated).toContain("Kanji │ AI: Jinen xsmall · Generated");
    expect(generated).toContain(
      "AI input: reading=カ:あ context=∅ → result=予測",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("prediction failures and invalid outputs preserve the exact dictionary fallback", async () => {
    const outputs: Array<string | null> = [null, ""];
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async () => {
          const output = outputs.shift();
          if (output === null) throw new Error("prediction failed");
          return output ?? "unexpected";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("3 漢字  辞書:あ");
    expect(composerText(fixture.session)).toContain(
      "Kanji │ AI: Jinen xsmall · Failed → dictionary fallback",
    );
    expect(composerText(fixture.session)).toContain(
      "AI input: reading=カ:あ context=∅ → result=辞書:あ (prediction failed)",
    );
    press(fixture.session, "backspace", "\x7f");
    fixture.session.paste("い");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("3 漢字  辞書:い");
    expect(composerText(fixture.session)).toContain(
      "Kanji │ AI: Jinen xsmall · Dictionary fallback",
    );
    expect(composerText(fixture.session)).toContain(
      "AI input: reading=カ:い context=∅ → result=辞書:い (invalid AI output)",
    );
    fixture.completion.finish({ type: "quit" });
  });

  test("reuses the predictor engine cache across predictions", async () => {
    let factories = 0;
    let predictions = 0;
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => {
        factories += 1;
        return {
          id: backend,
          predict: async () => {
            predictions += 1;
            return "予測";
          },
        };
      },
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    await settlePrediction();
    press(fixture.session, "backspace", "\x7f");
    fixture.session.paste("い");
    await settlePrediction();
    expect(predictions).toBe(2);
    expect(factories).toBe(1);
    fixture.completion.finish({ type: "quit" });
  });

  test("stale asynchronous results cannot overwrite newer input", async () => {
    const pending = new Map<string, Deferred<string>>();
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          const result = deferred<string>();
          pending.set(input.reading, result);
          return result.promise;
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    await settlePrediction();
    press(fixture.session, "backspace", "\x7f");
    fixture.session.paste("い");
    await settlePrediction();
    expect([...pending.keys()]).toEqual(["カ:あ", "カ:い"]);
    pending.get("カ:あ")?.resolve("古い結果");
    await Promise.resolve();
    expect(composerText(fixture.session)).not.toContain("古い結果");
    pending.get("カ:い")?.resolve("新しい結果");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("3 漢字  新しい結果");
    fixture.completion.finish({ type: "quit" });
  });

  test("aggregates all prior Japanese segments and caps at 64 graphemes", async () => {
    let received: PredictionInput | undefined;
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          received = input;
          return "予測";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste(
      `昔の日本語 ${"あ".repeat(3)}${"カ".repeat(70)} 現在`,
    );
    await settlePrediction();
    expect(received?.context).toBe("カ".repeat(64));
    fixture.completion.finish({ type: "quit" });
  });

  test("keeps Japanese from all preceding segments", async () => {
    let received: PredictionInput | undefined;
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async (input) => {
          received = input;
          return "予測";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("昔の日本語 古い 日本語!? 現在");
    await settlePrediction();
    expect(received?.context).toBe("昔の日本語古い日本語");
    fixture.completion.finish({ type: "quit" });
  });

  test("a non-buffer key after AI success does not corrupt later deterministic fallback", async () => {
    const outputs: Array<string | null> = ["予測", null];
    const fixture = makeSession({
      config: { backend: "jinen-xsmall" },
      predictionEngineFactory: (backend) => ({
        id: backend,
        predict: async () => {
          const output = outputs.shift();
          if (output === null) throw new Error("later failure");
          return output ?? "予測";
        },
      }),
    });

    press(fixture.session, "i");
    fixture.session.paste("あ");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("3 漢字  予測");
    press(fixture.session, "escape", "\x1b");
    press(fixture.session, "j");
    press(fixture.session, "A");
    fixture.session.paste("い");
    await settlePrediction();
    expect(composerText(fixture.session)).toContain("3 漢字  辞書:あい");
    fixture.completion.finish({ type: "quit" });
  });
});
