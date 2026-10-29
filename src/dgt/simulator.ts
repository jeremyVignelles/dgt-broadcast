import { EventEmitter } from "node:events";
import { Command, Message, encodeFrame, piece, squareName } from "./protocol.ts";
import type { ClockSide } from "./protocol.ts";
import type { ByteTransport } from "./client.ts";

export const INITIAL_CODES = [
  8,
  9,
  10,
  12,
  11,
  10,
  9,
  8,
  ...Array<number>(8).fill(7),
  ...Array<number>(32).fill(0),
  ...Array<number>(8).fill(1),
  2,
  3,
  4,
  6,
  5,
  4,
  3,
  2,
];

/** Command-responsive simulator: exercises the same byte stream as serial hardware. */
export class ProtocolSimulator implements ByteTransport {
  private readonly events = new EventEmitter();
  private opened = false;
  private updates = false;
  codes = [...INITIAL_CODES];
  clock = [0, 0x10, 0, 0, 0x10, 0, 0];
  battery = [85, 10, 30, 2, 15, 3, 4, 5, 2];
  history = [0x6a, 0x6f, 0x40, 52, 0x41, 36, 0x70, 9, 0x58, 0x6b];
  fragmentSize = 4;
  ignoredCommands = new Set<number>();
  commands: number[] = [];

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
    this.events.emit("close");
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (!this.opened) throw new Error("Simulateur fermé");
    for (const command of bytes) {
      this.commands.push(command);
      if (this.ignoredCommands.has(command)) continue;
      switch (command) {
        case Command.idle:
          this.updates = false;
          break;
        case Command.niceUpdates:
        case Command.updates:
        case Command.boardUpdates:
          this.updates = true;
          break;
        case Command.position:
          this.emitFrame(Message.position, this.codes);
          break;
        case Command.serial:
          this.emitFrame(Message.serial, [49, 50, 51, 52, 53]);
          break;
        case Command.longSerial:
          this.emitFrame(Message.longSerial, Array<number>(10).fill(49));
          break;
        case Command.version:
          this.emitFrame(Message.version, [2, 10]);
          break;
        case Command.clock:
          this.emitFrame(Message.clock, this.clock);
          break;
        case Command.battery:
          this.emitFrame(Message.battery, this.battery);
          break;
        case Command.history:
          this.emitFrame(Message.history, this.history);
          break;
        default:
          throw new Error(`Commande simulée inconnue : ${command}`);
      }
    }
  }
  emitFrame(id: number, payload: number[]): void {
    const bytes = encodeFrame(id, payload);
    queueMicrotask(() => {
      if (!this.opened) return;
      for (let offset = 0; offset < bytes.length; offset += this.fragmentSize)
        this.events.emit("data", bytes.slice(offset, offset + this.fragmentSize));
    });
  }
  changeSquare(index: number, code: number): void {
    squareName(index);
    piece(code);
    this.codes[index] = code;
    if (this.updates) this.emitFrame(Message.square, [index, code]);
  }
  setClock(payload: number[]): void {
    this.clock = payload;
    if (this.updates) this.emitFrame(Message.clock, payload);
  }
  setTimes(
    left: number,
    right: number,
    running: boolean,
    activeSide: ClockSide,
    connected: boolean,
  ): void {
    const time = (seconds: number) => {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 35999)
        throw new Error("Temps simulé invalide (0 à 35999 secondes)");
      const bcd = (value: number) => Math.floor(value / 10) * 16 + (value % 10);
      return [Math.floor(seconds / 3600), bcd(Math.floor(seconds / 60) % 60), bcd(seconds % 60)];
    };
    if (
      typeof running !== "boolean" ||
      typeof connected !== "boolean" ||
      (activeSide !== "left" && activeSide !== "right")
    )
      throw new Error("État de pendule simulé invalide");
    const status = (running ? 1 : 0) | (activeSide === "left" ? 16 : 10) | (connected ? 0 : 32);
    this.setClock([...time(right), ...time(left), status]);
  }
  setBattery(percent: number): void {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100)
      throw new Error("Batterie simulée invalide");
    this.battery[0] = percent;
    if (this.updates) this.emitFrame(Message.battery, this.battery);
  }
  inject(bytes: Uint8Array): void {
    this.events.emit("data", bytes);
  }
  fail(error: Error): void {
    this.events.emit("fault", error);
  }
  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.events.on("data", listener);
    return () => this.events.removeListener("data", listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.events.on("fault", listener);
    return () => this.events.removeListener("fault", listener);
  }
  onClose(listener: () => void): () => void {
    this.events.on("close", listener);
    return () => this.events.removeListener("close", listener);
  }
}
