import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayClock } from "../services/web/admin/src/display/clock.ts";
import { BroadcastCore } from "../src/domain/core.ts";
import { emptyGame } from "../src/domain/types.ts";
import type { GameState } from "../src/domain/types.ts";

function game(): GameState {
  const time = { seconds: 10, flagFallen: false, flagIndicated: false, perMove: false };
  return {
    ...emptyGame(1),
    physicalId: "board",
    whiteClock: 10,
    blackClock: 10,
    clockReadingId: "1",
    clock: {
      connected: true,
      running: true,
      activeSide: "left",
      leverHigh: "left",
      batteryLow: false,
      left: time,
      right: time,
    },
  };
}

describe("display clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down the running side and stops at zero", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    clock.update(game());
    vi.advanceTimersByTime(3100);
    expect(changed).toHaveBeenLastCalledWith({ white: 7, black: 10 });
    vi.advanceTimersByTime(10_000);
    expect(changed).toHaveBeenLastCalledWith({ white: 0, black: 10 });
    expect(vi.getTimerCount()).toBe(0);
    clock.dispose();
  });

  it("catches up when a timer callback is delayed", () => {
    let now = 0;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => now);
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    clock.update(game());
    now = 3200;
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenLastCalledWith({ white: 7, black: 10 });
    now = 4000;
    vi.advanceTimersByTime(800);
    expect(changed).toHaveBeenLastCalledWith({ white: 6, black: 10 });
    clock.dispose();
    monotonic.mockRestore();
  });

  it("ignores unrelated projections and retains phase for a matching reading", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(1400);
    clock.update({ ...state, fen: "new position" });
    clock.update({ ...state, whiteClock: 9, clockReadingId: "2" });
    vi.advanceTimersByTime(600);
    expect(changed).toHaveBeenLastCalledWith({ white: 8, black: 10 });
    clock.dispose();
  });

  it.each([
    [8, true],
    [9, false],
    [10, false],
    [11, false],
    [12, true],
  ])("recalibrates a running clock reading of %i only beyond one second", (reading, recalibrates) => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(300);
    clock.update({ ...state, whiteClock: reading, clockReadingId: "2" });
    expect(changed).toHaveBeenLastCalledWith({
      white: recalibrates ? reading : 10,
      black: 10,
    });
    vi.advanceTimersByTime(700);
    expect(changed).toHaveBeenLastCalledWith({
      white: recalibrates ? reading : 9,
      black: 10,
    });
    vi.advanceTimersByTime(300);
    expect(changed).toHaveBeenLastCalledWith({
      white: recalibrates ? reading - 1 : 9,
      black: 10,
    });
    clock.dispose();
  });

  it("keeps a steady cadence through irregular readings and updates the stopped side", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(100);
    clock.update({ ...state, whiteClock: 9, blackClock: 11, clockReadingId: "2" });
    expect(changed).toHaveBeenLastCalledWith({ white: 10, black: 11 });
    vi.advanceTimersByTime(900);
    expect(changed).toHaveBeenLastCalledWith({ white: 9, black: 11 });
    vi.advanceTimersByTime(700);
    clock.update({ ...state, whiteClock: 10, blackClock: 12, clockReadingId: "3" });
    expect(changed).toHaveBeenLastCalledWith({ white: 9, black: 12 });
    vi.advanceTimersByTime(300);
    expect(changed).toHaveBeenLastCalledWith({ white: 8, black: 12 });
    clock.dispose();
  });

  it("immediately applies stopped readings and restarts the new active side", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(400);
    clock.update({
      ...state,
      whiteClock: 9,
      blackClock: 11,
      clockReadingId: "2",
      clock: { ...state.clock!, running: false },
    });
    expect(changed).toHaveBeenLastCalledWith({ white: 9, black: 11 });
    vi.advanceTimersByTime(2000);
    clock.update({
      ...state,
      whiteClock: 8,
      blackClock: 10,
      clockReadingId: "3",
      clock: { ...state.clock!, running: false },
    });
    expect(changed).toHaveBeenLastCalledWith({ white: 8, black: 10 });
    clock.update({
      ...state,
      whiteClock: 8,
      blackClock: 10,
      clockReadingId: "4",
      clock: { ...state.clock!, activeSide: "right" },
    });
    vi.advanceTimersByTime(999);
    expect(changed).toHaveBeenLastCalledWith({ white: 8, black: 10 });
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith({ white: 8, black: 9 });
    clock.dispose();
  });

  it("recalibrates mismatches and handles pause, side changes and disconnect", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(300);
    clock.update({ ...state, whiteClock: 6, blackClock: 12, clockReadingId: "2" });
    vi.advanceTimersByTime(999);
    expect(changed).toHaveBeenLastCalledWith({ white: 6, black: 12 });
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith({ white: 5, black: 12 });
    clock.update({
      ...state,
      whiteClock: 5,
      blackClock: 12,
      clockReadingId: "3",
      clock: { ...state.clock!, activeSide: "right" },
    });
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenLastCalledWith({ white: 5, black: 11 });
    clock.update({
      ...state,
      whiteClock: 5,
      blackClock: 11,
      clockReadingId: "4",
      clock: { ...state.clock!, running: false },
    });
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenLastCalledWith({ white: 5, black: 11 });
    clock.update({ ...state, whiteClock: null, blackClock: null, clock: undefined });
    vi.advanceTimersByTime(2000);
    expect(changed).toHaveBeenLastCalledWith({ white: null, black: null });
    clock.dispose();
  });

  it("resets for a replacement board and cancels its timer on disposal", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = game();
    clock.update(state);
    vi.advanceTimersByTime(500);
    clock.update({ ...state, physicalId: "other", clockReadingId: "2" });
    vi.advanceTimersByTime(500);
    expect(changed).toHaveBeenLastCalledWith({ white: 10, black: 10 });
    clock.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates static times even when there is no clock reading", () => {
    const changed = vi.fn();
    const clock = new DisplayClock(changed);
    const state = { ...game(), clock: undefined, clockReadingId: undefined };
    clock.update(state);
    clock.update({ ...state, whiteClock: null, blackClock: null });
    expect(changed).toHaveBeenLastCalledWith({ white: null, black: null });
    expect(vi.getTimerCount()).toBe(0);
    clock.dispose();
  });
});

it("identifies each clock reading without changing its id for unrelated updates", () => {
  const core = new BroadcastCore(1);
  const state = game();
  const first = core.updateGame(1, { clock: state.clock }).clockReadingId;
  expect(first).toBeDefined();
  expect(core.updateGame(1, { fen: "new position" }).clockReadingId).toBe(first);
  expect(core.updateGame(1, { clock: state.clock }).clockReadingId).not.toBe(first);
  expect(core.updateGame(1, { clock: undefined }).clockReadingId).toBeUndefined();
});
