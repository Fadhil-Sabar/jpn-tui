import { getModelPath, type JinenBackend } from "./models";
import type { PredictionEngine, PredictionInput } from "./types";

export const JINEN_CONTEXT_SIZE = 1024;
export const JINEN_MAX_CONTEXT = 64;
export const JINEN_MAX_TOKENS = 256;
export const JINEN_INPUT_MARKER = "\uEE00";
export const JINEN_OUTPUT_MARKER = "\uEE01";
export const JINEN_CONTEXT_MARKER = "\uEE02";

export interface JinenGenerationOptions {
  readonly maxTokens: number;
  readonly temperature: 0;
  readonly topK: 1;
}

export interface JinenModelHandle {
  generate(prompt: string, options: JinenGenerationOptions): Promise<unknown>;
}

export interface JinenRuntime {
  loadModel(
    modelPath: string,
    options: { readonly contextSize: number },
  ): Promise<JinenModelHandle>;
}

export class JinenPredictionError extends Error {
  readonly code: "RUNTIME" | "LOAD" | "INFERENCE" | "INVALID_OUTPUT";

  constructor(
    code: JinenPredictionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JinenPredictionError";
    this.code = code;
  }
}

/** Construct the NFKC prompt expected by Jinen. */
export function buildJinenPrompt(reading: string, context = ""): string {
  const boundedContext = Array.from(context.normalize("NFKC"))
    .slice(-JINEN_MAX_CONTEXT)
    .join("");
  return `${boundedContext ? `${JINEN_CONTEXT_MARKER}${boundedContext}` : ""}${JINEN_INPUT_MARKER}${reading}${JINEN_OUTPUT_MARKER}`.normalize(
    "NFKC",
  );
}

function outputText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const output = value.trim();
  if (
    output.length === 0 ||
    output.includes(JINEN_INPUT_MARKER) ||
    output.includes(JINEN_OUTPUT_MARKER) ||
    output.includes(JINEN_CONTEXT_MARKER) ||
    /[\p{Cc}\p{Cs}]/u.test(output) ||
    /[A-Za-z]/u.test(output) ||
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(output)
  ) {
    return undefined;
  }
  return output;
}

export function isValidJinenOutput(value: unknown): value is string {
  return outputText(value) !== undefined;
}

export function validateJinenOutput(value: unknown): string {
  const output = outputText(value);
  if (output === undefined) {
    throw new JinenPredictionError(
      "INVALID_OUTPUT",
      "Jinen returned an invalid kana-kanji conversion",
    );
  }
  return output;
}

async function createNodeLlamaRuntime(): Promise<JinenRuntime> {
  // Importing node-llama-cpp can load native bindings, so keep it off the
  // dictionary-only startup path.
  const nodeLlama = await import("node-llama-cpp");
  let llama: Awaited<ReturnType<typeof nodeLlama.getLlama>>;
  try {
    llama = await nodeLlama.getLlama({ gpu: false });
  } catch (error) {
    throw new JinenPredictionError(
      "RUNTIME",
      "Unable to initialise node-llama-cpp",
      { cause: error },
    );
  }

  return {
    async loadModel(modelPath, options): Promise<JinenModelHandle> {
      try {
        const model = await llama.loadModel({ modelPath });
        const context = await model.createContext({
          contextSize: options.contextSize,
        });
        const completion = new nodeLlama.LlamaCompletion({
          contextSequence: context.getSequence(),
          autoDisposeSequence: true,
        });
        return {
          generate: (prompt, generationOptions) =>
            completion.generateCompletion(prompt, generationOptions),
        };
      } catch (error) {
        throw new JinenPredictionError(
          "LOAD",
          `Unable to load Jinen model: ${modelPath}`,
          { cause: error },
        );
      }
    },
  };
}

let defaultRuntimePromise: Promise<JinenRuntime> | undefined;
function getJinenRuntime(): Promise<JinenRuntime> {
  defaultRuntimePromise ??= createNodeLlamaRuntime();
  return defaultRuntimePromise;
}

const runtimeModelCaches = new WeakMap<
  object,
  Map<string, Promise<JinenModelHandle>>
>();
const generationQueues = new WeakMap<object, Promise<void>>();

function cachedModel(
  runtime: JinenRuntime,
  modelPath: string,
): Promise<JinenModelHandle> {
  let cache = runtimeModelCaches.get(runtime);
  if (!cache) {
    cache = new Map();
    runtimeModelCaches.set(runtime, cache);
  }
  const existing = cache.get(modelPath);
  if (existing) return existing;

  const loading = runtime.loadModel(modelPath, {
    contextSize: JINEN_CONTEXT_SIZE,
  });
  cache.set(modelPath, loading);
  void loading.catch(() => cache?.delete(modelPath));
  return loading;
}

/** Serialize generations sharing one llama sequence. */
function queuedGeneration(
  model: JinenModelHandle,
  prompt: string,
  options: JinenGenerationOptions,
): Promise<unknown> {
  const previous = generationQueues.get(model) ?? Promise.resolve();
  const generation = previous.then(() => model.generate(prompt, options));
  generationQueues.set(
    model,
    generation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return generation;
}

/** Lazy local Jinen predictor. Construction does not load native code. */
export class JinenPredictionEngine implements PredictionEngine {
  readonly modelPath: string;

  constructor(
    readonly id: JinenBackend,
    private readonly runtime?: JinenRuntime,
  ) {
    this.modelPath = getModelPath(id);
  }

  async predict(input: PredictionInput): Promise<string> {
    if (input.reading.length === 0) {
      throw new JinenPredictionError(
        "INVALID_OUTPUT",
        "Jinen cannot convert an empty reading",
      );
    }

    const runtime = this.runtime ?? (await getJinenRuntime());
    let model: JinenModelHandle;
    try {
      model = await cachedModel(runtime, this.modelPath);
    } catch (error) {
      if (error instanceof JinenPredictionError) throw error;
      throw new JinenPredictionError(
        "LOAD",
        `Unable to load Jinen model: ${this.modelPath}`,
        { cause: error },
      );
    }

    const readingLength = Array.from(input.reading.normalize("NFKC")).length;
    try {
      const result = await queuedGeneration(
        model,
        buildJinenPrompt(input.reading, input.context),
        {
          maxTokens: Math.min(
            JINEN_MAX_TOKENS,
            Math.max(64, readingLength * 2),
          ),
          temperature: 0,
          topK: 1,
        },
      );
      return validateJinenOutput(result);
    } catch (error) {
      if (error instanceof JinenPredictionError) throw error;
      throw new JinenPredictionError("INFERENCE", "Jinen inference failed", {
        cause: error,
      });
    }
  }
}

/** Return exactly the supplied dictionary result on any prediction failure. */
export async function predictWithFallback(
  engine: PredictionEngine,
  input: PredictionInput,
  dictionaryFallback: string,
): Promise<string> {
  try {
    const result = await engine.predict(input);
    return isValidJinenOutput(result) ? result : dictionaryFallback;
  } catch {
    return dictionaryFallback;
  }
}
