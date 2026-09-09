import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The schema consumed by the converter. Increase this when it changes. */
export const DICTIONARY_SCHEMA_VERSION = 2;
export const DICTIONARY_LICENSE = "CC BY-SA 4.0";
export const DICTIONARY_SOURCE = "jmdict-simplified";
export const DICTIONARY_SOURCE_URL =
  "https://github.com/scriptin/jmdict-simplified/releases/download/3.6.2%2B20260907165411/jmdict-eng-3.6.2%2B20260907165411.json.tgz";
export const DICTIONARY_SOURCE_SHA256 =
  "c9e7f99a21d6974a38d6b917f6a3fafa1890e2f316c1402fe780e552b398a52d";
export const DICTIONARY_RELEASE = "3.6.2+20260907165411";

/** The on-disk database path used when no dictionary is supplied. */
export const DEFAULT_DICTIONARY_PATH = resolve(
  join(import.meta.dir, "..", "data", "jmdict.sqlite"),
);

export type DictionaryErrorCode =
  | "MISSING_DATABASE"
  | "CORRUPT_DATABASE"
  | "INCOMPATIBLE_DATABASE";

/** A failure to open or validate the offline dictionary. */
export class DictionaryError extends Error {
  readonly code: DictionaryErrorCode;
  readonly databasePath: string;

  constructor(
    code: DictionaryErrorCode,
    message: string,
    databasePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DictionaryError";
    this.code = code;
    this.databasePath = databasePath;
  }
}

export interface DictionaryEntry {
  readonly reading: string;
  readonly form: string;
  /** A lower value is a better candidate. */
  readonly rank: number;
  readonly kanaUsuallyWritten: boolean;
}

export interface DictionaryReader {
  readonly maxReadingLength?: number;
  lookup(reading: string): readonly DictionaryEntry[];
}

type MetadataRow = { key: string; value: string };
type EntryRow = {
  reading: string;
  form: string;
  rank: number;
  kanaUsuallyWritten: number;
};

const REQUIRED_METADATA = [
  "schemaVersion",
  "source",
  "sourceUrl",
  "sourceSha256",
  "release",
  "license",
  "wordCount",
  "formCount",
  "maxReadingLength",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function incompatible(databasePath: string, detail: string): DictionaryError {
  return new DictionaryError(
    "INCOMPATIBLE_DATABASE",
    `Incompatible Japanese dictionary database at ${databasePath}: ${detail}`,
    databasePath,
  );
}

function corrupt(databasePath: string, detail: string): DictionaryError {
  return new DictionaryError(
    "CORRUPT_DATABASE",
    `Corrupt Japanese dictionary database at ${databasePath}: ${detail}`,
    databasePath,
  );
}

function isExpectedTable(
  db: Database,
  table: "metadata" | "entries",
  expected: readonly string[],
): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return (
    columns.length === expected.length &&
    columns.every((column, index) => column.name === expected[index])
  );
}

function hasExpectedPrimaryKey(db: Database): boolean {
  const indexes = db.query("PRAGMA index_list(entries)").all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  if (indexes.length !== 1) return false;
  const primaryKey = indexes[0];
  if (primaryKey.unique !== 1 || primaryKey.origin !== "pk") return false;
  const indexName = primaryKey.name.replaceAll("'", "''");
  const columns = db.query(`PRAGMA index_info('${indexName}')`).all() as Array<{
    name: string;
  }>;
  return (
    columns.length === 3 &&
    columns.every(
      (column, index) => column.name === ["reading", "rank", "form"][index],
    )
  );
}

function validateDatabase(db: Database, databasePath: string): number {
  let integrity: { integrity_check?: string } | null;
  try {
    integrity = db.query("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    } | null;
  } catch (error) {
    throw corrupt(databasePath, errorMessage(error));
  }
  if (integrity?.integrity_check !== "ok") {
    throw corrupt(
      databasePath,
      `SQLite integrity check returned ${integrity?.integrity_check ?? "no result"}`,
    );
  }

  try {
    if (
      !isExpectedTable(db, "metadata", ["key", "value"]) ||
      !isExpectedTable(db, "entries", [
        "reading",
        "form",
        "rank",
        "kana_usually_written",
      ]) ||
      !hasExpectedPrimaryKey(db)
    ) {
      throw incompatible(
        databasePath,
        "the dictionary schema is not supported",
      );
    }

    const userVersion = (
      db.query("PRAGMA user_version").get() as {
        user_version?: number;
      } | null
    )?.user_version;
    if (userVersion !== DICTIONARY_SCHEMA_VERSION) {
      throw incompatible(
        databasePath,
        `SQLite user_version ${userVersion ?? "no result"} is not ${DICTIONARY_SCHEMA_VERSION}`,
      );
    }

    const rows = db
      .query("SELECT key, value FROM metadata")
      .all() as MetadataRow[];
    const metadata = new Map(rows.map((row) => [row.key, row.value]));
    for (const key of REQUIRED_METADATA) {
      if (!metadata.has(key))
        throw incompatible(databasePath, `missing metadata ${key}`);
    }
    if (metadata.get("schemaVersion") !== String(DICTIONARY_SCHEMA_VERSION)) {
      throw incompatible(
        databasePath,
        `schema version ${metadata.get("schemaVersion")} is not ${DICTIONARY_SCHEMA_VERSION}`,
      );
    }
    if (metadata.get("source") !== DICTIONARY_SOURCE) {
      throw incompatible(
        databasePath,
        "the dictionary source is not JMdict-Simplified",
      );
    }
    if (metadata.get("sourceUrl") !== DICTIONARY_SOURCE_URL) {
      throw incompatible(
        databasePath,
        "the dictionary source URL metadata is invalid",
      );
    }
    if (metadata.get("release") !== DICTIONARY_RELEASE) {
      throw incompatible(
        databasePath,
        "the dictionary release metadata is invalid",
      );
    }
    if (metadata.get("license") !== DICTIONARY_LICENSE) {
      throw incompatible(
        databasePath,
        "the dictionary license metadata is invalid",
      );
    }
    if (metadata.get("sourceSha256") !== DICTIONARY_SOURCE_SHA256) {
      throw incompatible(
        databasePath,
        "the dictionary source checksum is invalid",
      );
    }

    const positiveInteger = (key: string): number => {
      const value = Number(metadata.get(key));
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw incompatible(databasePath, `${key} metadata is invalid`);
      }
      return value;
    };
    positiveInteger("wordCount");
    const formCount = positiveInteger("formCount");
    const maxReadingLength = positiveInteger("maxReadingLength");
    const actualFormCount = (
      db.query("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      }
    ).count;
    if (actualFormCount !== formCount) {
      throw incompatible(
        databasePath,
        `formCount metadata is ${formCount}, but the database contains ${actualFormCount} rows`,
      );
    }
    const actualMaxReadingLength = (
      db.query("SELECT MAX(length(reading)) AS length FROM entries").get() as {
        length: number | null;
      }
    ).length;
    if (actualMaxReadingLength !== maxReadingLength) {
      throw incompatible(
        databasePath,
        `maxReadingLength metadata is ${maxReadingLength}, but the database contains ${actualMaxReadingLength ?? 0}`,
      );
    }
    return maxReadingLength;
  } catch (error) {
    if (error instanceof DictionaryError) throw error;
    throw corrupt(databasePath, errorMessage(error));
  }
}

/**
 * A read-only view of the generated dictionary. The constructor validates the
 * file before preparing any lookup statements, so bad data never reaches the
 * conversion layer as an ambiguous SQL error.
 */
export class Dictionary implements DictionaryReader {
  readonly maxReadingLength: number;
  readonly databasePath: string;
  private readonly database: Database;
  private readonly lookupStatement: ReturnType<Database["query"]>;

  constructor(databasePath = DEFAULT_DICTIONARY_PATH) {
    const resolvedPath = resolve(databasePath);
    if (!existsSync(resolvedPath)) {
      throw new DictionaryError(
        "MISSING_DATABASE",
        `Japanese dictionary database is missing: ${resolvedPath}`,
        resolvedPath,
      );
    }

    let database: Database;
    try {
      // readonly is important: a composer process must never create or mutate
      // the dictionary while handling user input.
      database = new Database(resolvedPath, { readonly: true });
    } catch (error) {
      throw corrupt(resolvedPath, errorMessage(error));
    }

    try {
      this.maxReadingLength = validateDatabase(database, resolvedPath);
    } catch (error) {
      database.close();
      throw error;
    }

    this.database = database;
    this.databasePath = resolvedPath;
    this.lookupStatement = this.database.query(
      "SELECT reading, form, rank, kana_usually_written AS kanaUsuallyWritten " +
        "FROM entries WHERE reading = ? ORDER BY rank ASC, form ASC",
    );
  }

  lookup(reading: string): readonly DictionaryEntry[] {
    if (reading.length === 0) return [];
    try {
      return (this.lookupStatement.all(reading) as EntryRow[]).map((row) => ({
        reading: row.reading,
        form: row.form,
        rank: row.rank,
        kanaUsuallyWritten: row.kanaUsuallyWritten === 1,
      }));
    } catch (error) {
      throw corrupt(this.databasePath, errorMessage(error));
    }
  }

  close(): void {
    this.database.close();
  }
}

let defaultDictionary: Dictionary | undefined;

export function getDictionary(
  databasePath = DEFAULT_DICTIONARY_PATH,
): Dictionary {
  if (databasePath === DEFAULT_DICTIONARY_PATH) {
    defaultDictionary ??= new Dictionary(databasePath);
    return defaultDictionary;
  }
  return new Dictionary(databasePath);
}

export const openDictionary = getDictionary;

/** Close the lazy default connection, primarily for tests and clean shutdown. */
export function closeDefaultDictionary(): void {
  defaultDictionary?.close();
  defaultDictionary = undefined;
}
