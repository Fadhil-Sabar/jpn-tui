import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRows, writeDatabase } from "../scripts/build-dictionary";
import {
  DEFAULT_DICTIONARY_PATH,
  DICTIONARY_LICENSE,
  DICTIONARY_RELEASE,
  DICTIONARY_SCHEMA_VERSION,
  DICTIONARY_SOURCE,
  DICTIONARY_SOURCE_SHA256,
  DICTIONARY_SOURCE_URL,
  Dictionary,
  DictionaryError,
} from "../src/dictionary";

describe("generated JMdict dictionary", () => {
  test("contains the pinned snapshot and consistent metadata", () => {
    const database = new Database(DEFAULT_DICTIONARY_PATH, { readonly: true });
    try {
      const metadata = new Map(
        (
          database.query("SELECT key, value FROM metadata").all() as Array<{
            key: string;
            value: string;
          }>
        ).map((row) => [row.key, row.value]),
      );
      expect(metadata.get("schemaVersion")).toBe(
        String(DICTIONARY_SCHEMA_VERSION),
      );
      expect(metadata.get("source")).toBe(DICTIONARY_SOURCE);
      expect(metadata.get("sourceUrl")).toBe(DICTIONARY_SOURCE_URL);
      expect(metadata.get("sourceSha256")).toBe(DICTIONARY_SOURCE_SHA256);
      expect(metadata.get("release")).toBe(DICTIONARY_RELEASE);
      expect(metadata.get("license")).toBe(DICTIONARY_LICENSE);
      expect(metadata.get("wordCount")).toBe("218732");
      expect(metadata.get("formCount")).toBe("305349");
      expect(
        (
          database.query("SELECT COUNT(*) AS count FROM entries").get() as {
            count: number;
          }
        ).count,
      ).toBe(Number(metadata.get("formCount")));
      expect(database.query("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(database.query("PRAGMA user_version").get()).toEqual({
        user_version: DICTIONARY_SCHEMA_VERSION,
      });
      const indexes = database
        .query("PRAGMA index_list(entries)")
        .all() as Array<{
        name: string;
        unique: number;
        origin: string;
      }>;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatchObject({ unique: 1, origin: "pk" });
      expect(
        database
          .query(`PRAGMA index_info('${indexes[0]?.name}')`)
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(["reading", "rank", "form"]);
    } finally {
      database.close();
    }
  });

  test("opens entries used by the converter", () => {
    const dictionary = new Dictionary();
    try {
      expect(dictionary.maxReadingLength).toBe(37);
      expect(dictionary.lookup("にほんご")[0]).toMatchObject({
        form: "日本語",
      });
      expect(dictionary.lookup("わたし")[0]).toMatchObject({ form: "私" });
    } finally {
      dictionary.close();
    }
  });

  test("rejects missing, corrupt, and wrong-schema databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jpn-tui-dictionary-"));
    const corruptPath = join(directory, "corrupt.sqlite");
    const wrongSchemaPath = join(directory, "wrong-schema.sqlite");
    try {
      expect(() => new Dictionary(join(directory, "missing.sqlite"))).toThrow(
        DictionaryError,
      );
      await writeFile(corruptPath, "not a sqlite database");
      try {
        new Dictionary(corruptPath);
        throw new Error("expected DictionaryError");
      } catch (error) {
        expect(error).toBeInstanceOf(DictionaryError);
        expect((error as DictionaryError).code).toBe("CORRUPT_DATABASE");
      }

      const wrongSchema = new Database(wrongSchemaPath);
      wrongSchema.exec(`
        PRAGMA user_version = ${DICTIONARY_SCHEMA_VERSION};
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE entries (
          reading TEXT NOT NULL,
          form TEXT NOT NULL,
          rank INTEGER NOT NULL,
          kana_usually_written INTEGER NOT NULL CHECK (kana_usually_written IN (0, 1)),
          PRIMARY KEY (reading, form, rank)
        ) WITHOUT ROWID;
      `);
      wrongSchema.close();
      try {
        new Dictionary(wrongSchemaPath);
        throw new Error("expected DictionaryError");
      } catch (error) {
        expect(error).toBeInstanceOf(DictionaryError);
        expect((error as DictionaryError).code).toBe("INCOMPATIBLE_DATABASE");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("dictionary source builder", () => {
  test("retains restrictions and emits usually-kana entries", () => {
    const rows = buildRows({
      words: [
        {
          id: "100",
          kanji: [
            { common: true, text: "漢", tags: [] },
            { common: false, text: "別", tags: [] },
          ],
          kana: [
            {
              appliesToKanji: ["漢"],
              common: true,
              tags: [],
              text: "かな",
            },
          ],
          sense: [],
        },
        {
          id: "101",
          kanji: [{ common: true, text: "普", tags: [] }],
          kana: [
            { appliesToKanji: [], common: true, tags: [], text: "ふつう" },
          ],
          sense: [
            {
              appliesToKanji: [],
              appliesToKana: [],
              misc: ["uk"],
            },
          ],
        },
      ],
    });

    expect(
      rows.map(({ reading, form, kanaUsuallyWritten }) => ({
        reading,
        form,
        kanaUsuallyWritten,
      })),
    ).toEqual([
      { reading: "かな", form: "漢", kanaUsuallyWritten: false },
      { reading: "ふつう", form: "ふつう", kanaUsuallyWritten: true },
    ]);
  });

  test("builds byte-identical databases without network access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jpn-tui-build-"));
    const first = join(directory, "first.sqlite");
    const second = join(directory, "second.sqlite");
    const rows = buildRows({
      words: [
        {
          id: "100",
          kanji: [{ common: true, text: "仮名", tags: ["ichi1"] }],
          kana: [
            {
              appliesToKanji: [],
              common: true,
              tags: ["ichi1"],
              text: "かな",
            },
          ],
          sense: [],
        },
      ],
    });

    try {
      await writeDatabase(rows, 1, first);
      await writeDatabase(rows, 1, second);
      const digest = (bytes: Uint8Array): string =>
        createHash("sha256").update(bytes).digest("hex");
      expect(digest(await readFile(first))).toBe(
        digest(await readFile(second)),
      );
      const dictionary = new Dictionary(first);
      expect(dictionary.lookup("かな")[0]?.form).toBe("仮名");
      dictionary.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
