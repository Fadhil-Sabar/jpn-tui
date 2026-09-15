import { segmentReading } from "../converter";
import { type DictionaryReader, getDictionary } from "../dictionary";
import type {
  PredictionEngine,
  PredictionInput,
  PredictionOptions,
} from "./types";

/**
 * Dictionary prediction delegates to the converter's existing segmentation.
 * It is synchronous, so cancellation is only observed before it starts.
 */
export class DictionaryPredictionEngine implements PredictionEngine {
  readonly id = "dictionary" as const;

  constructor(
    private readonly dictionary: DictionaryReader = getDictionary(),
  ) {}

  predict(
    input: PredictionInput,
    options?: PredictionOptions,
  ): Promise<string> {
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("Aborted"));
    }
    return Promise.resolve(segmentReading(input.reading, this.dictionary));
  }
}
