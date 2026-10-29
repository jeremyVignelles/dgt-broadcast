import type { AppState, GameState } from "../domain/types.ts";
export function toJson(state: AppState): string {
  return JSON.stringify(state, null, 2);
}
export function toPgn(game: GameState, event = "DGT Broadcast"): string {
  const tag = (k: string, v: string) => `[${k} "${v.replaceAll('"', "")}"]`;
  return [
    tag("Event", event),
    tag("Site", "Local"),
    tag("Round", String(game.tableId)),
    tag("White", game.white?.name ?? "Unknown"),
    tag("Black", game.black?.name ?? "Unknown"),
    "",
    game.lastMove ?? "*",
    "",
  ].join("\n");
}
export function parsePlayersCsv(csv: string) {
  return csv
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map((line) => {
      const [name, elo, id] = line.split(",").map((x) => x.trim());
      return { name, elo: elo ? Number(elo) : undefined, id };
    })
    .filter((p) => p.name);
}
