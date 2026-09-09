import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "../config";
import type { PredictionBackend } from "./types";

export type JinenBackend = Exclude<PredictionBackend, "dictionary">;

export interface LocalModel {
  readonly id: JinenBackend;
  readonly label: string;
  /** Exact expected size of the final GGUF file in bytes. */
  readonly size: number;
  readonly url: string;
  readonly filename: string;
}

export const JINEN_MODELS: Readonly<Record<JinenBackend, LocalModel>> = {
  "jinen-xsmall": {
    id: "jinen-xsmall",
    label: "Jinen xsmall",
    filename: "jinen-v2-xsmall-Q5_K_M.gguf",
    size: 28_261_056,
    url: "https://huggingface.co/togatogah/jinen-v2-xsmall.gguf/resolve/main/jinen-v2-xsmall-Q5_K_M.gguf",
  },
  "jinen-small": {
    id: "jinen-small",
    label: "Jinen small",
    filename: "jinen-v2-small-Q5_K_M.gguf",
    size: 81_117_824,
    url: "https://huggingface.co/togatogah/jinen-v2-small.gguf/resolve/main/jinen-v2-small-Q5_K_M.gguf",
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

/** A model is installed only when the complete final file has the exact size. */
export function isModelInstalled(
  backend: JinenBackend,
  directory = getModelDirectory(),
): boolean {
  try {
    const information = statSync(getModelPath(backend, directory));
    return (
      information.isFile() &&
      information.size === getModelMetadata(backend).size
    );
  } catch {
    return false;
  }
}

export interface ModelDownloadOptions {
  readonly directory?: string;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
}

function responseTotal(response: Response, expected: number): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : expected;
}

/** Download to a temporary file and expose the final path only when complete. */
export async function downloadModel(
  backend: JinenBackend,
  options: ModelDownloadOptions = {},
): Promise<string> {
  const metadata = getModelMetadata(backend);
  const directory = options.directory ?? getModelDirectory();
  const destination = getModelPath(backend, directory);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.part`;
  let downloaded = 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(directory, { recursive: true });
    const request = options.fetch ?? globalThis.fetch;
    const response = await request(metadata.url);
    if (!response.ok) {
      throw new Error(
        `Unable to download ${metadata.label} model (HTTP ${response.status})`,
      );
    }

    file = await open(temporaryPath, "wx");
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
      downloaded += chunk.byteLength;
      options.onProgress?.(downloaded, total);
    };

    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength > 0) await writeChunk(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      await writeChunk(new Uint8Array(await response.arrayBuffer()));
    }

    await file.close();
    file = undefined;
    if (downloaded !== metadata.size) {
      throw new Error(
        `Downloaded ${metadata.label} model has ${downloaded} bytes; expected ${metadata.size}`,
      );
    }
    await rename(temporaryPath, destination);
    return destination;
  } catch (error) {
    if (file) {
      try {
        await file.close();
      } catch {
        // Preserve the original download error.
      }
    }
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
