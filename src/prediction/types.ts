/** Prediction backends exposed by settings. */
export type PredictionBackend = "dictionary" | "jinen-xsmall" | "jinen-small";

export interface PredictionInput {
  readonly reading: string;
  readonly context?: string;
}

/** Control channel for one prediction request; input stays pure data. */
export interface PredictionOptions {
  readonly signal?: AbortSignal;
}

/** Model-independent kana-kanji prediction boundary. */
export interface PredictionEngine {
  readonly id: string;
  predict(input: PredictionInput, options?: PredictionOptions): Promise<string>;
}
