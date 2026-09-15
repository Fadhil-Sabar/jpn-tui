import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DictionaryReader } from "../src/dictionary";
import {
  buildJinenPrompt,
  createPredictionEngine,
  DictionaryPredictionEngine,
  downloadModel,
  getModelDirectory,
  getModelMetadata,
  getModelPath,
  isModelInstalled,
  isValidJinenOutput,
  JINEN_CONTEXT_MARKER,
  JINEN_INPUT_MARKER,
  JINEN_MAX_CONTEXT,
  JINEN_OUTPUT_MARKER,
  JINEN_WORD_BOUNDARY_MARKER,
  type JinenGenerationOptions,
  type JinenModelHandle,
  JinenPredictionEngine,
  type JinenRuntime,
  type LocalModel,
  type PredictionEngine,
  type PredictionInput,
  PredictionSupersededError,
  predictWithFallback,
  verifyModelFile,
} from "../src/prediction";

interface FakeRuntimeFixture {
  readonly runtime: JinenRuntime;
  readonly loadCalls: () => number;
  readonly prompts: string[];
  readonly settings: JinenGenerationOptions[];
  readonly maxActive: () => number;
}

function fakeRuntime(outputs: unknown[], delay = 0): FakeRuntimeFixture {
  let loads = 0;
  let active = 0;
  let maximumActive = 0;
  const prompts: string[] = [];
  const settings: JinenGenerationOptions[] = [];
  const model: JinenModelHandle = {
    async generate(prompt, options) {
      prompts.push(prompt);
      settings.push(options);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (delay > 0) await Bun.sleep(delay);
      active -= 1;
      return outputs.shift() ?? "予測";
    },
  };
  return {
    runtime: {
      async loadModel() {
        loads += 1;
        return model;
      },
    },
    loadCalls: () => loads,
    prompts,
    settings,
    maxActive: () => maximumActive,
  };
}

async function settle(): Promise<void> {
  await Bun.sleep(5);
  await Promise.resolve();
}

describe("prediction engines", () => {
  test("keeps the requested engine boundary and dictionary segmentation", async () => {
    const dictionary: DictionaryReader = {
      lookup: (reading) =>
        reading === "かな"
          ? [{ reading, form: "仮名", rank: 1, kanaUsuallyWritten: false }]
          : [],
    };
    const engine: PredictionEngine = new DictionaryPredictionEngine(dictionary);

    expect(engine.id).toBe("dictionary");
    expect(await engine.predict({ reading: "かな", context: "前文" })).toBe(
      "仮名",
    );
  });

  test("factory construction is lazy for both Jinen backends", () => {
    expect(createPredictionEngine("jinen-xsmall").id).toBe("jinen-xsmall");
    expect(createPredictionEngine("jinen-small").id).toBe("jinen-small");
  });
});

describe("Jinen prompts and deterministic runtime", () => {
  test("normalizes input and caps context to its latest 64 code points", () => {
    const context = `${"a".repeat(JINEN_MAX_CONTEXT + 1)}Ａ`;
    expect(buildJinenPrompt("ｶﾅ", context)).toBe(
      `${JINEN_CONTEXT_MARKER}${"a".repeat(JINEN_MAX_CONTEXT - 1)}A` +
        `${JINEN_INPUT_MARKER}カナ${JINEN_OUTPUT_MARKER}`,
    );
  });

  test("uses dynamic maxTokens capped at 256 and caches the loaded model", async () => {
    const fixture = fakeRuntime(["短い", "長い"]);
    const engine = new JinenPredictionEngine("jinen-xsmall", fixture.runtime);

    expect(fixture.loadCalls()).toBe(0);
    expect(await engine.predict({ reading: "かな", context: "前" })).toBe(
      "短い",
    );
    expect(
      await engine.predict({ reading: "あ".repeat(200), context: "前" }),
    ).toBe("長い");
    expect(fixture.loadCalls()).toBe(1);
    expect(fixture.settings).toEqual([
      { maxTokens: 64, temperature: 0, topK: 1, stopOnAbortSignal: false },
      { maxTokens: 256, temperature: 0, topK: 1, stopOnAbortSignal: false },
    ]);
  });

  test("serializes concurrent generations sharing one sequence", async () => {
    const fixture = fakeRuntime(["一", "二"], 5);
    const engine = new JinenPredictionEngine("jinen-small", fixture.runtime);

    await expect(
      Promise.all([
        engine.predict({ reading: "かな" }),
        engine.predict({ reading: "にほん" }),
      ]),
    ).resolves.toEqual(["一", "二"]);
    expect(fixture.maxActive()).toBe(1);
    expect(fixture.loadCalls()).toBe(1);
  });

  test("accepts valid output and returns the exact fallback on errors or invalid output", async () => {
    expect(isValidJinenOutput("漢字")).toBe(true);
    expect(isValidJinenOutput(" ")).toBe(false);
    expect(isValidJinenOutput("123")).toBe(false);
    // A surviving sentencepiece boundary marker means the reading contained
    // whitespace, so the conversion cannot be trusted.
    expect(
      isValidJinenOutput(`これは${JINEN_WORD_BOUNDARY_MARKER}わたしの宿題`),
    ).toBe(false);
    const success: PredictionEngine = {
      id: "success",
      predict: async () => "成功",
    };
    const throwing: PredictionEngine = {
      id: "throwing",
      predict: async () => {
        throw new Error("runtime failed");
      },
    };
    const invalid: PredictionEngine = {
      id: "invalid",
      predict: async () => "123",
    };
    const input: PredictionInput = { reading: "かな", context: "前" };

    expect(await predictWithFallback(success, input, "辞書結果")).toBe("成功");
    expect(await predictWithFallback(throwing, input, "辞書結果")).toBe(
      "辞書結果",
    );
    expect(await predictWithFallback(invalid, input, "辞書結果")).toBe(
      "辞書結果",
    );
  });
});

describe("Jinen cancellation and scheduling", () => {
  test("forwards the signal and disables partial output on abort", async () => {
    const controller = new AbortController();
    let received: JinenGenerationOptions | undefined;
    const runtime: JinenRuntime = {
      async loadModel() {
        return {
          generate: (_prompt, options) => {
            received = options;
            return new Promise<unknown>((_resolve, reject) => {
              const abort = (): void =>
                reject(options.signal?.reason ?? new Error("aborted"));
              if (options.signal?.aborted) abort();
              options.signal?.addEventListener("abort", abort, { once: true });
            });
          },
        };
      },
    };
    const engine = new JinenPredictionEngine("jinen-xsmall", runtime);

    const prediction = engine.predict(
      { reading: "かな" },
      { signal: controller.signal },
    );
    await settle();
    expect(received?.signal).toBe(controller.signal);
    expect(received?.stopOnAbortSignal).toBe(false);

    controller.abort();
    await expect(prediction).rejects.toBeDefined();
  });

  test("checks cancellation before generation while loading", async () => {
    const controller = new AbortController();
    let generationStarted = false;
    const runtime: JinenRuntime = {
      async loadModel() {
        await Bun.sleep(10);
        return {
          generate: async () => {
            generationStarted = true;
            return "予測";
          },
        };
      },
    };
    const engine = new JinenPredictionEngine("jinen-xsmall", runtime);

    const prediction = engine.predict(
      { reading: "かな" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(prediction).rejects.toBeDefined();
    await settle();
    expect(generationStarted).toBe(false);
  });

  test("keeps one active and one latest pending generation", async () => {
    const gates: Array<(value: string) => void> = [];
    const runtime: JinenRuntime = {
      async loadModel() {
        return {
          generate: () =>
            new Promise<string>((resolve) => {
              gates.push(resolve);
            }),
        };
      },
    };
    const engine = new JinenPredictionEngine("jinen-small", runtime);

    const first = engine.predict({ reading: "あ" });
    const superseded = engine.predict({ reading: "い" });
    const latest = engine.predict({ reading: "う" });
    await expect(superseded).rejects.toBeInstanceOf(PredictionSupersededError);
    expect(gates).toHaveLength(1);

    gates[0]?.("一");
    await settle();
    expect(gates).toHaveLength(2);
    gates[1]?.("二");

    await expect(first).resolves.toBe("一");
    await expect(latest).resolves.toBe("二");
  });
});

describe("local model metadata", () => {
  test("keeps paths, sizes, revisions, and checksums central", () => {
    const xsmall = getModelMetadata("jinen-xsmall");
    const small = getModelMetadata("jinen-small");

    expect(xsmall).toEqual({
      id: "jinen-xsmall",
      label: "Jinen xsmall",
      filename: "jinen-v2-xsmall-Q5_K_M.gguf",
      size: 28_261_056,
      revision: "3910fd01bf4ba86eca89617f18db9b0c1c5b2283",
      sha256:
        "24ff3af5db712fbbb4aa9254ee28ec4d731207134471ab68b06c1828726284c2",
      url: expect.stringContaining(
        "/resolve/3910fd01bf4ba86eca89617f18db9b0c1c5b2283/",
      ),
    });
    expect(small).toEqual({
      id: "jinen-small",
      label: "Jinen small",
      filename: "jinen-v2-small-Q5_K_M.gguf",
      size: 81_117_824,
      revision: "3461d0573ab447985badde3174165b967d06076c",
      sha256:
        "80482707513d6b67dafc31774371cf95d765542abf8d74eebf5f32f92d788bd3",
      url: expect.stringContaining(
        "/resolve/3461d0573ab447985badde3174165b967d06076c/",
      ),
    });
    expect(getModelPath("jinen-xsmall")).toBe(
      join(getModelDirectory(), xsmall.filename),
    );
    expect(basename(getModelPath("jinen-small"))).toBe(small.filename);

    const explicitDirectory = "/tmp/jpn-tui-models";
    expect(getModelPath("jinen-small", explicitDirectory)).toBe(
      join(explicitDirectory, small.filename),
    );
    // URLs must never point at a mutable branch.
    expect(xsmall.url).not.toContain("/resolve/main/");
    expect(small.url).not.toContain("/resolve/main/");
  });

  test("verifies a byte-exact file and rejects a corrupted one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-verify-"));
    const path = join(directory, "tiny.gguf");
    const bytes = Buffer.from("jinen model bytes");
    const model: LocalModel = {
      id: "jinen-xsmall",
      label: "Tiny",
      filename: "tiny.gguf",
      size: bytes.length,
      url: "https://example.invalid/tiny.gguf",
      revision: "deadbeef",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    try {
      writeFileSync(path, bytes);
      expect(await verifyModelFile(path, model)).toBe(true);

      writeFileSync(path, Buffer.from("jinen model bytez"));
      expect(await verifyModelFile(path, model)).toBe(false);

      truncateSync(path, bytes.length - 1);
      expect(await verifyModelFile(path, model)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats only exact-size, byte-exact files as installed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-models-"));
    const finalPath = getModelPath("jinen-xsmall", directory);
    const partPath = `${finalPath}.part`;
    const expected = getModelMetadata("jinen-xsmall").size;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(finalPath, "");
      truncateSync(finalPath, expected);
      // Exact size but not the pinned bytes: still unavailable.
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);

      truncateSync(finalPath, expected - 1);
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);

      rmSync(finalPath);
      writeFileSync(partPath, "");
      truncateSync(partPath, expected);
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);

      rmSync(partPath);
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans a short injected download without installing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    try {
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          fetch: async () => new Response(new Uint8Array([1, 2, 3])),
        }),
      ).rejects.toThrow("expected");
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans an interrupted injected download without installing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    try {
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([1, 2, 3]));
                  controller.error(new Error("interrupted"));
                },
              }),
            ),
        }),
      ).rejects.toThrow("interrupted");
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an oversized payload before writing anything", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    const size = getModelMetadata("jinen-xsmall").size;
    try {
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          fetch: async () =>
            new Response(null, {
              headers: { "content-length": String(size + 1) },
            }),
        }),
      ).rejects.toThrow("larger than expected");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("times out a stalled body, cleans up, and allows a retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    try {
      const stalled = async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Never enqueue: the inactivity watchdog must fire.
            },
          }),
        );

      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          inactivityTimeoutMs: 20,
          fetch: stalled,
        }),
      ).rejects.toThrow("Timed out");
      expect(readdirSync(directory)).toEqual([]);

      // The partial file was removed, so a retry is not blocked by EEXIST.
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          inactivityTimeoutMs: 20,
          fetch: stalled,
        }),
      ).rejects.toThrow("Timed out");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("times out a connection that never responds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    try {
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          inactivityTimeoutMs: 20,
          fetch: () => new Promise<Response>(() => {}),
        }),
      ).rejects.toThrow("Timed out");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancels a stalled download on abort and removes the part file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    const controller = new AbortController();
    try {
      const download = downloadModel("jinen-xsmall", {
        directory,
        signal: controller.signal,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Never enqueue; the absolute signal must interrupt the read.
              },
            }),
          ),
      });
      controller.abort();
      await expect(download).rejects.toBeDefined();
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a download whose size matches but checksum does not", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-download-"));
    const size = getModelMetadata("jinen-xsmall").size;
    try {
      await expect(
        downloadModel("jinen-xsmall", {
          directory,
          fetch: async () => new Response(new Uint8Array(size)),
        }),
      ).rejects.toThrow("SHA-256");
      expect(await isModelInstalled("jinen-xsmall", directory)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
