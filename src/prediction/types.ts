/** Prediction backends exposed by settings. */
export type PredictionBackend = "dictionary" | "jinen-xsmall" | "jinen-small";

export interface PredictionInput {
  readonly reading: string;
  readonly context?: string;
}

/** Model-independent kana-kanji prediction boundary. */
export interface PredictionEngine {
  readonly id: string;
  predict(input: PredictionInput): Promise<string>;
}
