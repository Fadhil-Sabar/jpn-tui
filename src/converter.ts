import { toHiragana, toKatakana } from "wanakana";
import {
  type DictionaryEntry,
  type DictionaryReader,
  getDictionary,
} from "./dictionary";

export interface ConversionResult {
  readonly hiragana: string;
  readonly katakana: string;
  readonly kanji: string;
}

export interface ConverterOptions {
  readonly dictionary?: DictionaryReader;
}

const asciiLetter = /^[A-Za-z]$/;
const whitespace = /^\s$/u;
const kana = /^[\u3040-\u309f\u30a0-\u30ffー]$/u;
const apostrophe = /^[\u0027\u2019]$/u;
const asciiResidue = /[A-Za-z]/u;
const PARTICLES: ReadonlyMap<string, string> = new Map([
  ["wa", "は"],
  ["o", "を"],
  ["wo", "を"],
  ["e", "へ"],
  ["ga", "が"],
  ["ni", "に"],
  ["de", "で"],
  ["to", "と"],
  ["mo", "も"],
  ["no", "の"],
  ["kara", "から"],
  ["made", "まで"],
] as const);
const PARTICLE_READINGS = [...new Set(PARTICLES.values())].sort(
  (left, right) => Array.from(right).length - Array.from(left).length,
);

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && asciiLetter.test(value);
}

function isKanaCharacter(value: string | undefined): boolean {
  return value !== undefined && kana.test(value);
}

function isRomajiApostrophe(chars: readonly string[], index: number): boolean {
  return (
    apostrophe.test(chars[index] ?? "") &&
    isAsciiLetter(chars[index - 1]) &&
    isAsciiLetter(chars[index + 1])
  );
}

/**
 * Convert a word only when WanaKana consumed the complete word. WanaKana is
 * intentionally permissive (`hello` becomes `へlぉ`), which is useful for an
 * IME but destructive for a composer that also accepts ordinary text.
 */
function convertRomajiWord(value: string): string | undefined {
  if (!/[A-Za-z]/u.test(value)) return undefined;
  const converted = toHiragana(value.toLowerCase().replaceAll("\u2019", "'"));
  return asciiResidue.test(converted) ? undefined : converted;
}

/**
 * Foreign names sometimes use a terminal `l`, which WanaKana does not map.
 * Keep this exception local to the mixed-script Kanji fallback.
 */
function convertRomajiWordWithTerminalL(value: string): string | undefined {
  const converted = convertRomajiWord(value);
  if (converted !== undefined) return converted;
  if (!/l$/iu.test(value)) return undefined;
  return convertRomajiWord(`${value.slice(0, -1)}ru`);
}

type InputToken =
  | { readonly kind: "space"; readonly text: string }
  | {
      readonly kind: "romaji";
      readonly text: string;
      readonly converted: string | undefined;
    }
  | { readonly kind: "kana"; readonly text: string; readonly converted: string }
  | { readonly kind: "literal"; readonly text: string };

function tokenise(value: string): InputToken[] {
  const chars = Array.from(value);
  const tokens: InputToken[] = [];
  let index = 0;

  while (index < chars.length) {
    const character = chars[index];
    if (whitespace.test(character)) {
      const start = index;
      while (index < chars.length && whitespace.test(chars[index])) index += 1;
      tokens.push({ kind: "space", text: chars.slice(start, index).join("") });
      continue;
    }

    if (isAsciiLetter(character)) {
      const start = index;
      index += 1;
      while (index < chars.length) {
        if (isAsciiLetter(chars[index])) {
          index += 1;
          continue;
        }
        if (isRomajiApostrophe(chars, index)) {
          index += 1;
          continue;
        }
        break;
      }
      const text = chars.slice(start, index).join("");
      tokens.push({ kind: "romaji", text, converted: convertRomajiWord(text) });
      continue;
    }

    if (isKanaCharacter(character)) {
      const start = index;
      while (index < chars.length && isKanaCharacter(chars[index])) index += 1;
      const text = chars.slice(start, index).join("");
      tokens.push({ kind: "kana", text, converted: toHiragana(text) });
      continue;
    }

    tokens.push({ kind: "literal", text: character });
    index += 1;
  }

  return tokens;
}

function previousToken(
  tokens: readonly InputToken[],
  index: number,
): InputToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].kind !== "space") return tokens[cursor];
  }
  return undefined;
}

function nextToken(
  tokens: readonly InputToken[],
  index: number,
): InputToken | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].kind !== "space") return tokens[cursor];
  }
  return undefined;
}

function isConvertibleRomaji(token: InputToken | undefined): boolean {
  return token?.kind === "romaji" && token.converted !== undefined;
}

function isSpaceDelimitedRomaji(
  tokens: readonly InputToken[],
  index: number,
): boolean {
  return (
    tokens[index]?.kind === "romaji" &&
    (index === 0 || tokens[index - 1].kind === "space") &&
    (index === tokens.length - 1 || tokens[index + 1].kind === "space")
  );
}

function isJapanesePhraseToken(
  token: InputToken | undefined,
  dictionary: DictionaryReader,
): boolean {
  if (token?.kind === "kana") return true;
  if (token?.kind !== "romaji" || token.converted === undefined) return false;
  return (
    PARTICLES.has(token.text.toLowerCase()) ||
    dictionary.lookup(token.converted).length > 0
  );
}

/** Offsets of reading spans that should be rendered as Katakana fallback. */
export interface KatakanaFallbackRange {
  readonly start: number;
  readonly stop: number;
}

interface PreparedReading {
  readonly reading: string;
  readonly grammaticalParticleOffsets: readonly number[];
  readonly katakanaFallbackRanges: readonly KatakanaFallbackRange[];
}

function prepareReading(
  value: string,
  markGrammaticalParticles: boolean,
  dictionary?: DictionaryReader,
  markKatakanaFallbacks = markGrammaticalParticles,
): PreparedReading {
  const tokens = tokenise(value);
  const katakanaFallbackConversions = new Map<InputToken, string>();

  if (markKatakanaFallbacks && dictionary !== undefined) {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (
        token.kind !== "romaji" ||
        PARTICLES.has(token.text.toLowerCase()) ||
        !isSpaceDelimitedRomaji(tokens, index)
      ) {
        continue;
      }
      const conversion = convertRomajiWordWithTerminalL(token.text);
      const previous =
        index >= 2 && tokens[index - 1].kind === "space"
          ? tokens[index - 2]
          : undefined;
      const next =
        index + 2 < tokens.length && tokens[index + 1].kind === "space"
          ? tokens[index + 2]
          : undefined;
      if (
        conversion !== undefined &&
        dictionary.lookup(conversion).length === 0 &&
        isJapanesePhraseToken(previous, dictionary) &&
        isJapanesePhraseToken(next, dictionary)
      ) {
        katakanaFallbackConversions.set(token, conversion);
      }
    }
  }

  const output: string[] = [];
  const grammaticalParticleOffsets: number[] = [];
  const katakanaFallbackRanges: KatakanaFallbackRange[] = [];
  let outputLength = 0;

  const append = (text: string): void => {
    output.push(text);
    outputLength += Array.from(text).length;
  };
  const conversionForKanji = (token: InputToken): string | undefined =>
    token.kind === "romaji"
      ? (token.converted ?? katakanaFallbackConversions.get(token))
      : undefined;
  const isConvertibleForKanji = (token: InputToken | undefined): boolean =>
    token !== undefined && conversionForKanji(token) !== undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "space") {
      const previous = previousToken(tokens, index);
      const next = nextToken(tokens, index);
      if (isConvertibleForKanji(previous) && isConvertibleForKanji(next)) {
        continue;
      }
      append(token.text);
      continue;
    }

    if (token.kind === "romaji") {
      const conversion = conversionForKanji(token);
      if (conversion === undefined) {
        append(token.text);
      } else {
        const particle = PARTICLES.get(token.text.toLowerCase());
        const boundedBySpaces =
          (index === 0 || tokens[index - 1].kind === "space") &&
          (index === tokens.length - 1 || tokens[index + 1].kind === "space");
        const hasPhraseNeighbour =
          isConvertibleRomaji(previousToken(tokens, index)) ||
          isConvertibleRomaji(nextToken(tokens, index));
        if (
          markGrammaticalParticles &&
          particle !== undefined &&
          boundedBySpaces &&
          hasPhraseNeighbour
        ) {
          grammaticalParticleOffsets.push(outputLength);
          append(particle);
        } else {
          const start = outputLength;
          append(conversion);
          if (katakanaFallbackConversions.has(token)) {
            katakanaFallbackRanges.push({ start, stop: outputLength });
          }
        }
      }
      continue;
    }

    append(token.kind === "kana" ? token.converted : token.text);
  }

  return {
    reading: output.join(""),
    grammaticalParticleOffsets,
    katakanaFallbackRanges,
  };
}

/** Convert romaji and existing kana while leaving ordinary text untouched. */
function romaniseToHiragana(value: string): string {
  return prepareReading(value, false).reading;
}

/** Convert only kana runs; punctuation, symbols, numbers, and plain text stay exact. */
function toKatakanaPreservingPunctuation(value: string): string {
  const chars = Array.from(value);
  let output = "";
  let index = 0;
  while (index < chars.length) {
    if (!isKanaCharacter(chars[index])) {
      output += chars[index];
      index += 1;
      continue;
    }
    const start = index;
    while (index < chars.length && isKanaCharacter(chars[index])) index += 1;
    output += toKatakana(chars.slice(start, index).join(""));
  }
  return output;
}

/**
 * Build the Katakana-only reading used by Jinen.
 *
 * The visible Katakana candidate intentionally preserves ordinary or
 * incomplete ASCII text. Jinen, however, expects a Katakana reading. Reuse
 * the dictionary-aware preparation used by the Kanji candidate so a
 * contextual foreign-name fallback (for example terminal `l` in `fadhil`)
 * is transliterated, without treating arbitrary ASCII as eligible input.
 */
export function toJinenReading(
  value: string,
  options?: ConverterOptions | DictionaryReader,
): string {
  if (value.length === 0) return "";
  const dictionary = dictionaryFromOptions(options);
  return toKatakanaPreservingPunctuation(
    // Keep the written particle form (`wa` → `ハ`) expected by Jinen while
    // reusing the contextual unknown-name fallback from Kanji preparation.
    prepareReading(value, true, dictionary, true).reading,
  );
}

function isKana(value: string): boolean {
  return /^[\u3040-\u309f\u30a0-\u30ffー]+$/u.test(value);
}

function compareEntries(left: DictionaryEntry, right: DictionaryEntry): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.kanaUsuallyWritten !== right.kanaUsuallyWritten) {
    return left.kanaUsuallyWritten ? -1 : 1;
  }
  const leftKana = isKana(left.form);
  const rightKana = isKana(right.form);
  if (leftKana !== rightKana) return leftKana ? -1 : 1;
  return left.form < right.form ? -1 : left.form > right.form ? 1 : 0;
}

interface Route {
  readonly covered: number;
  readonly rank: number;
  readonly segments: number;
  readonly matchLengths: readonly number[];
  readonly kanaPenalty: number;
  readonly formPenalty: number;
  readonly output: string;
}

function compareRoutes(left: Route, right: Route): number {
  if (left.covered !== right.covered)
    return left.covered > right.covered ? -1 : 1;
  // Prefer the longest dictionary edge at the earliest differing offset.
  const lengthCount = Math.max(
    left.matchLengths.length,
    right.matchLengths.length,
  );
  for (let index = 0; index < lengthCount; index += 1) {
    const leftLength = left.matchLengths[index] ?? 0;
    const rightLength = right.matchLengths[index] ?? 0;
    if (leftLength !== rightLength) return leftLength > rightLength ? -1 : 1;
  }
  if (left.segments !== right.segments) {
    return left.segments < right.segments ? -1 : 1;
  }
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1;
  if (left.kanaPenalty !== right.kanaPenalty) {
    return left.kanaPenalty < right.kanaPenalty ? -1 : 1;
  }
  if (left.formPenalty !== right.formPenalty) {
    return left.formPenalty < right.formPenalty ? -1 : 1;
  }
  return left.output < right.output ? -1 : left.output > right.output ? 1 : 0;
}

function betterRoute(left: Route, right: Route | undefined): Route {
  return right === undefined || compareRoutes(left, right) < 0 ? left : right;
}

export interface SegmentationOptions {
  /** Offsets of space-delimited romaji particles that must remain kana. */
  readonly grammaticalParticleOffsets?: readonly number[];
  /** Reading spans for unknown phrase tokens that should render as Katakana. */
  readonly katakanaFallbackRanges?: readonly KatakanaFallbackRange[];
}

/**
 * Segment a hiragana reading with a longest-coverage dynamic program. Exact
 * dictionary lookups are used for every edge; an absent edge consumes one
 * grapheme and passes it through unchanged.
 */
export function segmentReading(
  reading: string,
  dictionary: DictionaryReader,
  options: SegmentationOptions = {},
): string {
  const parts = Array.from(reading);
  const forcedParticles = new Map<number, string>();
  for (const offset of options.grammaticalParticleOffsets ?? []) {
    const particle = PARTICLE_READINGS.find(
      (candidate) =>
        parts.slice(offset, offset + Array.from(candidate).length).join("") ===
        candidate,
    );
    if (particle !== undefined) forcedParticles.set(offset, particle);
  }
  const katakanaFallbacks = new Map<number, string>();
  for (const range of options.katakanaFallbackRanges ?? []) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.stop) ||
      range.start < 0 ||
      range.stop <= range.start ||
      range.stop > parts.length
    ) {
      continue;
    }
    const spelling = parts.slice(range.start, range.stop).join("");
    if (dictionary.lookup(spelling).length === 0) {
      katakanaFallbacks.set(range.start, spelling);
    }
  }
  const forcedRanges = [
    ...[...forcedParticles].map(([start, particle]) => ({
      start,
      stop: start + Array.from(particle).length,
    })),
    ...[...katakanaFallbacks].map(([start, spelling]) => ({
      start,
      stop: start + Array.from(spelling).length,
    })),
  ];
  const overlapsForcedRange = (start: number, stop: number): boolean =>
    forcedRanges.some(
      (range) =>
        start < range.stop &&
        stop > range.start &&
        (start !== range.start || stop !== range.stop),
    );
  const routes: Array<Route | undefined> = Array(parts.length + 1);
  routes[parts.length] = {
    covered: 0,
    rank: 0,
    segments: 0,
    matchLengths: [],
    kanaPenalty: 0,
    formPenalty: 0,
    output: "",
  };
  const maximum = Math.max(1, dictionary.maxReadingLength ?? 32);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const forcedParticle = forcedParticles.get(index);
    if (forcedParticle !== undefined) {
      const length = Array.from(forcedParticle).length;
      const tail = routes[index + length];
      if (tail !== undefined) {
        routes[index] = {
          covered: length + tail.covered,
          rank: tail.rank,
          segments: 1 + tail.segments,
          matchLengths: [length, ...tail.matchLengths],
          kanaPenalty: tail.kanaPenalty,
          formPenalty: tail.formPenalty,
          output: forcedParticle + tail.output,
        };
      }
      continue;
    }

    const forcedKatakana = katakanaFallbacks.get(index);
    if (forcedKatakana !== undefined) {
      const length = Array.from(forcedKatakana).length;
      const tail = routes[index + length];
      if (tail !== undefined) {
        routes[index] = {
          covered: tail.covered,
          rank: tail.rank,
          segments: 1 + tail.segments,
          matchLengths: [0, ...tail.matchLengths],
          kanaPenalty: tail.kanaPenalty,
          formPenalty: tail.formPenalty,
          output: toKatakana(forcedKatakana) + tail.output,
        };
      }
      continue;
    }

    const fallback = routes[index + 1];
    if (fallback === undefined) continue;
    let best: Route = {
      covered: fallback.covered,
      rank: fallback.rank,
      segments: fallback.segments,
      matchLengths: [0, ...fallback.matchLengths],
      kanaPenalty: fallback.kanaPenalty,
      formPenalty: fallback.formPenalty,
      output: parts[index] + fallback.output,
    };

    const end = Math.min(parts.length, index + maximum);
    for (let stop = index + 1; stop <= end; stop += 1) {
      if (overlapsForcedRange(index, stop)) continue;
      const spelling = parts.slice(index, stop).join("");
      const entries = [...dictionary.lookup(spelling)].sort(compareEntries);
      const tail = routes[stop];
      if (tail === undefined) continue;
      for (const entry of entries) {
        const length = stop - index;
        const candidate: Route = {
          covered: length + tail.covered,
          rank: entry.rank + tail.rank,
          segments: 1 + tail.segments,
          matchLengths: [length, ...tail.matchLengths],
          kanaPenalty: (entry.kanaUsuallyWritten ? 0 : 1) + tail.kanaPenalty,
          formPenalty: (isKana(entry.form) ? 0 : 1) + tail.formPenalty,
          output: entry.form + tail.output,
        };
        best = betterRoute(candidate, best);
      }
    }
    routes[index] = best;
  }

  return routes[0]?.output ?? reading;
}

function dictionaryFromOptions(
  options: ConverterOptions | DictionaryReader | undefined,
): DictionaryReader {
  if (options && "lookup" in options) return options;
  return options?.dictionary ?? getDictionary();
}

/** Convert one line into kana and dictionary-assisted kanji variants. */
export function convert(
  value: string,
  options?: ConverterOptions | DictionaryReader,
): ConversionResult {
  if (value.length === 0) return { hiragana: "", katakana: "", kanji: "" };

  const hiragana = romaniseToHiragana(value);
  const katakana = toKatakanaPreservingPunctuation(hiragana);
  const dictionary = dictionaryFromOptions(options);
  const prepared = prepareReading(value, true, dictionary);
  const kanji = segmentReading(prepared.reading, dictionary, {
    grammaticalParticleOffsets: prepared.grammaticalParticleOffsets,
    katakanaFallbackRanges: prepared.katakanaFallbackRanges,
  });
  return { hiragana, katakana, kanji };
}

export class Converter {
  private readonly dictionary: DictionaryReader;

  constructor(dictionary?: DictionaryReader) {
    this.dictionary = dictionary ?? getDictionary();
  }

  convert(value: string): ConversionResult {
    return convert(value, this.dictionary);
  }
}

export const convertText = convert;
export const convertInput = convert;
