import { describe, expect, test } from "bun:test";
import { toOpenTuiCursorPosition } from "../src/tui";

describe("OpenTUI cursor adapter", () => {
  test("converts zero-based view coordinates to one-based terminal coordinates", () => {
    expect(toOpenTuiCursorPosition({ x: 23, y: 3, visible: true })).toEqual({
      x: 24,
      y: 4,
      visible: true,
    });
  });

  test("preserves a hidden cursor while converting its coordinates", () => {
    expect(toOpenTuiCursorPosition({ x: 23, y: 3, visible: false })).toEqual({
      x: 24,
      y: 4,
      visible: false,
    });
  });
});
