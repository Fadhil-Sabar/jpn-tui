import { describe, expect, test } from "bun:test";
import {
  applyAdapterKey,
  applyPaste,
  Completion,
  mapOpenTuiKey,
  osc52Sequence,
  selectedPreview,
} from "../src/app";
import { createInitialState } from "../src/composer";
import type { ConversionResult } from "../src/converter";
import { TuiSession } from "../src/tui";

const converted = (value: string): ConversionResult => ({
  hiragana: `ひ:${value}`,
  katakana: `カ:${value}`,
  kanji: `字:${value}`,
});
const empty = converted("");

function memoryStream(log: string[] = []): { write(value: string): void } {
  return { write: (value) => void log.push(value) };
}

describe("OpenTUI adapter", () => {
  test("maps named keys, modifiers, and printable sequences", () => {
    expect(mapOpenTuiKey({ name: "return" })).toEqual({
      key: "Enter",
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(mapOpenTuiKey({ name: "tab", shift: true }).key).toBe("Shift-Tab");
    expect(mapOpenTuiKey({ name: "c", sequence: "c", ctrl: true })).toEqual({
      key: "c",
      ctrl: true,
      shift: false,
      alt: false,
    });
    expect(mapOpenTuiKey({ name: "unknown", sequence: "界" }).key).toBe("界");
    expect(mapOpenTuiKey({ name: "", sequence: "\x03" })).toMatchObject({
      key: "c",
      ctrl: true,
    });
  });

  test("submission and yank select the focused converted result", () => {
    const state = { ...createInitialState("nihon"), focus: 2 };
    expect(selectedPreview(converted("nihon"), 2)).toBe("字:nihon");
    const submit = applyAdapterKey(
      state,
      converted("nihon"),
      { key: "Enter" },
      converted,
    );
    expect(submit.effects).toEqual([{ type: "submit", value: "字:nihon" }]);
    const yank = applyAdapterKey(
      state,
      converted("nihon"),
      { key: "y" },
      converted,
    );
    expect(yank.effects[0]).toEqual({
      type: "yank",
      value: "字:nihon",
      sequence: osc52Sequence("字:nihon"),
    });
  });

  test("OSC 52 bytes are exact UTF-8 base64 and BEL terminated", () => {
    expect(Buffer.from(osc52Sequence("日本語"))).toEqual(
      Buffer.from("\x1b]52;c;5pel5pys6Kqe\x07"),
    );
  });

  test("paste is one line and only changes INSERT mode", () => {
    const normal = applyPaste(
      createInitialState(),
      empty,
      "ni\r\nhon",
      converted,
    );
    expect(normal.state.buffer).toBe("");
    const insert = applyAdapterKey(
      createInitialState(),
      empty,
      { key: "i" },
      converted,
    );
    const pasted = applyPaste(
      insert.state,
      insert.preview,
      "ni\r\nhon",
      converted,
    );
    expect(pasted.state.buffer).toBe("nihon");
    expect(pasted.preview.kanji).toBe("字:nihon");
  });
});

describe("completion and session effects", () => {
  test("cleanup is ordered, idempotent, and submit is the only stdout output", async () => {
    const events: string[] = [];
    const completion = new Completion(
      memoryStream(events),
      memoryStream(events),
    );
    completion.attach({ destroy: () => events.push("destroy") });
    completion.addCleanup(() => events.push("cleanup"));
    completion.finish({ type: "submit", value: "日本" });
    completion.finish({ type: "fatal", message: "late" });
    expect(await completion.promise).toBe(0);
    expect(events).toEqual(["destroy", "cleanup", "日本\n"]);
  });

  test("cleanup continues and resolves when destroy and cleanup throw", async () => {
    const events: string[] = [];
    const completion = new Completion(
      memoryStream(events),
      memoryStream(events),
    );
    completion.attach({
      destroy: () => {
        events.push("destroy");
        throw new Error("destroy failed");
      },
    });
    completion.addCleanup(() => {
      events.push("cleanup one");
      throw new Error("cleanup failed");
    });
    completion.addCleanup(() => events.push("cleanup two"));
    completion.finish({ type: "submit", value: "日本語" });
    expect(await completion.promise).toBe(0);
    expect(events).toEqual([
      "destroy",
      "cleanup one",
      "cleanup two",
      "日本語\n",
    ]);
  });

  test("quit is silent and interrupt resolves 130", async () => {
    const output: string[] = [];
    const quit = new Completion(memoryStream(output), memoryStream(output));
    quit.finish({ type: "quit" });
    expect(await quit.promise).toBe(0);
    expect(output).toEqual([]);

    const interrupt = new Completion(
      memoryStream(output),
      memoryStream(output),
    );
    interrupt.finish({ type: "interrupt" });
    expect(await interrupt.promise).toBe(130);
  });

  test("y writes only OSC to terminal and exposes transient status", () => {
    const terminal: string[] = [];
    const completion = new Completion(memoryStream(), memoryStream());
    let rendered = "";
    const session = new TuiSession({
      completion,
      terminal: memoryStream(terminal),
      convert: converted,
      statusDurationMs: 60_000,
      render: (view) => {
        rendered = view.lines
          .flatMap((line) => line.spans.map((span) => span.text))
          .join("");
      },
    });
    session.key({ name: "i", sequence: "i" });
    session.paste("nihon");
    session.key({ name: "escape", sequence: "\x1b" });
    session.key({ name: "y", sequence: "y" });
    expect(terminal).toEqual([osc52Sequence("ひ:nihon")]);
    expect(rendered).toContain("Clipboard sequence sent");
    expect(rendered).not.toContain("copied");
    expect(rendered).not.toContain("accepted");
    completion.finish({ type: "quit" });
  });

  test("dictionary-style errors finish through fatal cleanup", async () => {
    const errors: string[] = [];
    const completion = new Completion(memoryStream(), memoryStream(errors));
    const session = new TuiSession({
      completion,
      terminal: memoryStream(),
      convert: () => {
        throw new Error("database lookup failed");
      },
      render: () => {},
    });
    session.key({ name: "i", sequence: "i" });
    session.key({ name: "n", sequence: "n" });
    expect(await completion.promise).toBe(1);
    expect(errors).toEqual(["jpn: database lookup failed\n"]);
  });
});
