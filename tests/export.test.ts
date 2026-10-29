import { describe, expect, it } from "vitest";
import { parsePlayersCsv, toPgn } from "../src/adapters/export.ts";
describe("exports", () => {
  it("parses CSV and emits PGN", () => {
    expect(parsePlayersCsv("name,elo\nAda,1800")).toEqual([
      { name: "Ada", elo: 1800, id: undefined },
    ]);
    expect(
      toPgn({
        tableId: 1,
        fen: "",
        whiteClock: 0,
        blackClock: 0,
        status: "connected",
        updatedAt: "",
      }),
    ).toContain('[Event "DGT Broadcast"]');
  });
});
