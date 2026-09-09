import { describe, expect, test } from "bun:test";
import {
  type ClipboardSpawnSync,
  copyToNativeClipboard,
} from "../src/clipboard";

describe("native clipboard", () => {
  test("tries applicable Linux backends in Wayland, X11, then WSL order", () => {
    const calls: Array<[string, readonly string[]]> = [];
    const spawn: ClipboardSpawnSync = (command, args) => {
      calls.push([command, args]);
      return { status: 1 };
    };

    expect(
      copyToNativeClipboard("日本語", {
        platform: "linux",
        env: {
          WAYLAND_DISPLAY: "wayland-0",
          DISPLAY: ":0",
          WSL_DISTRO_NAME: "Ubuntu",
        },
        release: "linux",
        spawn,
      }),
    ).toBeNull();
    expect(calls).toEqual([
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
      ["clip.exe", []],
    ]);
  });

  test("reports success and writes UTF-8 text through fixed spawn options", () => {
    const calls: unknown[][] = [];
    const spawn: ClipboardSpawnSync = (command, args, options) => {
      calls.push([command, args, options]);
      return { status: 0 };
    };

    expect(
      copyToNativeClipboard("日本語", {
        platform: "darwin",
        env: {},
        release: "Darwin",
        spawn,
      }),
    ).toEqual({ backend: "pbcopy" });
    expect(calls).toEqual([
      [
        "pbcopy",
        [],
        {
          input: "日本語",
          encoding: "utf8",
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
        },
      ],
    ]);
  });

  test("continues from a failed X11 command to the next candidate", () => {
    const calls: string[] = [];
    const spawn: ClipboardSpawnSync = (command) => {
      calls.push(command);
      if (command === "xclip") return { status: 1 };
      return { status: 0 };
    };

    expect(
      copyToNativeClipboard("かな", {
        platform: "linux",
        env: { DISPLAY: ":0" },
        release: "linux",
        spawn,
      }),
    ).toEqual({ backend: "xsel" });
    expect(calls).toEqual(["xclip", "xsel"]);
  });

  test("continues when a clipboard executable is missing", () => {
    const calls: string[] = [];
    const spawn: ClipboardSpawnSync = (command) => {
      calls.push(command);
      if (command === "xclip") throw new Error("ENOENT");
      return { status: 0 };
    };

    expect(
      copyToNativeClipboard("かな", {
        platform: "linux",
        env: { DISPLAY: ":0" },
        release: "linux",
        spawn,
      }),
    ).toEqual({ backend: "xsel" });
    expect(calls).toEqual(["xclip", "xsel"]);
  });
});
