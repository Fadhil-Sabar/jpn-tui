import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { toHiragana } from "wanakana";
import {
  DICTIONARY_LICENSE,
  DICTIONARY_RELEASE,
  DICTIONARY_SCHEMA_VERSION,
  DICTIONARY_SOURCE,
  DICTIONARY_SOURCE_SHA256,
  DICTIONARY_SOURCE_URL,
} from "../src/dictionary";

const ROOT = resolve(import.meta.dir, "..");
const DATA_DIRECTORY = join(ROOT, "data");
const OUTPUT_PATH = join(DATA_DIRECTORY, "jmdict.sqlite");
const CACHE_DIRECTORY = join(ROOT, ".cache", "jmdict");
const CACHE_PATH = join(CACHE_DIRECTORY, "jmdict.tgz");
const LOCAL_ARCHIVE = "/tmp/jpn-jmdict/jmdict.tgz";
const ARCHIVE_MEMBER = "jmdict-eng-3.6.2.json";

interface Form {
  readonly common: boolean;
  readonly text: string;
  readonly tags: string[];
}

interface KanaForm extends Form {
  readonly appliesToKanji: string[];
}

interface Sense {
  readonly appliesToKanji: string[];
  readonly appliesToKana: string[];
  readonly misc: string[];
}

interface Word {
  readonly id: string;
  readonly kanji: Form[];
  readonly kana: KanaForm[];
  readonly sense: Sense[];
}

interface Snapshot {
  readonly words: Word[];
}

interface DictionaryRow {
  readonly reading: string;
  readonly form: string;
  readonly rank: number;
  readonly kanaUsuallyWritten: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedArchive(): Promise<string> {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  let bytes: Uint8Array | undefined;

  try {
    bytes = await readFile(CACHE_PATH);
  } catch {
    // A repository-local cache is optional. The supplied archive is useful in
    // offline builds, but the normal fallback remains the pinned URL below.
    try {
      bytes = await readFile(LOCAL_ARCHIVE);
    } catch {
      // Fetch below.
    }
  }

  if (bytes === undefined || sha256(bytes) !== DICTIONARY_SOURCE_SHA256) {
    if (bytes !== undefined) {
      await rm(CACHE_PATH, { force: true });
    }
    const response = await fetch(DICTIONARY_SOURCE_URL);
    if (!response.ok) {
      throw new Error(
        `Unable to download JMdict snapshot: ${response.status} ${response.statusText}`,
      );
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  const actual = sha256(bytes);
  if (actual !== DICTIONARY_SOURCE_SHA256) {
    throw new Error(
      `JMdict snapshot checksum mismatch: expected ${DICTIONARY_SOURCE_SHA256}, got ${actual}`,
    );
  }
  await Bun.write(CACHE_PATH, bytes);
  return CACHE_PATH;
}

async function extractJson(archivePath: string): Promise<string> {
  const process = Bun.spawn(["tar", "-xOzf", archivePath, ARCHIVE_MEMBER], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, errorOutput] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(
      `Unable to extract ${ARCHIVE_MEMBER} from ${archivePath}: ${errorOutput.trim()}`,
    );
  }
  if (output.length === 0)
    throw new Error(`Archive member ${ARCHIVE_MEMBER} is empty`);
  return output;
}

function asSnapshot(json: string): Snapshot {
  const parsed = JSON.parse(json) as Snapshot;
  if (!parsed || !Array.isArray(parsed.words)) {
    throw new Error("JMdict snapshot does not contain a words array");
  }
  return parsed;
}

function numericId(id: string): number {
  const value = Number(id);
  return Number.isSafeInteger(value) && value >= 0 ? value : 9_000_000;
}

function priority(tags: readonly string[]): number {
  let best = 999;
  for (const tag of tags) {
    const match = tag.match(/^(?:news|ichi|spec|gai)([1-4])$/);
    if (match) best = Math.min(best, Number(match[1]));
    const nf = tag.match(/^nf(\d\d)$/);
    if (nf) best = Math.min(best, Number(nf[1]));
  }
  return best === 999 ? 50 : best;
}

function appliesTo(restrictions: readonly string[], value: string): boolean {
  return (
    restrictions.length === 0 ||
    restrictions.includes("*") ||
    restrictions.includes(value)
  );
}

function usuallyKana(word: Word, kana: KanaForm): boolean {
  return word.sense.some(
    (sense) =>
      sense.misc.includes("uk") && appliesTo(sense.appliesToKana, kana.text),
  );
}

function isKanaOnlyWord(word: Word, kana: KanaForm): boolean {
  return word.kanji.length === 0 || usuallyKana(word, kana);
}

function makeRank(
  word: Word,
  kana: KanaForm,
  form: Form | undefined,
  wordIndex: number,
  kanaIndex: number,
  formIndex: number,
): number {
  const common = kana.common && (form === undefined || form.common);
  const tags = [...kana.tags, ...(form?.tags ?? [])];
  // Frequency/common status is the major rank. Entry order is retained only
  // as a deterministic tie breaker (and makes 私 beat the alternate 渡し).
  const frequency = common ? 0 : 10_000_000;
  const preferredKana = isKanaOnlyWord(word, kana) ? 0 : 5_000_000;
  const priorityRank = priority(tags) * 100_000;
  const sourceOrder =
    numericId(word.id) * 10 +
    (wordIndex % 10) +
    (kanaIndex % 10) +
    (formIndex % 10);
  return frequency + preferredKana + priorityRank + sourceOrder;
}

function addRow(rows: Map<string, DictionaryRow>, row: DictionaryRow): void {
  const key = `${row.reading}\u0000${row.form}`;
  const previous = rows.get(key);
  if (previous === undefined) {
    rows.set(key, row);
    return;
  }
  rows.set(key, {
    ...previous,
    rank: Math.min(previous.rank, row.rank),
    kanaUsuallyWritten: previous.kanaUsuallyWritten || row.kanaUsuallyWritten,
  });
}

function buildRows(snapshot: Snapshot): DictionaryRow[] {
  const rows = new Map<string, DictionaryRow>();
  for (let wordIndex = 0; wordIndex < snapshot.words.length; wordIndex += 1) {
    const word = snapshot.words[wordIndex];
    if (!word || typeof word.id !== "string") {
      throw new Error(`Invalid JMdict word at index ${wordIndex}`);
    }
    for (let kanaIndex = 0; kanaIndex < word.kana.length; kanaIndex += 1) {
      const kana = word.kana[kanaIndex];
      const reading = toHiragana(kana.text);
      const kanaIsUsuallyWritten = usuallyKana(word, kana);
      const applicableForms = word.kanji.filter((form) =>
        appliesTo(kana.appliesToKanji, form.text),
      );
      // A usually-kana word must not leak an obscure kanji spelling into the
      // converter. Likewise, an explicitly restricted reading with no valid
      // kanji form is still a usable kana dictionary entry.
      const forms =
        kanaIsUsuallyWritten || applicableForms.length === 0
          ? [{ form: undefined, text: reading }]
          : applicableForms.map((form) => ({ form, text: form.text }));

      for (let formIndex = 0; formIndex < forms.length; formIndex += 1) {
        const selected = forms[formIndex];
        addRow(rows, {
          reading,
          form: selected.text,
          rank: makeRank(
            word,
            kana,
            selected.form,
            wordIndex,
            kanaIndex,
            formIndex,
          ),
          kanaUsuallyWritten: kanaIsUsuallyWritten,
        });
      }
    }
  }

  return [...rows.values()].sort((left, right) => {
    if (left.reading !== right.reading)
      return left.reading < right.reading ? -1 : 1;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.form < right.form ? -1 : left.form > right.form ? 1 : 0;
  });
}

function makeDatabase(
  rows: readonly DictionaryRow[],
  wordCount: number,
  outputPath: string,
): string {
  const temporaryPath = `${outputPath}.tmp`;
  const db = new Database(temporaryPath);
  try {
    // These settings and WITHOUT ROWID tables keep repeated builds stable.
    db.exec("PRAGMA page_size = 4096");
    db.exec("PRAGMA auto_vacuum = NONE");
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(`PRAGMA user_version = ${DICTIONARY_SCHEMA_VERSION}`);
    db.exec("PRAGMA application_id = 1246971987");
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE entries (
        reading TEXT NOT NULL,
        form TEXT NOT NULL,
        rank INTEGER NOT NULL,
        kana_usually_written INTEGER NOT NULL CHECK (kana_usually_written IN (0, 1)),
        PRIMARY KEY (reading, rank, form)
      ) WITHOUT ROWID;
    `);

    const maxReadingLength = rows.reduce(
      (maximum, row) => Math.max(maximum, Array.from(row.reading).length),
      1,
    );
    const metadata: Record<string, string> = {
      schemaVersion: String(DICTIONARY_SCHEMA_VERSION),
      source: DICTIONARY_SOURCE,
      sourceUrl: DICTIONARY_SOURCE_URL,
      sourceSha256: DICTIONARY_SOURCE_SHA256,
      release: DICTIONARY_RELEASE,
      license: DICTIONARY_LICENSE,
      wordCount: String(wordCount),
      formCount: String(rows.length),
      maxReadingLength: String(maxReadingLength),
    };
    const metadataInsert = db.prepare(
      "INSERT INTO metadata (key, value) VALUES (?, ?)",
    );
    const rowInsert = db.prepare(
      "INSERT INTO entries (reading, form, rank, kana_usually_written) VALUES (?, ?, ?, ?)",
    );
    const insertAll = db.transaction(() => {
      for (const [key, value] of Object.entries(metadata).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        metadataInsert.run(key, value);
      }
      for (const row of rows) {
        rowInsert.run(
          row.reading,
          row.form,
          row.rank,
          row.kanaUsuallyWritten ? 1 : 0,
        );
      }
    });
    insertAll();
    db.exec("ANALYZE");
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  return temporaryPath;
}

async function writeDatabase(
  rows: readonly DictionaryRow[],
  wordCount: number,
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(`${outputPath}.tmp`, { force: true });
  const temporaryPath = makeDatabase(rows, wordCount, outputPath);
  await rename(temporaryPath, outputPath);
}

async function main(): Promise<void> {
  const archivePath = await verifiedArchive();
  const json = await extractJson(archivePath);
  const snapshot = asSnapshot(json);
  const rows = buildRows(snapshot);
  await writeDatabase(rows, snapshot.words.length, OUTPUT_PATH);
  console.log(
    `Built ${OUTPUT_PATH} from ${snapshot.words.length} words and ${rows.length} reading/form rows`,
  );
}

if (import.meta.main) {
  await main();
}

export { buildRows, extractJson, main, verifiedArchive, writeDatabase };
