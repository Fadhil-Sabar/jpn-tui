import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  getConfigPath,
  getDataDirectory,
  loadPredictionConfig,
  type PredictionConfig,
  savePredictionConfig,
} from "../src/config";
import { getModelDirectory } from "../src/prediction";

describe("prediction configuration", () => {
  test("defaults to dictionary and accepts both optional backends", () => {
    expect(DEFAULT_CONFIG).toEqual({ backend: "dictionary" });
    const choices: PredictionConfig[] = [
      { backend: "jinen-xsmall" },
      { backend: "jinen-small" },
    ];
    expect(choices.map(({ backend }) => backend)).toEqual([
      "jinen-xsmall",
      "jinen-small",
    ]);
  });

  test("persists xsmall then small at an explicit path", () => {
    const directory = mkdtempSync(join(tmpdir(), "jpn-tui-config-"));
    const path = join(directory, "nested", "config.json");
    try {
      savePredictionConfig({ backend: "jinen-xsmall" }, path);
      expect(loadPredictionConfig(path)).toEqual({ backend: "jinen-xsmall" });
      savePredictionConfig({ backend: "jinen-small" }, path);
      expect(loadPredictionConfig(path)).toEqual({ backend: "jinen-small" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("resolves default paths from HOME when XDG directories are unset", () => {
    const previousHome = process.env.HOME;
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    try {
      process.env.HOME = "/home/test-user";
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_DATA_HOME;
      expect(getConfigPath()).toBe(
        join("/home/test-user", ".config", "jpn-tui", "config.json"),
      );
      expect(getDataDirectory()).toBe(
        join("/home/test-user", ".local", "share"),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
    }
  });

  test("resolves configuration and data under XDG directories", () => {
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/xdg/config";
      process.env.XDG_DATA_HOME = "/xdg/data";
      expect(getConfigPath()).toBe(
        join("/xdg/config", "jpn-tui", "config.json"),
      );
      expect(getDataDirectory()).toBe("/xdg/data");
      expect(getModelDirectory()).toBe("/xdg/data/jpn-tui/models");
    } finally {
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
    }
  });
});
