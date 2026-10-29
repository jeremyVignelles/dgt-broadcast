declare module "dgtchess" {
  export interface Piece {
    role: "pawn" | "rook" | "knight" | "bishop" | "queen" | "king";
    color: "white" | "black";
  }

  export type Position = Map<string, Piece | null>;

  export interface BoardDump {
    serialNr: string;
    version: string;
    position: Position;
  }

  export default class Board {
    constructor(path: string);
    reset(): Promise<BoardDump>;
    getReader(): ReadableStreamDefaultReader<Uint8Array>;
  }
}
