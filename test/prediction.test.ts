import { describe, expect, test } from "bun:test";
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
  type JinenGenerationOptions,
  type JinenModelHandle,
  JinenPredictionEngine,
  type JinenRuntime,
  type PredictionEngine,
  type PredictionInput,
  predictWithFallback,
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
      { maxTokens: 64, temperature: 0, topK: 1 },
      { maxTokens: 256, temperature: 0, topK: 1 },
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

describe("local model metadata", () => {
  test("keeps paths, sizes, and download metadata central", () => {
    const xsmall = getModelMetadata("jinen-xsmall");
    const small = getModelMetadata("jinen-small");

    expect(xsmall).toEqual({
      id: "jinen-xsmall",
      label: "Jinen xsmall",
      filename: "jinen-v2-xsmall-Q5_K_M.gguf",
      size: 28_261_056,
      url: expect.stringContaining("jinen-v2-xsmall.gguf"),
    });
    expect(small).toEqual({
      id: "jinen-small",
      label: "Jinen small",
      filename: "jinen-v2-small-Q5_K_M.gguf",
      size: 81_117_824,
      url: expect.stringContaining("jinen-v2-small.gguf"),
    });
    expect(getModelPath("jinen-xsmall")).toBe(
      join(getModelDirectory(), xsmall.filename),
    );
    expect(basename(getModelPath("jinen-small"))).toBe(small.filename);

    const explicitDirectory = "/tmp/jpn-tui-models";
    expect(getModelPath("jinen-small", explicitDirectory)).toBe(
      join(explicitDirectory, small.filename),
    );
  });

  test("recognizes only exact-size final model files", () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-models-"));
    const finalPath = getModelPath("jinen-xsmall", directory);
    const partPath = `${finalPath}.part`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(finalPath, "");
      truncateSync(finalPath, getModelMetadata("jinen-xsmall").size);
      expect(isModelInstalled("jinen-xsmall", directory)).toBe(true);

      truncateSync(finalPath, getModelMetadata("jinen-xsmall").size - 1);
      expect(isModelInstalled("jinen-xsmall", directory)).toBe(false);

      rmSync(finalPath);
      writeFileSync(partPath, "");
      truncateSync(partPath, getModelMetadata("jinen-xsmall").size);
      expect(isModelInstalled("jinen-xsmall", directory)).toBe(false);
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
      expect(isModelInstalled("jinen-xsmall", directory)).toBe(false);
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
      expect(isModelInstalled("jinen-xsmall", directory)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
