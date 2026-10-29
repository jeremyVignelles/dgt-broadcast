import { Chess } from "chess.js";
import { EventEmitter } from "node:events";
import { DgtClient, RequestTimeout } from "../dgt/client.ts";
import { Command, RESULTS, piece, squareName } from "../dgt/protocol.ts";
import { SerialTransport } from "../dgt/serial.ts";
import type { ByteTransport } from "../dgt/client.ts";
import type { ClockReading, DecodedMessage, Position, Result } from "../dgt/protocol.ts";
import type { GameState } from "../domain/types.ts";

const PIECE_TO_FEN = { pawn: "p", rook: "r", knight: "n", bishop: "b", queen: "q", king: "k" };
const INITIAL_PLACEMENT = new Chess().fen().split(" ")[0];

export function positionPlacement(position: Position): string {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = position.get(`${String.fromCharCode(97 + file)}${rank}`);
      if (!p) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      const letter = PIECE_TO_FEN[p.role];
      row += p.color === "white" ? letter.toUpperCase() : letter;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}
function placement(codes: number[], rotated: boolean): string {
  return positionPlacement(
    new Map(codes.map((code, i) => [squareName(rotated ? 63 - i : i), piece(code)])),
  );
}
function kingsResult(codes: number[], rotated: boolean): Result | undefined {
  const kings = codes.flatMap((code, index) =>
    code === 5 || code === 11 ? [{ code, square: squareName(rotated ? 63 - index : index) }] : [],
  );
  if (kings.length !== 2 || kings[0].code === kings[1].code) return undefined;
  const squares = kings
    .map((king) => king.square)
    .sort()
    .join("-");
  switch (squares) {
    case "d5-e4":
      return "1-0";
    case "d4-e5":
      return "0-1";
    case "e4-e5":
    case "d4-d5":
      return "1/2-1/2";
    default:
      return undefined;
  }
}
function inferMove(chess: Chess, target: string): { chess: Chess; lastMove: string } | undefined {
  for (const move of chess.moves({ verbose: true })) {
    const candidate = new Chess(chess.fen());
    candidate.move(move);
    if (candidate.fen().split(" ")[0] === target)
      return { chess: candidate, lastMove: `${move.from}${move.to}${move.promotion ?? ""}` };
  }
}
interface Session {
  tableId: number;
  physicalId: string;
  path: string;
  client: DgtClient;
  connected: boolean;
  codes?: number[];
  rotated: boolean;
  chess?: Chess;
  clock?: ClockReading;
  settleTimer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  polling: boolean;
  failures: number;
  startedAt: string;
  lastPositionAt?: string;
  lastClockAt?: number;
  serial?: string;
  version?: string;
  batteryStatus: "unknown" | "available" | "unresponsive";
  lastBatteryAt?: number;
  lastBatteryReceivedAt?: string;
  lastIdentityAt?: number;
  refreshPromise?: Promise<void>;
  lastError?: string;
  result?: Result;
  resultStatus?: GameState["resultStatus"];
}

export class DgtTransport extends EventEmitter {
  private readonly results = new Map<
    string,
    { result?: Result; resultStatus?: GameState["resultStatus"] }
  >();
  restoreResult(
    physicalId: string,
    result?: Result,
    resultStatus?: GameState["resultStatus"],
  ): void {
    this.results.set(physicalId, { result, resultStatus });
  }
  private readonly sessions = new Map<number, Session>();
  private readonly connections = new Map<
    number,
    { physicalId: string; path: string; promise: Promise<void> }
  >();
  private readonly createTransport: (path: string) => ByteTransport;
  private readonly settleMs: number;
  private readonly pollMs: number;

  constructor(
    options: {
      createTransport?: (path: string) => ByteTransport;
      settleMs?: number;
      pollMs?: number;
    } = {},
  ) {
    super();
    this.createTransport = options.createTransport ?? ((path) => new SerialTransport(path));
    this.settleMs = options.settleMs ?? 350;
    this.pollMs = options.pollMs ?? 10_000;
  }

  connect(tableId: number, physicalId: string, path: string): Promise<void> {
    const pending = this.connections.get(tableId);
    if (pending) {
      if (pending.physicalId !== physicalId || pending.path !== path)
        return Promise.reject(new Error("Une connexion est déjà en cours sur cette table"));
      return pending.promise;
    }
    const promise = this.connectSession(tableId, physicalId, path).finally(() =>
      this.connections.delete(tableId),
    );
    this.connections.set(tableId, { physicalId, path, promise });
    return promise;
  }
  private async connectSession(tableId: number, physicalId: string, path: string): Promise<void> {
    const current = this.sessions.get(tableId);
    if (current?.connected && current.physicalId === physicalId && current.path === path) return;
    await this.releaseSession(tableId);
    if ([...this.sessions.values()].some((s) => s.tableId !== tableId && s.path === path))
      throw new Error("Ce port série est déjà utilisé par une autre table");
    const client = new DgtClient(this.createTransport(path));
    const s: Session = {
      tableId,
      physicalId,
      path,
      client,
      connected: false,
      rotated: false,
      polling: false,
      failures: 0,
      startedAt: new Date().toISOString(),
      batteryStatus: "unknown",
    };
    this.sessions.set(tableId, s);
    client.on("raw", (event) => this.emit("raw", { tableId, physicalId, ...event }));
    client.on("message", (message: DecodedMessage) => {
      this.observe(s, message);
      this.emit("observation", {
        tableId,
        physicalId,
        message,
        receivedAt: new Date().toISOString(),
      });
    });
    client.on("protocol-error", (error: Error) => this.report(s, error));
    client.on("retry", ({ command, attempt }) =>
      this.emit("retry", { tableId, command, attempt, receivedAt: new Date().toISOString() }),
    );
    client.on("fault", (error: Error) => {
      this.report(s, error);
      this.markDisconnected(s);
    });
    client.on("closed", () => this.markDisconnected(s));
    this.emitState(s, {
      status: "reconnecting",
      battery: undefined,
      whiteClock: null,
      blackClock: null,
      clock: undefined,
      result: this.results.get(physicalId)?.result,
      specialPieces: [],
      boardBattery: undefined,
      lastMove: undefined,
      positionStatus: "unresolved",
    });
    try {
      Object.assign(s, this.results.get(physicalId));
      await client.open();
      await client.send(Command.idle);
      // RFCOMM opens before its radio link is ready; the first response can take several seconds.
      s.connected = true;
      await client.send(Command.niceUpdates);
      await this.optionalRead(s, () => client.readPosition(6000));
      this.emitState(s, { status: s.codes ? "connected" : "degraded" });
      await this.readIdentity(s);
      await this.readClockIfQuiet(s);
      await this.readBattery(s);
      s.pollTimer = setInterval(
        () =>
          void this.poll(s).catch((error: unknown) =>
            this.report(s, error instanceof Error ? error : new Error(String(error))),
          ),
        this.pollMs,
      );
    } catch (error) {
      this.report(s, error instanceof Error ? error : new Error(String(error)));
      this.markDisconnected(s);
      await client.close();
      throw error;
    }
  }
  private emitState(s: Session, patch: Partial<GameState>): void {
    this.emit("state", { tableId: s.tableId, patch: { ...patch, physicalId: s.physicalId } });
    if (patch.status === "reconnecting" || patch.status === "disconnected")
      this.emit("connection", {
        tableId: s.tableId,
        physicalId: s.physicalId,
        path: s.path,
        status: patch.status,
      });
  }
  private report(s: Session, error: Error): void {
    s.lastError = error.message;
    this.emit("board-error", { tableId: s.tableId, error });
  }
  private markDisconnected(s: Session): void {
    s.connected = false;
    if (s.settleTimer) clearTimeout(s.settleTimer);
    if (s.pollTimer) clearInterval(s.pollTimer);
    this.emitState(s, {
      status: "disconnected",
      whiteClock: null,
      blackClock: null,
      clock: undefined,
    });
  }
  private observe(s: Session, message: DecodedMessage): void {
    if (message.kind === "position") {
      const changed = !s.codes || s.codes.some((v, i) => v !== message.codes[i]);
      s.codes = [...message.codes];
      s.lastPositionAt = new Date().toISOString();
      s.failures = 0;
      if (s.connected) this.emitState(s, { status: "connected" });
      if (changed) this.publishPosition(s);
    } else if (message.kind === "square" && s.codes) {
      s.codes[message.index] = message.code;
      if (s.settleTimer) clearTimeout(s.settleTimer);
      s.settleTimer = setTimeout(() => this.publishPosition(s), this.settleMs);
    } else if (message.kind === "clock") {
      s.lastClockAt = Date.now();
      s.clock = message.clock;
      this.publishClock(s);
    } else if (message.kind === "battery") {
      s.batteryStatus = "available";
      s.lastBatteryReceivedAt = new Date().toISOString();
      this.emitState(s, { battery: message.battery.percent, boardBattery: message.battery });
    } else if (message.kind === "serial") {
      s.serial = message.serial;
    } else if (message.kind === "version") {
      s.version = message.version;
    }
  }
  private publishClock(s: Session): void {
    const c = s.clock;
    this.emitState(s, {
      clock: c,
      whiteClock: c?.connected ? c.left.seconds : null,
      blackClock: c?.connected ? c.right.seconds : null,
    });
  }
  private publishPosition(s: Session): void {
    if (s.settleTimer) clearTimeout(s.settleTimer);
    s.settleTimer = undefined;
    if (!s.codes) return;
    const normal = placement(s.codes, false);
    const reversed = placement(s.codes, true);
    if (normal === INITIAL_PLACEMENT || reversed === INITIAL_PLACEMENT) {
      s.rotated = reversed === INITIAL_PLACEMENT;
    }
    const target = placement(s.codes, s.rotated);
    const initial = target === INITIAL_PLACEMENT;
    let lastMove: string | undefined;
    let positionStatus: GameState["positionStatus"] = "unresolved";
    if (initial) {
      s.chess = new Chess();
      positionStatus = "initial";
    } else if (s.chess) {
      if (target === s.chess.fen().split(" ")[0]) {
        positionStatus = "tracked";
      } else {
        const inferred = inferMove(s.chess, target);
        if (inferred) {
          s.chess = inferred.chess;
          lastMove = inferred.lastMove;
          positionStatus = "tracked";
        }
        // Keep the last verified game through physical intermediate positions.
      }
    }
    const specialPieces = s.codes.flatMap((code, i) =>
      RESULTS[code] ? [{ square: squareName(s.rotated ? 63 - i : i), result: RESULTS[code] }] : [],
    );
    const results = new Set(specialPieces.map((p) => p.result));
    const declaredByKings = kingsResult(s.codes, s.rotated);
    if (declaredByKings) results.add(declaredByKings);
    if (results.size > 1) {
      s.resultStatus = "conflicting";
    } else if (results.size === 1 && s.resultStatus !== "conflicting") {
      const declared = [...results][0];
      if (s.result && s.result !== declared) s.resultStatus = "conflicting";
      else {
        s.result = declared;
        s.resultStatus = "reported";
      }
      this.results.set(s.physicalId, { result: s.result, resultStatus: s.resultStatus });
    }
    this.emitState(s, {
      fen: positionStatus === "unresolved" ? `${target} w - - 0 1` : s.chess!.fen(),
      positionStatus,
      orientation: s.rotated ? "rotated" : "normal",
      ...(lastMove || positionStatus !== "tracked" ? { lastMove } : {}),
      specialPieces,
      result: s.resultStatus === "conflicting" ? undefined : s.result,
      resultStatus: s.resultStatus ?? "none",
    });
  }
  private async optionalRead(s: Session, read: () => Promise<unknown>): Promise<boolean> {
    try {
      await read();
      return true;
    } catch (error) {
      if (!(error instanceof RequestTimeout)) throw error;
      this.emit("request-timeout", { tableId: s.tableId, message: error.message });
      return false;
    }
  }
  private async readBattery(s: Session): Promise<void> {
    s.lastBatteryAt = Date.now();
    if (!(await this.optionalRead(s, () => s.client.readBattery())))
      s.batteryStatus = "unresponsive";
  }
  private async readIdentity(s: Session): Promise<void> {
    s.lastIdentityAt = Date.now();
    if (!s.serial) await this.optionalRead(s, () => s.client.request(Command.serial, "serial"));
    if (!s.version) await this.optionalRead(s, () => s.client.request(Command.version, "version"));
  }
  private async readClockIfQuiet(s: Session): Promise<void> {
    if (s.lastClockAt === undefined || Date.now() - s.lastClockAt >= 15_000)
      await this.optionalRead(s, () => s.client.readClock());
  }
  private async poll(s: Session): Promise<void> {
    if (!s.connected || s.polling || s.refreshPromise) return;
    s.polling = true;
    try {
      if (!(await this.optionalRead(s, () => s.client.readPosition()))) {
        s.failures++;
        const lastRx = s.client.metrics.lastRxAt;
        if (!s.codes || !lastRx || Date.now() - Date.parse(lastRx) >= 30_000)
          this.emitState(s, { status: "degraded" });
      }
      await this.readClockIfQuiet(s);
      if (Date.now() - (s.lastBatteryAt ?? 0) >= 60_000) await this.readBattery(s);
      if ((!s.serial || !s.version) && Date.now() - (s.lastIdentityAt ?? 0) >= 60_000)
        await this.readIdentity(s);
    } catch (error) {
      s.failures++;
      this.report(s, error instanceof Error ? error : new Error(String(error)));
      if (s.connected) this.emitState(s, { status: "degraded" });
    } finally {
      s.polling = false;
      this.emit("diagnostics", this.diagnostics());
    }
  }
  private session(tableId: number): Session {
    const s = this.sessions.get(tableId);
    if (!s?.connected) throw new Error("Échiquier non connecté");
    return s;
  }
  async readHistory(tableId: number) {
    return this.session(tableId).client.readHistory();
  }
  newGame(tableId: number): void {
    const s = this.session(tableId);
    if (s.codes && (kingsResult(s.codes, s.rotated) || s.codes.some((code) => RESULTS[code])))
      throw new Error(
        "Retirez d'abord la disposition ou les pièces de résultat avant de démarrer une nouvelle partie.",
      );
    s.result = undefined;
    s.resultStatus = "none";
    this.results.delete(s.physicalId);
    s.chess = undefined;
    this.emitState(s, {
      result: undefined,
      resultStatus: "none",
      lastMove: undefined,
      positionStatus: "unresolved",
    });
    this.publishPosition(s);
  }
  async refresh(tableId: number): Promise<void> {
    const s = this.session(tableId);
    s.refreshPromise ??= (async () => {
      await this.optionalRead(s, () => s.client.readPosition());
      await this.optionalRead(s, () => s.client.readClock());
      await this.readBattery(s);
      await this.readIdentity(s);
    })().finally(() => {
      s.refreshPromise = undefined;
      this.emit("diagnostics", this.diagnostics());
    });
    await s.refreshPromise;
  }
  diagnostics() {
    return [...this.sessions.values()].map((s) => ({
      tableId: s.tableId,
      physicalId: s.physicalId,
      path: s.path,
      connected: s.connected,
      startedAt: s.startedAt,
      lastPositionAt: s.lastPositionAt,
      lastClockReceivedAt:
        s.lastClockAt === undefined ? undefined : new Date(s.lastClockAt).toISOString(),
      serial: s.serial,
      version: s.version,
      batteryStatus: s.batteryStatus,
      lastBatteryAttemptAt: s.lastBatteryAt ? new Date(s.lastBatteryAt).toISOString() : undefined,
      lastBatteryReceivedAt: s.lastBatteryReceivedAt,
      lastError: s.lastError,
      consecutiveFailures: s.failures,
      ...s.client.metrics,
    }));
  }
  async disconnect(tableId: number): Promise<void> {
    const pending = this.connections.get(tableId);
    if (pending)
      await pending.promise.catch((error: unknown) => {
        const s = this.sessions.get(tableId);
        if (s) this.report(s, error instanceof Error ? error : new Error(String(error)));
      });
    await this.releaseSession(tableId);
  }
  private async releaseSession(tableId: number): Promise<void> {
    const s = this.sessions.get(tableId);
    if (!s) return;
    this.markDisconnected(s);
    await s.client.close();
    this.sessions.delete(tableId);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.promise));
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }
}
