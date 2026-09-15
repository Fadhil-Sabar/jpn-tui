import { getModelPath, type JinenBackend } from "./models";
import type {
  PredictionEngine,
  PredictionInput,
  PredictionOptions,
} from "./types";

export const JINEN_CONTEXT_SIZE = 1024;
export const JINEN_MAX_CONTEXT = 64;
export const JINEN_MAX_TOKENS = 256;
export const JINEN_INPUT_MARKER = "\uEE00";
export const JINEN_OUTPUT_MARKER = "\uEE01";
export const JINEN_CONTEXT_MARKER = "\uEE02";
/**
 * SentencePiece's word-boundary marker. It is emitted as literal text when a
 * reading contains whitespace, so a surviving marker means the input was
 * malformed and the result cannot be trusted.
 */
export const JINEN_WORD_BOUNDARY_MARKER = "\u2581";

export interface JinenGenerationOptions {
  readonly maxTokens: number;
  readonly temperature: 0;
  readonly topK: 1;
  readonly signal?: AbortSignal;
  /** Disabled so an aborted generation throws instead of returning a prefix. */
  readonly stopOnAbortSignal: false;
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

/** A pending request dropped because a newer one replaced it. */
export class PredictionSupersededError extends Error {
  constructor() {
    super("Superseded by a newer prediction request");
    this.name = "PredictionSupersededError";
  }
}

function abortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ??
    new JinenPredictionError("INFERENCE", "Jinen prediction aborted")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
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
    output.includes(JINEN_WORD_BOUNDARY_MARKER) ||
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

interface QueueEntry<T> {
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Run one generation at a time per model sequence and keep only the most
 * recent request waiting behind it. A flooded composer therefore never builds
 * an unbounded backlog of stale generations.
 */
class LatestQueue {
  private active: QueueEntry<unknown> | null = null;
  private pending: QueueEntry<unknown> | null = null;

  submit<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const entry: QueueEntry<unknown> = {
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
      };
      if (signal) {
        entry.onAbort = () => {
          if (this.pending !== entry) return;
          this.pending = null;
          this.detach(entry);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      if (this.active === null) {
        this.start(entry);
        return;
      }
      if (this.pending) {
        const superseded = this.pending;
        this.pending = null;
        this.detach(superseded);
        superseded.reject(new PredictionSupersededError());
      }
      this.pending = entry;
    });
  }

  private detach(entry: QueueEntry<unknown>): void {
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = undefined;
    }
  }

  private start(entry: QueueEntry<unknown>): void {
    this.active = entry;
    entry.run().then(
      (value) => {
        this.detach(entry);
        entry.resolve(value);
        this.finish(entry);
      },
      (error) => {
        this.detach(entry);
        entry.reject(error);
        this.finish(entry);
      },
    );
  }

  private finish(entry: QueueEntry<unknown>): void {
    if (this.active !== entry) return;
    this.active = null;
    while (this.pending) {
      const next = this.pending;
      this.pending = null;
      if (next.signal?.aborted) {
        this.detach(next);
        next.reject(abortReason(next.signal));
        continue;
      }
      this.start(next);
      return;
    }
  }
}

const modelSchedulers = new WeakMap<object, LatestQueue>();

function schedulerFor(model: JinenModelHandle): LatestQueue {
  let scheduler = modelSchedulers.get(model);
  if (!scheduler) {
    scheduler = new LatestQueue();
    modelSchedulers.set(model, scheduler);
  }
  return scheduler;
}

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

/** Lazy local Jinen predictor. Construction does not load native code. */
export class JinenPredictionEngine implements PredictionEngine {
  readonly modelPath: string;

  constructor(
    readonly id: JinenBackend,
    private readonly runtime?: JinenRuntime,
  ) {
    this.modelPath = getModelPath(id);
  }

  async predict(
    input: PredictionInput,
    options: PredictionOptions = {},
  ): Promise<string> {
    if (input.reading.length === 0) {
      throw new JinenPredictionError(
        "INVALID_OUTPUT",
        "Jinen cannot convert an empty reading",
      );
    }

    const signal = options.signal;
    throwIfAborted(signal);
    const runtime = this.runtime ?? (await getJinenRuntime());
    throwIfAborted(signal);
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
    // Loading can be slow on first use; re-check before touching the sequence.
    throwIfAborted(signal);

    const readingLength = Array.from(input.reading.normalize("NFKC")).length;
    const prompt = buildJinenPrompt(input.reading, input.context);
    const generationOptions: JinenGenerationOptions = {
      maxTokens: Math.min(JINEN_MAX_TOKENS, Math.max(64, readingLength * 2)),
      temperature: 0,
      topK: 1,
      stopOnAbortSignal: false,
      ...(signal ? { signal } : {}),
    };

    try {
      return await schedulerFor(model).submit(() => {
        throwIfAborted(signal);
        return model
          .generate(prompt, generationOptions)
          .then(validateJinenOutput);
      }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof PredictionSupersededError) throw error;
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
  options?: PredictionOptions,
): Promise<string> {
  try {
    const result = await engine.predict(input, options);
    return isValidJinenOutput(result) ? result : dictionaryFallback;
  } catch {
    return dictionaryFallback;
  }
}
