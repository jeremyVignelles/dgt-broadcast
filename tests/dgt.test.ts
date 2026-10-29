import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { DgtTransport, DgtUpdateParser, positionPlacement } from "../src/adapters/dgt.ts";
import type { DgtBoard, DgtBoardFactory } from "../src/adapters/dgt.ts";
import type { Piece, Position } from "dgtchess";

const ROLE: Record<string, Piece["role"]> = {
  p: "pawn",
  r: "rook",
  n: "knight",
  b: "bishop",
  q: "queen",
  k: "king",
};

function positionFromFen(fen: string): Position {
  const rows = new Chess(fen).board();
  const position: Position = new Map();
  for (let row = 0; row < 8; row++) {
    for (let file = 0; file < 8; file++) {
      const square = `${String.fromCharCode(97 + file)}${8 - row}`;
      const piece = rows[row][file];
      position.set(
        square,
        piece ? { role: ROLE[piece.type], color: piece.color === "w" ? "white" : "black" } : null,
      );
    }
  }
  return position;
}

class FakeReader {
  private queue: Array<{ value?: Uint8Array; done: boolean }> = [];
  private waiting: Array<(result: { value?: Uint8Array; done: boolean }) => void> = [];

  read(): Promise<{ value?: Uint8Array; done: boolean }> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  push(value: Uint8Array): void {
    const result = { value, done: false };
    const resolve = this.waiting.shift();
    if (resolve) resolve(result);
    else this.queue.push(result);
  }
}

function fakeBoard(position: Position) {
  const reader = new FakeReader();
  const board: DgtBoard = {
    reset: async () => ({ serialNr: "12345", version: "1.0", position }),
    getReader: () => reader,
  };
  const factory: DgtBoardFactory = () => board;
  return { reader, factory };
}

describe("positionPlacement", () => {
  it("converts DGT square updates into standard FEN piece placement", () => {
    expect(positionPlacement(positionFromFen(new Chess().fen()))).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
    );
    expect(positionPlacement(new Map([["e4", { role: "king", color: "white" }]]))).toBe(
      "8/8/8/8/4K3/8/8/8",
    );
  });
});

describe("DgtUpdateParser", () => {
  it("parses complete messages, multiple messages and chunks split across reads", () => {
    const parser = new DgtUpdateParser();
    const first = Uint8Array.from([0x86, 0, 5, 12, 1]);
    const second = Uint8Array.from([0x86, 0, 5, 36, 5]);
    expect(parser.push(first.slice(0, 3))).toEqual([]);
    expect(parser.push(first.slice(3))).toEqual([
      new Map([["e7", { role: "pawn", color: "white" }]]),
    ]);
    expect(parser.push(Uint8Array.from([...first, ...second]))).toEqual([
      new Map([["e7", { role: "pawn", color: "white" }]]),
      new Map([["e4", { role: "king", color: "white" }]]),
    ]);
  });

  it("rejects malformed field indices and piece codes", () => {
    const parser = new DgtUpdateParser();
    expect(() => parser.push(Uint8Array.from([0x86, 0, 5, 64, 1]))).toThrow(/invalide/);
    expect(() => parser.push(Uint8Array.from([0x86, 0, 5, 0, 16]))).toThrow(/invalide/);
  });
});

describe("DgtTransport", () => {
  it("emits the initial position, infers a legal move, and reports battery as unknown", async () => {
    const { factory, reader } = fakeBoard(positionFromFen(new Chess().fen()));
    const transport = new DgtTransport({ createBoard: factory, settleMs: 5 });
    const states: Array<{ patch: Record<string, unknown> }> = [];
    transport.on("state", (state) => states.push(state));

    await transport.connect(1, "DGT_BT_1", "/dev/rfcomm0");
    expect(states.at(-1)?.patch).toMatchObject({
      status: "connected",
      fen: new Chess().fen(),
      battery: undefined,
    });

    reader.push(Uint8Array.from([0x86, 0, 5, 52, 0]));
    reader.push(Uint8Array.from([0x86, 0, 5, 36, 1]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(states.at(-1)?.patch).toMatchObject({
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      lastMove: "e2e4",
      battery: undefined,
    });
  });

  it("reports a reset timeout as disconnected", async () => {
    const board: DgtBoard = {
      reset: () => new Promise(() => {}),
      getReader: () => new FakeReader(),
    };
    const transport = new DgtTransport({
      createBoard: () => board,
      connectTimeoutMs: 5,
    });
    const states: Array<{ patch: Record<string, unknown> }> = [];
    transport.on("state", (state) => states.push(state));

    await expect(transport.connect(1, "DGT_BT_1", "/dev/rfcomm0")).rejects.toThrow(/Délai dépassé/);
    expect(states.at(-1)?.patch).toMatchObject({ status: "disconnected" });
    await expect(transport.connect(1, "DGT_BT_1", "/dev/rfcomm0")).rejects.toThrow(
      /redémarrez le serveur/,
    );
  });
});
