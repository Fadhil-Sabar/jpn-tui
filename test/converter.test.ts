import { describe, expect, test } from "bun:test";
import {
  type ConversionResult,
  convert,
  segmentReading,
  toJinenReading,
} from "../src/converter";
import type { DictionaryEntry, DictionaryReader } from "../src/dictionary";

function entry(
  reading: string,
  form: string,
  rank: number,
  kanaUsuallyWritten = false,
): DictionaryEntry {
  return { reading, form, rank, kanaUsuallyWritten };
}

function fixture(
  entries: readonly DictionaryEntry[],
  maxReadingLength = 32,
): DictionaryReader {
  return {
    maxReadingLength,
    lookup(reading: string): readonly DictionaryEntry[] {
      return entries.filter((candidate) => candidate.reading === reading);
    },
  };
}

function result(value: string, dictionary: DictionaryReader): ConversionResult {
  return convert(value, dictionary);
}

describe("romaji conversion", () => {
  const emptyDictionary = fixture([]);

  test("converts the required everyday examples", () => {
    expect(convert("arigatou gozaimasu")).toEqual({
      hiragana: "ありがとうございます",
      katakana: "アリガトウゴザイマス",
      kanji: "ありがとうございます",
    });
    expect(convert("nihongo")).toEqual({
      hiragana: "にほんご",
      katakana: "ニホンゴ",
      kanji: "日本語",
    });
    expect(convert("watashi wa gakusei desu")).toEqual({
      hiragana: "わたしわがくせいです",
      katakana: "ワタシワガクセイデス",
      kanji: "私は学生です",
    });
  });

  test("uses Katakana for unknown names only in the Kanji preview", () => {
    expect(convert("watashi wa fadhil desu")).toEqual({
      hiragana: "わたしわ fadhil です",
      katakana: "ワタシワ fadhil デス",
      kanji: "私はファディルです",
    });
    expect(convert("watashi wa fadiru desu")).toEqual({
      hiragana: "わたしわふぁぢるです",
      katakana: "ワタシワファヂルデス",
      kanji: "私はファヂルです",
    });
    expect(convert("fadhil").kanji).toBe("fadhil");
  });

  test("builds Jinen's Katakana reading for contextual foreign names", () => {
    expect(toJinenReading("watashi no namae wa fadhil desu")).toBe(
      "ワタシノナマエハファディルデス",
    );
    expect(toJinenReading("fadhil")).toBe("fadhil");
    expect(toJinenReading("hello")).toBe("hello");
  });

  test("handles romaji edge cases deterministically", () => {
    expect(result("gakkou kitte", emptyDictionary).hiragana).toBe(
      "がっこうきって",
    );
    expect(result("kan'i n'na kan’i", emptyDictionary).hiragana).toBe(
      "かんいんなかんい",
    );
    expect(result("toukyou suupaa", emptyDictionary).hiragana).toBe(
      "とうきょうすうぱあ",
    );
    expect(result("ToUkYoU SuShI", emptyDictionary).hiragana).toBe(
      "とうきょうすし",
    );
  });

  test("preserves punctuation, existing Japanese, empty, and incomplete input", () => {
    expect(result("kana!? (nihongo), 123", emptyDictionary).hiragana).toBe(
      "かな!? (にほんご), 123",
    );
    expect(result("かな カナ 日本語", emptyDictionary)).toEqual({
      hiragana: "かな かな 日本語",
      katakana: "カナ カナ 日本語",
      kanji: "かな かな 日本語",
    });
    expect(result("", emptyDictionary)).toEqual({
      hiragana: "",
      katakana: "",
      kanji: "",
    });
    expect(result("kit sh", emptyDictionary)).toEqual({
      hiragana: "kit sh",
      katakana: "kit sh",
      kanji: "kit sh",
    });
  });

  test("removes only separators between convertible romaji words", () => {
    expect(convert("arigatou   gozaimasu").hiragana).toBe(
      "ありがとうございます",
    );
    expect(convert("watashi\twa\ngakusei").kanji).toBe("私は学生");
    expect(convert("hello   世界").hiragana).toBe("hello   世界");
    expect(convert("日本語  hello").hiragana).toBe("日本語  hello");
  });

  test("leaves ordinary text and punctuation unchanged", () => {
    const converted = convert("Hello, world! 123 / 日本語");
    expect(converted.hiragana).toBe("Hello, world! 123 / 日本語");
    expect(converted.katakana).toBe("Hello, world! 123 / 日本語");
    expect(converted.kanji).toBe("Hello, world! 123 / 日本語");

    const punctuation = convert("kanji, nihongo.");
    expect(punctuation.hiragana).toBe("かんじ, にほんご.");
    expect(punctuation.katakana).toBe("カンジ, ニホンゴ.");
    expect(punctuation.kanji).toBe("幹事, 日本語.");
  });
});

describe("dictionary-assisted segmentation", () => {
  test("prefers a longer complete dictionary match", () => {
    const dictionary = fixture([
      entry("か", "短", 1),
      entry("な", "片", 1),
      entry("かな", "長", 99),
    ]);

    expect(result("kana", dictionary).kanji).toBe("長");
    expect(segmentReading("かな", dictionary)).toBe("長");
  });

  test("prefers the longest match at the earliest differing offset", () => {
    const dictionary = fixture([
      entry("あぶ", "前", 1),
      entry("あぶく", "後", 1),
      entry("くで", "者", 1),
      entry("くくで", "半", 1),
    ]);

    expect(segmentReading("あぶくくで", dictionary)).toBe("後者");
  });

  test("uses rank, usually-kana, and deterministic form ordering", () => {
    const dictionary = fixture([
      entry("てすと", "乙", 10),
      entry("てすと", "甲", 10),
      entry("にほん", "低優先", 20),
      entry("にほん", "高優先", 1),
      entry("かな", "漢字", 1),
      entry("かな", "かな", 1, true),
    ]);

    expect(result("tesuto", dictionary).kanji).toBe("乙");
    expect(result("nihon", dictionary).kanji).toBe("高優先");
    expect(result("kana", dictionary).kanji).toBe("かな");
  });

  test("passes unknown text through while converting known spans", () => {
    const dictionary = fixture([entry("かな", "仮名", 1)]);
    expect(result("kana x", dictionary).kanji).toBe("仮名 x");
    expect(result("kana!", dictionary).kanji).toBe("仮名!");
  });

  test("forces all space-delimited grammatical particles to kana", () => {
    const dictionary = fixture([
      entry("わたし", "私", 1),
      entry("ほん", "本", 1),
      entry("みせ", "店", 1),
      entry("ともだち", "友達", 1),
      entry("いえ", "家", 1),
      entry("くるま", "車", 1),
      entry("はは", "母", 1),
      entry("ちち", "父", 1),
      entry("あるく", "歩く", 1),
      ...[
        "は",
        "を",
        "へ",
        "が",
        "に",
        "で",
        "と",
        "も",
        "の",
        "から",
        "まで",
      ].map((reading) => entry(reading, `誤(${reading})`, 0)),
      // A dictionary edge crossing a particle boundary must also be rejected.
      entry("わたしは", "誤横断", 0),
    ]);
    const input =
      "watashi wa hon o mise e tomodachi ga ie ni kuruma de haha to chichi mo hon no mise kara ie made aruku";

    expect(result(input, dictionary).kanji).toBe(
      "私は本を店へ友達が家に車で母と父も本の店から家まで歩く",
    );
    expect(result("hon wo mise", dictionary).kanji).toBe("本を店");
  });

  test("does not treat a standalone lexical word as a particle", () => {
    const dictionary = fixture([
      entry("わ", "輪", 1),
      entry("から", "殻", 1),
      entry("まで", "馬手", 1),
    ]);

    expect(result("wa", dictionary).kanji).toBe("輪");
    expect(result("kara", dictionary).kanji).toBe("殻");
    expect(result("made", dictionary).kanji).toBe("馬手");
  });

  test("keeps forced particles exact when kana entries rank first", () => {
    const dictionary = fixture([
      entry("わたし", "私", 1),
      entry("は", "歯", 0),
      entry("がくせい", "学生", 1),
      entry("です", "です", 1, true),
    ]);

    expect(result("watashi wa gakusei desu", dictionary).kanji).toBe(
      "私は学生です",
    );
  });
});
