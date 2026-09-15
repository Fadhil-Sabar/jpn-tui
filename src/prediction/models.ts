import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "../config";
import type { PredictionBackend } from "./types";

export type JinenBackend = Exclude<PredictionBackend, "dictionary">;

export interface LocalModel {
  readonly id: JinenBackend;
  readonly label: string;
  /** Exact expected size of the final GGUF file in bytes. */
  readonly size: number;
  /** Pinned to an immutable revision so bytes cannot change under us. */
  readonly url: string;
  /** The Hugging Face commit the URL resolves through. */
  readonly revision: string;
  /** SHA-256 of the exact GGUF file, checked before installation. */
  readonly sha256: string;
  readonly filename: string;
}

export const JINEN_MODELS: Readonly<Record<JinenBackend, LocalModel>> = {
  "jinen-xsmall": {
    id: "jinen-xsmall",
    label: "Jinen xsmall",
    filename: "jinen-v2-xsmall-Q5_K_M.gguf",
    size: 28_261_056,
    revision: "3910fd01bf4ba86eca89617f18db9b0c1c5b2283",
    sha256: "24ff3af5db712fbbb4aa9254ee28ec4d731207134471ab68b06c1828726284c2",
    url: "https://huggingface.co/togatogah/jinen-v2-xsmall.gguf/resolve/3910fd01bf4ba86eca89617f18db9b0c1c5b2283/jinen-v2-xsmall-Q5_K_M.gguf",
  },
  "jinen-small": {
    id: "jinen-small",
    label: "Jinen small",
    filename: "jinen-v2-small-Q5_K_M.gguf",
    size: 81_117_824,
    revision: "3461d0573ab447985badde3174165b967d06076c",
    sha256: "80482707513d6b67dafc31774371cf95d765542abf8d74eebf5f32f92d788bd3",
    url: "https://huggingface.co/togatogah/jinen-v2-small.gguf/resolve/3461d0573ab447985badde3174165b967d06076c/jinen-v2-small-Q5_K_M.gguf",
  },
};

export function getModelDirectory(): string {
  return join(getDataDirectory(), "jpn-tui", "models");
}

export function getModelMetadata(backend: JinenBackend): LocalModel {
  return JINEN_MODELS[backend];
}

export function getModelPath(
  backend: JinenBackend,
  directory = getModelDirectory(),
): string {
  return join(directory, getModelMetadata(backend).filename);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

/** A local file is valid only when its exact size and SHA-256 both match. */
export async function verifyModelFile(
  path: string,
  model: LocalModel,
): Promise<boolean> {
  try {
    const information = await stat(path);
    if (!information.isFile() || information.size !== model.size) return false;
    return (await hashFile(path)) === model.sha256;
  } catch {
    return false;
  }
}

/**
 * Verify an installed model offline. Anything that is not byte-exact is
 * treated as unavailable so the deterministic dictionary stays in charge.
 */
export async function isModelInstalled(
  backend: JinenBackend,
  directory = getModelDirectory(),
): Promise<boolean> {
  return verifyModelFile(
    getModelPath(backend, directory),
    getModelMetadata(backend),
  );
}

export interface ModelDownloadOptions {
  readonly directory?: string;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
  readonly signal?: AbortSignal;
  readonly inactivityTimeoutMs?: number;
}

/** No connection or stream may go quiet for this long during a download. */
export const MODEL_INACTIVITY_TIMEOUT_MS = 30_000;

function responseTotal(response: Response, expected: number): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : expected;
}

function combineSignals(
  ...signals: ReadonlyArray<AbortSignal | undefined>
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/**
 * Reject if the operation neither settles nor produces a chunk within
 * `timeoutMs`. The watchdog also covers connection establishment because the
 * initial fetch is raced the same way.
 */
async function withInactivity<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  watchdog: AbortController,
  onTimeout: () => Error,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject with the specific timeout error before the watchdog abort can
      // race in a generic AbortError.
      reject(onTimeout());
      watchdog.abort();
    }, timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_, reject) => {
    const reason = signal.reason ?? new Error("Download aborted");
    if (signal.aborted) {
      reject(reason);
      return;
    }
    signal.addEventListener("abort", () => reject(reason), { once: true });
  });

  try {
    return await Promise.race([operation(), timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Download to a temporary file, hashing as it streams, and expose the final
 * path only after the size and SHA-256 both match. Cancellation, timeouts, and
 * integrity failures all remove the partial file and close every handle.
 */
export async function downloadModel(
  backend: JinenBackend,
  options: ModelDownloadOptions = {},
): Promise<string> {
  const metadata = getModelMetadata(backend);
  const directory = options.directory ?? getModelDirectory();
  const destination = getModelPath(backend, directory);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.part`;
  const request = options.fetch ?? globalThis.fetch;
  const inactivityTimeoutMs =
    options.inactivityTimeoutMs ?? MODEL_INACTIVITY_TIMEOUT_MS;

  const watchdog = new AbortController();
  const signal = combineSignals(options.signal, watchdog.signal);
  const timeoutError = (): Error =>
    new Error(`Timed out downloading ${metadata.label} model`);

  let downloaded = 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    if (signal.aborted) throw signal.reason;
    await mkdir(directory, { recursive: true });
    if (signal.aborted) throw signal.reason;

    const response = await withInactivity(
      () => request(metadata.url, { signal }),
      inactivityTimeoutMs,
      watchdog,
      timeoutError,
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `Unable to download ${metadata.label} model (HTTP ${response.status})`,
      );
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(declared) && declared > metadata.size) {
      throw new Error(
        `Downloaded ${metadata.label} model is larger than expected (${declared} > ${metadata.size} bytes)`,
      );
    }

    file = await open(temporaryPath, "wx");
    const hash = createHash("sha256");
    const total = responseTotal(response, metadata.size);
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await file?.write(chunk, offset);
        if (!result || result.bytesWritten === 0) {
          throw new Error(`Unable to write ${metadata.label} model`);
        }
        offset += result.bytesWritten;
      }
      hash.update(chunk);
      downloaded += chunk.byteLength;
      options.onProgress?.(downloaded, total);
    };

    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const chunk = await withInactivity(
          () => reader?.read() ?? Promise.reject(timeoutError()),
          inactivityTimeoutMs,
          watchdog,
          timeoutError,
          signal,
        );
        if (chunk.done) break;
        if (chunk.value.byteLength > 0) {
          if (downloaded + chunk.value.byteLength > metadata.size) {
            throw new Error(
              `Downloaded ${metadata.label} model is larger than expected`,
            );
          }
          await writeChunk(chunk.value);
        }
      }
      reader.releaseLock();
      reader = undefined;
    } else {
      const buffer = await withInactivity(
        () => response.arrayBuffer(),
        inactivityTimeoutMs,
        watchdog,
        timeoutError,
        signal,
      );
      if (buffer.byteLength > metadata.size) {
        throw new Error(
          `Downloaded ${metadata.label} model is larger than expected`,
        );
      }
      await writeChunk(new Uint8Array(buffer));
    }

    await file.close();
    file = undefined;
    if (downloaded !== metadata.size) {
      throw new Error(
        `Downloaded ${metadata.label} model has ${downloaded} bytes; expected ${metadata.size}`,
      );
    }
    const digest = hash.digest("hex");
    if (digest !== metadata.sha256) {
      throw new Error(
        `Downloaded ${metadata.label} model failed SHA-256 verification`,
      );
    }
    await rename(temporaryPath, destination);
    return destination;
  } catch (error) {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original download error.
      }
      reader = undefined;
    }
    if (file) {
      try {
        await file.close();
      } catch {
        // Preserve the original download error.
      }
      file = undefined;
    }
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
