import type { GameState } from "../../../../../src/domain/types.ts";

type Side = "white" | "black";
type Times = Record<Side, number | null>;

const SECOND = 1000;
const TOLERANCE_SECONDS = 1;

export class DisplayClock {
  private times: Times = { white: null, black: null };
  private active?: Side;
  private nextTick = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readingId?: string;
  private physicalId?: string;
  private received: Times = { white: null, black: null };
  private initialized = false;

  constructor(private readonly onChange: (times: Times) => void) {}

  update(game: GameState): void {
    const active =
      game.clock?.connected && game.clock.running
        ? game.clock.activeSide === "left"
          ? "white"
          : game.clock.activeSide === "right"
            ? "black"
            : undefined
        : undefined;
    if (
      this.initialized &&
      this.readingId === game.clockReadingId &&
      this.physicalId === game.physicalId &&
      this.active === active &&
      this.received.white === game.whiteClock &&
      this.received.black === game.blackClock
    )
      return;

    const now = performance.now();
    this.advance(now);
    const incoming = { white: game.whiteClock, black: game.blackClock };
    const sameClock = this.initialized && this.physicalId === game.physicalId;
    const previous = active ? this.times[active] : null;
    const received = active ? incoming[active] : null;
    const keepSchedule =
      sameClock &&
      active !== undefined &&
      active === this.active &&
      previous !== null &&
      received !== null &&
      Math.abs(received - previous) <= TOLERANCE_SECONDS;

    this.readingId = game.clockReadingId;
    this.physicalId = game.physicalId;
    this.received = { ...incoming };
    this.initialized = true;
    this.active = active;
    if (keepSchedule && active) incoming[active] = previous;
    else this.nextTick = now + SECOND;
    this.times = incoming;
    this.publish();
    this.schedule(now);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private advance(now: number): void {
    if (!this.active || this.times[this.active] === null || now < this.nextTick) return;
    const elapsed = Math.floor((now - this.nextTick) / SECOND) + 1;
    this.times[this.active] = Math.max(0, this.times[this.active]! - elapsed);
    this.nextTick += elapsed * SECOND;
  }

  private publish(): void {
    this.onChange({ ...this.times });
  }

  private schedule(now: number): void {
    clearTimeout(this.timer);
    if (!this.active || this.times[this.active] === null || this.times[this.active] === 0) return;
    this.timer = setTimeout(() => {
      const current = performance.now();
      this.advance(current);
      this.publish();
      this.schedule(current);
    }, Math.max(0, this.nextTick - now));
  }
}
