import { describe, expect, test } from "bun:test";
import {
  type ClipboardProcess,
  type ClipboardSpawn,
  type ClipboardSpawnOptions,
  copyToNativeClipboard,
} from "../src/clipboard";

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ClipboardSpawnOptions;
}

type Behavior = number | null | "hang" | Error;

class FakeChild implements ClipboardProcess {
  killed = false;
  readonly exited: Promise<number | null>;

  constructor(behavior: Behavior) {
    this.exited = new Promise<number | null>((resolve, reject) => {
      if (behavior === "hang") return;
      if (behavior instanceof Error) reject(behavior);
      else resolve(behavior);
    });
  }

  kill(): void {
    this.killed = true;
  }
}

interface Harness {
  readonly spawn: ClipboardSpawn;
  readonly calls: SpawnRecord[];
  readonly children: FakeChild[];
}

/** Route each spawn to a scripted behavior, defaulting to success. */
function harness(behaviors: Readonly<Record<string, Behavior>> = {}): Harness {
  const calls: SpawnRecord[] = [];
  const children: FakeChild[] = [];
  const spawn: ClipboardSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild(behaviors[command] ?? 0);
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

describe("native clipboard", () => {
  test("tries applicable Linux backends in Wayland, X11, then WSL order", async () => {
    const test1 = harness({
      "wl-copy": 1,
      xclip: 1,
      xsel: 1,
      "clip.exe": 1,
    });

    expect(
      await copyToNativeClipboard("日本語", {
        platform: "linux",
        env: {
          WAYLAND_DISPLAY: "wayland-0",
          DISPLAY: ":0",
          WSL_DISTRO_NAME: "Ubuntu",
        },
        release: "linux",
        spawn: test1.spawn,
      }),
    ).toBeNull();
    expect(test1.calls.map((call) => [call.command, call.args])).toEqual([
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
      ["clip.exe", []],
    ]);
    expect(test1.calls[0]?.options).toEqual({
      input: "日本語",
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
  });

  test("reports success and writes UTF-8 text through fixed spawn options", async () => {
    const test1 = harness();

    expect(
      await copyToNativeClipboard("日本語", {
        platform: "darwin",
        env: {},
        release: "Darwin",
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "pbcopy" });
    expect(test1.calls).toEqual([
      {
        command: "pbcopy",
        args: [],
        options: {
          input: "日本語",
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
        },
      },
    ]);
  });

  test("continues from a failed X11 command to the next candidate", async () => {
    const test1 = harness({ xclip: 1 });

    expect(
      await copyToNativeClipboard("かな", {
        platform: "linux",
        env: { DISPLAY: ":0" },
        release: "linux",
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "xsel" });
    expect(test1.calls.map((call) => call.command)).toEqual(["xclip", "xsel"]);
  });

  test("continues when a clipboard executable is missing", async () => {
    const test1 = harness({ xclip: new Error("ENOENT") });

    expect(
      await copyToNativeClipboard("かな", {
        platform: "linux",
        env: { DISPLAY: ":0" },
        release: "linux",
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "xsel" });
    expect(test1.calls.map((call) => call.command)).toEqual(["xclip", "xsel"]);
  });

  test("terminates a hung backend after its timeout and tries the next", async () => {
    const test1 = harness({ xclip: "hang" });

    expect(
      await copyToNativeClipboard("かな", {
        platform: "linux",
        env: { DISPLAY: ":0" },
        release: "linux",
        timeoutMs: 20,
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "xsel" });
    expect(test1.calls.map((call) => call.command)).toEqual(["xclip", "xsel"]);
    expect(test1.children[0]?.killed).toBe(true);
    expect(test1.children[1]?.killed).toBe(false);
  });

  test("returns null when the only backend hangs", async () => {
    const test1 = harness({ pbcopy: "hang" });

    expect(
      await copyToNativeClipboard("かな", {
        platform: "darwin",
        env: {},
        release: "Darwin",
        timeoutMs: 20,
        spawn: test1.spawn,
      }),
    ).toBeNull();
    expect(test1.children[0]?.killed).toBe(true);
  });

  test("supports repeated copies without shared state", async () => {
    const test1 = harness();

    expect(
      await copyToNativeClipboard("一", {
        platform: "darwin",
        env: {},
        release: "Darwin",
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "pbcopy" });
    expect(
      await copyToNativeClipboard("二", {
        platform: "darwin",
        env: {},
        release: "Darwin",
        spawn: test1.spawn,
      }),
    ).toEqual({ backend: "pbcopy" });
    expect(test1.calls.map((call) => call.options.input)).toEqual(["一", "二"]);
  });

  test("aborting kills the active backend and stops the fallback chain", async () => {
    const test1 = harness({ "wl-copy": "hang", xclip: "hang" });
    const controller = new AbortController();

    const copy = copyToNativeClipboard("かな", {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      release: "linux",
      timeoutMs: 5_000,
      signal: controller.signal,
      spawn: test1.spawn,
    });
    controller.abort();

    expect(await copy).toBeNull();
    expect(test1.calls.map((call) => call.command)).toEqual(["wl-copy"]);
    expect(test1.children[0]?.killed).toBe(true);
  });
});
