import { segmentReading } from "../converter";
import { type DictionaryReader, getDictionary } from "../dictionary";
import type { PredictionEngine, PredictionInput } from "./types";

/** Dictionary prediction delegates to the converter's existing segmentation. */
export class DictionaryPredictionEngine implements PredictionEngine {
  readonly id = "dictionary" as const;

  constructor(
    private readonly dictionary: DictionaryReader = getDictionary(),
  ) {}

  predict(input: PredictionInput): Promise<string> {
    return Promise.resolve(segmentReading(input.reading, this.dictionary));
  }
}
