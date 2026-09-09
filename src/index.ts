#!/usr/bin/env bun

import { launchTui } from "./tui";

export * from "./app";
export * from "./composer";
export * from "./converter";
export * from "./dictionary";
export * from "./tui";
export * from "./view";

if (import.meta.main) process.exitCode = await launchTui();
