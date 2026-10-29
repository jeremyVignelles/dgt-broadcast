import { afterEach, describe, expect, it, vi } from "vitest";
import { Command, Message } from "../src/dgt/protocol.ts";
import { DgtTransport } from "../src/adapters/dgt.ts";
import { ProtocolSimulator, INITIAL_CODES } from "../src/dgt/simulator.ts";

const transports: DgtTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});
function setup(options: { pollMs?: number } = {}) {
  const simulator = new ProtocolSimulator();
  const transport = new DgtTransport({
    createTransport: () => simulator,
    settleMs: 2,
    pollMs: options.pollMs ?? 60_000,
  });
  transports.push(transport);
  const states: Record<string, unknown>[] = [];
  transport.on("state", ({ patch }) => states.push(patch));
  const latest = () => Object.assign({}, ...states);
  return { simulator, transport, states, latest };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("DGT hardware adapter", () => {
  it("accepts late battery and identity messages without clearing the last measured state", async () => {
    vi.useFakeTimers();
    const { simulator, transport, latest } = setup();
    simulator.ignoredCommands.add(Command.battery);
    simulator.ignoredCommands.add(Command.version);
    const faults: Error[] = [];
    transport.on("board-error", ({ error }) => faults.push(error));
    try {
      const connection = transport.connect(1, "DGT_BT_TEST", "test");
      await vi.advanceTimersByTimeAsync(6100);
      await connection;
      simulator.emitFrame(Message.battery, [73, 21, 25, 0, 0, 0, 0, 0, 2]);
      simulator.emitFrame(Message.version, [2, 10]);
      await vi.advanceTimersByTimeAsync(1);
      expect(latest().battery).toBe(73);
      expect(transport.diagnostics()[0]).toMatchObject({
        version: "2.10",
        batteryStatus: "available",
      });
      const refresh = transport.refresh(1);
      await vi.advanceTimersByTimeAsync(3100);
      await refresh;
      expect(latest().battery).toBe(73);
      expect(transport.diagnostics()[0].batteryStatus).toBe("unresponsive");
      expect(faults).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps polling after missed initial positions and avoids clock requests while push is active", async () => {
    vi.useFakeTimers();
    const { simulator, transport, latest } = setup({ pollMs: 10_000 });
    simulator.ignoredCommands.add(Command.position);
    try {
      const connection = transport.connect(1, "DGT_BT_TEST", "test");
      await vi.advanceTimersByTimeAsync(12100);
      await connection;
      expect(latest().status).toBe("degraded");
      simulator.ignoredCommands.clear();
      const clockRequests = simulator.commands.filter((c) => c === Command.clock).length;
      simulator.setClock([0, 0x10, 0, 0, 0x10, 0, 8]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(latest().status).toBe("connected");
      expect(simulator.commands.filter((c) => c === Command.clock)).toHaveLength(clockRequests);
      simulator.ignoredCommands.add(Command.position);
      for (let i = 0; i < 4; i++) {
        simulator.setClock([0, 0x10, 0, 0, 0x10, 0, 8]);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(transport.diagnostics()[0].connected).toBe(true);
      expect(latest().clock).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retries an unanswered battery automatically and recovers missing firmware identity", async () => {
    vi.useFakeTimers();
    const { simulator, transport, latest } = setup({ pollMs: 10_000 });
    simulator.ignoredCommands.add(Command.battery);
    simulator.ignoredCommands.add(Command.version);
    try {
      const connection = transport.connect(1, "DGT_BT_TEST", "test");
      await vi.advanceTimersByTimeAsync(12_100);
      await connection;
      expect(transport.diagnostics()[0]).toMatchObject({ batteryStatus: "unresponsive" });
      expect(latest().battery).toBeUndefined();
      expect(simulator.commands.filter((c) => c === Command.battery)).toHaveLength(1);
      simulator.ignoredCommands.clear();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(transport.diagnostics()[0]).toMatchObject({
        batteryStatus: "available",
        version: "2.10",
        retries: 0,
      });
      expect(transport.diagnostics()[0].lastBatteryReceivedAt).toBeDefined();
      expect(latest().battery).toBe(85);
    } finally {
      vi.useRealTimers();
    }
  });
  it("allows manual recovery after a failed battery request without reconnecting", async () => {
    vi.useFakeTimers();
    const { simulator, transport, latest } = setup();
    simulator.ignoredCommands.add(Command.battery);
    try {
      const connection = transport.connect(1, "DGT_BT_TEST", "test");
      await vi.advanceTimersByTimeAsync(6100);
      await connection;
      simulator.ignoredCommands.clear();
      await transport.refresh(1);
      expect(latest().battery).toBe(85);
      expect(transport.diagnostics()[0]).toMatchObject({
        connected: true,
        batteryStatus: "available",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads actual protocol frames, battery and clocks, then infers a move", async () => {
    const { simulator, transport, latest } = setup();
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest()).toMatchObject({
      status: "connected",
      battery: 85,
      whiteClock: 600,
      clock: { connected: true, running: false },
    });
    simulator.setClock([0, 0x10, 0, 0, 9, 0x59, 9]);
    simulator.changeSquare(36, 1);
    simulator.changeSquare(52, 0);
    await settle();
    expect(latest()).toMatchObject({
      lastMove: "e2e4",
      whiteClockSide: "left",
      whiteClock: 599,
      blackClock: 600,
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    });
  });
  it("maps left to white by default and supports an explicit override", async () => {
    const { simulator, transport, latest } = setup();
    simulator.clock = [0, 9, 0, 0, 8, 0, 17];
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest()).toMatchObject({ whiteClock: 480, blackClock: 540 });
    transport.setClockSide(1, "right");
    expect(latest()).toMatchObject({ whiteClock: 540, blackClock: 480 });
    simulator.setClock([0, 0, 0, 0, 0, 0, 0x20]);
    await settle();
    expect(latest()).toMatchObject({ whiteClock: null, clock: { connected: false } });
  });
  it("keeps left mapped to white regardless of which clock starts first", async () => {
    const { simulator, transport, latest } = setup();
    await transport.connect(1, "DGT_BT_TEST", "test");
    simulator.changeSquare(52, 0);
    simulator.changeSquare(36, 1);
    await settle();
    simulator.setClock([0, 9, 0x59, 0, 0x10, 0, 17]);
    await settle();
    expect(latest()).toMatchObject({ whiteClockSide: "left", whiteClock: 600, blackClock: 599 });
    simulator.setClock([0, 9, 0x58, 0, 9, 0x59, 9]);
    await settle();
    expect(latest()).toMatchObject({ whiteClockSide: "left", whiteClock: 599, blackClock: 598 });
  });
  it("preserves legal context through incomplete manipulations and clears result pieces", async () => {
    const { simulator, transport, latest } = setup();
    await transport.connect(1, "DGT_BT_TEST", "test");
    simulator.changeSquare(52, 0);
    await settle();
    expect(latest()).toMatchObject({ positionStatus: "unresolved" });
    simulator.changeSquare(36, 1);
    await settle();
    expect(latest()).toMatchObject({ positionStatus: "tracked", lastMove: "e2e4" });
    simulator.changeSquare(32, 14);
    await settle();
    expect(latest()).toMatchObject({
      result: "1-0",
      specialPieces: [{ square: "a4", result: "1-0" }],
    });
    simulator.changeSquare(33, 15);
    await settle();
    expect(latest().result).toBeUndefined();
    simulator.changeSquare(32, 0);
    simulator.changeSquare(33, 0);
    await settle();
    expect(latest().specialPieces).toEqual([]);
  });
  it("detects rotated initial positions, supports history and closes/reopens", async () => {
    const { simulator, transport, latest } = setup();
    simulator.codes = [...INITIAL_CODES].reverse();
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest()).toMatchObject({ orientation: "rotated", positionStatus: "initial" });
    expect(await transport.readHistory(1)).toMatchObject({ kind: "history" });
    await transport.disconnect(1);
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest().status).toBe("connected");
  });
  it("polls eight isolated connections concurrently without cross-contamination", async () => {
    const simulators = Array.from({ length: 8 }, () => new ProtocolSimulator());
    const transport = new DgtTransport({
      createTransport: (path) => simulators[Number(path)],
      pollMs: 20,
    });
    transports.push(transport);
    await Promise.all(simulators.map((_, i) => transport.connect(i + 1, `DGT_BT_${i}`, String(i))));
    await new Promise((resolve) => setTimeout(resolve, 70));
    const diagnostics = transport.diagnostics();
    expect(diagnostics).toHaveLength(8);
    for (const board of diagnostics) {
      expect(board).toMatchObject({ connected: true, timeouts: 0, protocolErrors: 0 });
      expect(
        simulators[board.tableId - 1].commands.filter((c) => c === Command.position).length,
      ).toBeGreaterThanOrEqual(4);
    }
  });
  it("reports transport faults and frees sessions for explicit reconnection", async () => {
    const { simulator, transport, latest } = setup();
    const errors: Error[] = [];
    transport.on("board-error", ({ error }) => errors.push(error));
    await transport.connect(1, "DGT_BT_TEST", "test");
    simulator.fail(new Error("USB disconnected"));
    expect(latest().status).toBe("disconnected");
    expect(errors[0].message).toContain("USB disconnected");
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest().status).toBe("connected");
  });
});
