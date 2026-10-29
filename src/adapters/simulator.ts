import { EventEmitter } from "node:events";
import { INITIAL_FEN } from "../domain/types.ts";
import type { GameState } from "../domain/types.ts";
export class SimulatorTransport extends EventEmitter {
  private readonly games = new Map<number, GameState>();
  private readonly count: number;
  constructor(count = 4) {
    super();
    this.count = count;
  }
  start(): void {
    this.ensureTables(this.count);
  }
  ensureTables(count: number): void {
    for (let i = 1; i <= count; i++) {
      if (this.games.has(i)) continue;
      const game: GameState = {
        tableId: i,
        physicalId: `DGT_BT_SIM_${i}`,
        fen: INITIAL_FEN,
        whiteClock: 600,
        blackClock: 600,
        battery: 100,
        status: "connected",
        updatedAt: new Date().toISOString(),
      };
      this.games.set(i, game);
      this.emit("state", game);
    }
  }
  move(tableId: number, lastMove: string, fen?: string): GameState {
    const game = this.games.get(tableId);
    if (!game) throw new Error("Unknown simulated table");
    const next = { ...game, lastMove, fen: fen ?? game.fen, updatedAt: new Date().toISOString() };
    this.games.set(tableId, next);
    this.emit("state", next);
    return next;
  }
  setStatus(tableId: number, status: GameState["status"], battery?: number): GameState {
    const game = this.games.get(tableId);
    if (!game) throw new Error("Unknown simulated table");
    const next = {
      ...game,
      status,
      battery: battery ?? game.battery,
      updatedAt: new Date().toISOString(),
    };
    this.games.set(tableId, next);
    this.emit("state", next);
    return next;
  }
  snapshot(): GameState[] {
    return [...this.games.values()];
  }
}
