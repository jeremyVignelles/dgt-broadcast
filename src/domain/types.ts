import type { BatteryReading, ClockReading, ClockSide, Result } from "../dgt/protocol.ts";

export type ConnectionStatus =
  | "discovered"
  | "enrolling"
  | "associated"
  | "connected"
  | "degraded"
  | "disconnected"
  | "reconnecting";

export interface Player {
  name: string;
  elo?: number;
  id?: string;
  color?: "white" | "black";
}
export interface GameState {
  tableId: number;
  physicalId?: string;
  fen: string;
  lastMove?: string;
  white?: Player;
  black?: Player;
  whiteClock: number | null;
  blackClock: number | null;
  clock?: ClockReading;
  whiteClockSide?: ClockSide;
  boardBattery?: BatteryReading;
  result?: Result;
  resultStatus?: "none" | "reported" | "conflicting";
  specialPieces?: Array<{ square: string; result: Result }>;
  positionStatus?: "initial" | "tracked" | "unresolved";
  orientation?: "normal" | "rotated";
  battery?: number;
  status: ConnectionStatus;
  updatedAt: string;
}
export interface LogicalTable {
  id: number;
  label: string;
  visible: boolean;
  physicalId?: string;
  game: GameState;
}
export interface Meeting {
  id: string;
  name: string;
  status: "idle" | "active" | "finished";
  players: Player[];
  createdAt: string;
}
export interface AppState {
  tables: LogicalTable[];
  meeting?: Meeting;
  discovered: string[];
}

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export function emptyGame(id: number): GameState {
  return {
    tableId: id,
    fen: INITIAL_FEN,
    whiteClock: 0,
    blackClock: 0,
    battery: 100,
    status: "disconnected",
    updatedAt: new Date().toISOString(),
  };
}
export function validateTableId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > 32)
    throw new Error("tableId must be between 1 and 32");
}
