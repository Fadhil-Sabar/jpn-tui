import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PredictionBackend } from "./prediction/types";

export interface PredictionConfig {
  readonly backend: PredictionBackend;
}

export const DEFAULT_CONFIG: PredictionConfig = { backend: "dictionary" };

function homeDirectory(): string {
  return process.env.HOME || homedir();
}

function xdgDirectory(
  variable: "XDG_CONFIG_HOME" | "XDG_DATA_HOME",
  fallback: string,
): string {
  const value = process.env[variable];
  return value && value.length > 0 ? value : join(homeDirectory(), fallback);
}

export function getConfigPath(): string {
  return join(
    xdgDirectory("XDG_CONFIG_HOME", ".config"),
    "jpn-tui",
    "config.json",
  );
}

function isBackend(value: unknown): value is PredictionBackend {
  return (
    value === "dictionary" ||
    value === "jinen-xsmall" ||
    value === "jinen-small"
  );
}

function parseConfig(value: unknown): PredictionConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    isBackend((value as { backend?: unknown }).backend)
  ) {
    return { backend: (value as { backend: PredictionBackend }).backend };
  }
  return { ...DEFAULT_CONFIG };
}

/** Read settings without creating a first-run configuration file. */
export function loadPredictionConfig(path = getConfigPath()): PredictionConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Persist settings atomically through a uniquely named sibling file. */
export function savePredictionConfig(
  config: PredictionConfig,
  path = getConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(parseConfig(config), null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

/** XDG data root used for optional model storage. */
export function getDataDirectory(): string {
  return xdgDirectory("XDG_DATA_HOME", join(".local", "share"));
}
