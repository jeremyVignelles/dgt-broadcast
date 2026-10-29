import { Chess } from "chess.js";
import DgtchessBoard from "dgtchess";
import { EventEmitter } from "node:events";
import type { GameState } from "../domain/types.ts";
import type { Piece, Position } from "dgtchess";

const PIECE_TO_FEN: Record<Piece["role"], string> = {
  pawn: "p",
  rook: "r",
  knight: "n",
  bishop: "b",
  queen: "q",
  king: "k",
};
const SQUARE = /^[a-h][1-8]$/;
const SQUARES = Array.from({ length: 64 }, (_, index) => {
  const file = String.fromCharCode(97 + (index % 8));
  const rank = 8 - Math.floor(index / 8);
  return `${file}${rank}`;
});
const DGT_PIECES: Record<number, Piece | null> = {
  0x0: null,
  0x1: { role: "pawn", color: "white" },
  0x2: { role: "rook", color: "white" },
  0x3: { role: "knight", color: "white" },
  0x4: { role: "bishop", color: "white" },
  0x5: { role: "king", color: "white" },
  0x6: { role: "queen", color: "white" },
  0x7: { role: "pawn", color: "black" },
  0x8: { role: "rook", color: "black" },
  0x9: { role: "knight", color: "black" },
  0xa: { role: "bishop", color: "black" },
  0xb: { role: "king", color: "black" },
  0xc: { role: "queen", color: "black" },
  0xd: null,
  0xe: null,
  0xf: null,
};
const DEFAULT_SETTLE_MS = 250;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface DgtBoard {
  reset(): Promise<{ serialNr: string; version: string; position: Position }>;
  getReader(): {
    read(): Promise<{ value?: Uint8Array; done: boolean }>;
  };
}
export type DgtBoardFactory = (path: string) => DgtBoard;

/** Decodes the raw 5-byte DGT field-update messages returned by dgtchess on Node.js. */
export class DgtUpdateParser {
  private pending = new Uint8Array();

  push(chunk: Uint8Array): Position[] {
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.length);
    const updates: Position[] = [];
    let offset = 0;
    while (bytes.length - offset >= 3) {
      const length = ((bytes[offset + 1] & 0x7f) << 7) | (bytes[offset + 2] & 0x7f);
      if (length < 3) {
        offset++;
        continue;
      }
      if (bytes.length - offset < length) break;
      if (bytes[offset] === 0x86 && length === 5) {
        const index = bytes[offset + 3];
        const pieceCode = bytes[offset + 4];
        if (index >= SQUARES.length || !Object.hasOwn(DGT_PIECES, pieceCode)) {
          throw new Error("Trame de mise à jour DGT invalide.");
        }
        updates.push(new Map([[SQUARES[index], DGT_PIECES[pieceCode]]]));
      }
      offset += length;
    }
    this.pending = bytes.slice(offset);
    return updates;
  }
}

interface Session {
  tableId: number;
  physicalId: string;
  position: Position;
  chess?: Chess;
  reader?: { read(): Promise<{ value?: Uint8Array; done: boolean }> };
  parser: DgtUpdateParser;
  settleTimer?: NodeJS.Timeout;
  lastFen: string;
  lastMove?: string;
  failed: boolean;
}

export function positionPlacement(position: Position): string {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const square = `${String.fromCharCode(97 + file)}${rank}`;
      const piece = position.get(square);
      if (!piece) {
        empty++;
        continue;
      }
      if (empty > 0) row += String(empty);
      empty = 0;
      const letter = PIECE_TO_FEN[piece.role];
      if (!letter) throw new Error(`Pièce DGT inconnue sur ${square}`);
      row += piece.color === "white" ? letter.toUpperCase() : letter;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return rows.join("/");
}

function fenForPlacement(placement: string, turn = "w"): string {
  return `${placement} ${turn} - - 0 1`;
}

function placementFromFen(fen: string): string {
  return fen.split(" ")[0];
}

function initialChess(position: Position): Chess | undefined {
  const placement = positionPlacement(position);
  if (placement === placementFromFen(new Chess().fen())) return new Chess();
  try {
    return new Chess(fenForPlacement(placement));
  } catch {
    return undefined;
  }
}

function inferMove(
  chess: Chess,
  placement: string,
): { chess: Chess; lastMove: string } | undefined {
  for (const move of chess.moves({ verbose: true })) {
    const candidate = new Chess(chess.fen());
    candidate.move(move);
    if (placementFromFen(candidate.fen()) === placement) {
      return {
        chess: candidate,
        lastMove: `${move.from}${move.to}${move.promotion ?? ""}`,
      };
    }
  }
}

function connectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Reads the DGT board-dump and update-board stream supplied by dgtchess. */
export class DgtTransport extends EventEmitter {
  private readonly sessions = new Map<number, Session>();
  private readonly createBoard: DgtBoardFactory;
  private readonly settleMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    options: {
      createBoard?: DgtBoardFactory;
      settleMs?: number;
      connectTimeoutMs?: number;
    } = {},
  ) {
    super();
    this.createBoard = options.createBoard ?? ((path) => new DgtchessBoard(path));
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async connect(tableId: number, physicalId: string, path: string): Promise<void> {
    const current = this.sessions.get(tableId);
    if (current) {
      if (current.failed)
        throw new Error("Échec précédent : redémarrez le serveur avant de réessayer.");
      if (current.physicalId !== physicalId)
        throw new Error(
          "Un autre échiquier est déjà ouvert sur cette table ; redémarrez le serveur.",
        );
      return;
    }
    const board = this.createBoard(path);
    const session: Session = {
      tableId,
      physicalId,
      position: new Map(),
      lastFen: "",
      parser: new DgtUpdateParser(),
      failed: false,
    };
    this.sessions.set(tableId, session);
    this.emitState(session, { status: "reconnecting", battery: undefined });

    try {
      const dump = await this.withTimeout(board.reset(), this.connectTimeoutMs);
      session.position = new Map(dump.position);
      session.chess = initialChess(session.position);
      session.lastFen =
        session.chess?.fen() ?? fenForPlacement(positionPlacement(session.position));
      this.emitState(session, {
        fen: session.lastFen,
        lastMove: undefined,
        status: "connected",
        battery: undefined,
        whiteClock: 0,
        blackClock: 0,
      });
      session.reader = board.getReader();
      void this.readUpdates(session);
    } catch (error) {
      session.failed = true;
      this.emitState(session, { status: "disconnected", battery: undefined });
      throw connectionError(error);
    }
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Délai dépassé pendant la lecture de l'échiquier DGT.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readUpdates(session: Session): Promise<void> {
    try {
      while (true) {
        const { value, done } = await session.reader!.read();
        if (done) throw new Error("Le flux de l'échiquier DGT est terminé.");
        if (!value) continue;
        const updates = session.parser.push(value);
        if (updates.length === 0) continue;
        for (const update of updates) {
          for (const [square, piece] of update) {
            if (!SQUARE.test(square)) throw new Error(`Case reçue invalide : ${square}`);
            session.position.set(square, piece);
          }
        }
        if (session.settleTimer) clearTimeout(session.settleTimer);
        session.settleTimer = setTimeout(() => this.publishStablePosition(session), this.settleMs);
      }
    } catch (error) {
      session.failed = true;
      this.emitState(session, { status: "disconnected", battery: undefined });
      this.emit("board-error", {
        tableId: session.tableId,
        error: connectionError(error),
      });
    }
  }

  private publishStablePosition(session: Session): void {
    session.settleTimer = undefined;
    const placement = positionPlacement(session.position);
    let fen: string;
    if (session.chess && placement !== placementFromFen(session.chess.fen())) {
      const inferred = inferMove(session.chess, placement);
      if (inferred) {
        session.chess = inferred.chess;
        session.lastMove = inferred.lastMove;
        fen = session.chess.fen();
      } else {
        session.chess = undefined;
        session.lastMove = undefined;
        fen = fenForPlacement(placement);
      }
    } else {
      session.chess ??= initialChess(session.position);
      fen = session.chess?.fen() ?? fenForPlacement(placement);
    }
    if (fen === session.lastFen) return;
    session.lastFen = fen;
    this.emitState(session, { fen, lastMove: session.lastMove, battery: undefined });
  }

  private emitState(session: Session, patch: Partial<GameState>): void {
    this.emit("state", {
      tableId: session.tableId,
      patch: { ...patch, physicalId: session.physicalId },
    });
  }
}
