import { ProtocolSimulator } from "./simulator.ts";
import type { GameState } from "../domain/types.ts";

const codes: Record<string, number> = {
  P: 1,
  R: 2,
  N: 3,
  B: 4,
  K: 5,
  Q: 6,
  p: 7,
  r: 8,
  n: 9,
  b: 10,
  k: 11,
  q: 12,
};

export class VirtualBoard {
  readonly transport = new ProtocolSimulator();
  private left: number;
  private right: number;
  private running: boolean;
  private activeSide: "left" | "right";
  private clockConnected: boolean;
  private lastTick = Date.now();
  private timer: NodeJS.Timeout;

  constructor(game: GameState) {
    const position = game.fen
      .split(" ")[0]
      .split("/")
      .flatMap((row) =>
        [...row].flatMap((token) => {
          if (/^[1-8]$/.test(token)) return Array<number>(Number(token)).fill(0);
          if (codes[token] === undefined) throw new Error("Position virtuelle invalide");
          return [codes[token]];
        }),
      );
    if (position.length !== 64) throw new Error("Position virtuelle invalide");
    this.transport.setPosition(position);
    this.left = game.whiteClock ?? 600;
    this.right = game.blackClock ?? 600;
    this.running = game.clock?.running ?? false;
    this.activeSide = game.clock?.activeSide ?? "left";
    this.clockConnected = game.clock?.connected ?? true;
    this.transport.setBattery(game.battery ?? 85);
    this.updateClock();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  private updateClock(): void {
    this.transport.setTimes(
      this.left,
      this.right,
      this.running,
      this.activeSide,
      this.clockConnected,
    );
  }
  private tick(): void {
    const now = Date.now();
    const elapsed = Math.floor((now - this.lastTick) / 1000);
    if (!elapsed) return;
    this.lastTick += elapsed * 1000;
    if (!this.running || !this.clockConnected) return;
    if (this.activeSide === "left") this.left = Math.max(0, this.left - elapsed);
    else this.right = Math.max(0, this.right - elapsed);
    if ((this.activeSide === "left" ? this.left : this.right) === 0) this.running = false;
    this.updateClock();
  }
  setClock(
    left: number,
    right: number,
    running: boolean,
    activeSide: "left" | "right",
    connected: boolean,
  ): void {
    this.transport.setTimes(left, right, running, activeSide, connected);
    this.left = left;
    this.right = right;
    this.running = running;
    this.activeSide = activeSide;
    this.clockConnected = connected;
    this.lastTick = Date.now();
  }
  close(): void {
    clearInterval(this.timer);
  }
}
