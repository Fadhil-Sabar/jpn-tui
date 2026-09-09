#!/usr/bin/env bun

import { launchTui } from "./tui";

export * from "./app";
export * from "./clipboard";
export * from "./composer";
export * from "./config";
export * from "./converter";
export * from "./dictionary";
export * from "./prediction";
export * from "./tui";
export * from "./view";

if (import.meta.main) process.exitCode = await launchTui();
