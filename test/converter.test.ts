import { describe, expect, test } from "bun:test";
import {
  type ConversionResult,
  convert,
  segmentReading,
  toJinenReading,
  upgradeKanaSpans,
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

  test("strips whitespace so Jinen never sees a sentencepiece boundary", () => {
    // Jinen's tokenizer renders a space as its boundary marker (`▁`) in the
    // output, which also corrupts the particles next to it. A reading that
    // receives the marker is a malformed input, never a real space.
    const spaced = [
      "konbanha sensei, kore wa watashi no shukudai",
      "わたし の しゅくだい",
      " コンバンハ",
      "watashi  wa",
    ];
    expect(toJinenReading("konbanha sensei, kore wa watashi no shukudai")).toBe(
      "コンバンハセンセイ,コレハワタシノシュクダイ",
    );
    expect(toJinenReading("わたし の しゅくだい")).toBe("ワタシノシュクダイ");
    expect(toJinenReading(" コンバンハ")).toBe("コンバンハ");
    for (const value of spaced) {
      expect(toJinenReading(value)).not.toMatch(/\s/u);
    }
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

describe("dictionary upgrade of prediction kana", () => {
  const dictionary = fixture([
    entry("わたし", "私", 100),
    entry("これ", "これ", 50, true),
    entry("は", "歯", 10),
    entry("の", "野", 10),
    entry("です", "です", 20, true),
    entry("べる", "弁る", 10),
    entry("きたい", "期待", 10),
    entry("し", "死", 10),
    entry("ま", "間", 10),
    entry("す", "酢", 10),
  ]);

  test("restores the kanji a prediction left as hiragana", () => {
    expect(upgradeKanaSpans("わたしはファディルです", dictionary)).toBe(
      "私はファディルです",
    );
    expect(upgradeKanaSpans("これはわたしの", dictionary)).toBe("これは私の");
  });

  test("keeps a lone kana, which is a particle and not a word", () => {
    expect(upgradeKanaSpans("は", dictionary)).toBe("は");
    expect(upgradeKanaSpans("の", dictionary)).toBe("の");
  });

  test("leaves a word the dictionary usually writes in kana", () => {
    expect(upgradeKanaSpans("これは", dictionary)).toBe("これは");
    expect(upgradeKanaSpans("です", dictionary)).toBe("です");
  });

  test("never swallows okurigana next to a kanji", () => {
    expect(upgradeKanaSpans("食べる", dictionary)).toBe("食べる");
    expect(upgradeKanaSpans("行きたい", dictionary)).toBe("行きたい");
  });

  test("refuses a run it cannot cover without fragmenting it", () => {
    // `し`+`ま`+`す` would need three lone kana, which are never words here.
    expect(upgradeKanaSpans("します", dictionary)).toBe("します");
    expect(upgradeKanaSpans("きょう", dictionary)).toBe("きょう");
  });

  test("upgrades the run beside a kanji when its edge stays kana", () => {
    expect(upgradeKanaSpans("わたしは学生です", dictionary)).toBe(
      "私は学生です",
    );
  });
});
