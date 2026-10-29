import { describe, expect, it } from "vitest";
import { bestGrid } from "../services/web/layout.js";
import {
  formatClock,
  lastMoveSquares,
  parseFen,
  sideToMove,
  squareName,
} from "../services/web/board.js";

describe("bestGrid", () => {
  const screen = [1920, 1080] as const;

  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [3, 3, 1],
    [4, 2, 2],
    [5, 3, 2],
    [8, 4, 2],
    [16, 6, 3],
  ])("lays out %i boards on a 16:9 screen as %i x %i", (count, columns, rows) => {
    expect(bestGrid(count, ...screen)).toEqual({ columns, rows });
  });

  it("uses columns on a portrait screen", () => {
    expect(bestGrid(2, 1080, 1920)).toEqual({ columns: 1, rows: 2 });
  });

  it("handles empty or degenerate input", () => {
    expect(bestGrid(0, ...screen)).toEqual({ columns: 1, rows: 1 });
    expect(bestGrid(4, 0, 0)).toEqual({ columns: 1, rows: 1 });
  });
});

describe("board helpers", () => {
  it("parses a FEN into 64 squares, a8 first", () => {
    const squares = parseFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
    expect(squares).toHaveLength(64);
    expect(squares[0]).toMatchObject({ white: false });
    expect(squares[squareIndex("e4")]).toMatchObject({ white: true });
    expect(squares[squareIndex("e2")]).toBeNull();
  });

  it("tolerates an invalid FEN", () => {
    expect(parseFen("garbage")).toHaveLength(64);
    expect(parseFen(undefined)).toHaveLength(64);
  });

  it("extracts last move squares", () => {
    expect(lastMoveSquares("e2e4")).toEqual(["e2", "e4"]);
    expect(lastMoveSquares("e2-e4")).toEqual(["e2", "e4"]);
    expect(lastMoveSquares(undefined)).toEqual([]);
  });

  it("reads the side to move", () => {
    expect(sideToMove("8/8/8/8/8/8/8/8 b - - 0 1")).toBe("black");
    expect(sideToMove("8/8/8/8/8/8/8/8 w - - 0 1")).toBe("white");
  });

  it("formats clocks", () => {
    expect(formatClock(600)).toBe("10:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(-3)).toBe("0:00");
    expect(formatClock(null)).toBe("--:--");
    expect(formatClock(undefined)).toBe("--:--");
  });
});

function squareIndex(name: string): number {
  return Array.from({ length: 64 }, (_, i) => squareName(i)).indexOf(name);
}
