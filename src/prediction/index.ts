import { DictionaryPredictionEngine } from "./dictionary";
import { JinenPredictionEngine } from "./jinen";
import type { PredictionBackend, PredictionEngine } from "./types";

export * from "./dictionary";
export * from "./jinen";
export * from "./models";
export * from "./types";

/** Build a predictor without loading a Jinen model. */
export function createPredictionEngine(
  backend: PredictionBackend,
): PredictionEngine {
  return backend === "dictionary"
    ? new DictionaryPredictionEngine()
    : new JinenPredictionEngine(backend);
}
