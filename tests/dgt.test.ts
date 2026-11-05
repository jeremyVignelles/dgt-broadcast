import { afterEach, describe, expect, it, vi } from "vitest";
import { Command, Message, squareIndex } from "../src/dgt/protocol.ts";
import { DgtTransport } from "../src/adapters/dgt.ts";
import { ProtocolSimulator, INITIAL_CODES } from "../src/dgt/simulator.ts";

const transports: DgtTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});
function setup(options: { pollMs?: number; reconnectInitialMs?: number } = {}) {
  const simulator = new ProtocolSimulator();
  const transport = new DgtTransport({
    createTransport: () => simulator,
    settleMs: 2,
    pollMs: options.pollMs ?? 60_000,
    reconnectInitialMs: options.reconnectInitialMs,
  });
  transports.push(transport);
  const states: Record<string, unknown>[] = [];
  transport.on("state", ({ patch }) => states.push(patch));
  const latest = () => Object.assign({}, ...states);
  return { simulator, transport, states, latest };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("DGT hardware adapter", () => {
  it.each([
    ["e4", "d5", "1-0"],
    ["d4", "e5", "0-1"],
    ["e4", "e5", "1/2-1/2"],
    ["d4", "d5", "1/2-1/2"],
  ])(
    "recognizes kings on %s and %s as %s in either color order and orientation",
    async (a, b, result) => {
      for (const rotated of [false, true]) {
        for (const swap of [false, true]) {
          const { simulator, transport, latest } = setup();
          if (rotated) simulator.codes.reverse();
          await transport.connect(1, "DGT_BT_TEST", "test");
          const index = (square: string) =>
            rotated ? 63 - squareIndex(square) : squareIndex(square);
          simulator.changeSquare(index("e1"), 0);
          simulator.changeSquare(index("e8"), 0);
          simulator.changeSquare(index(a), swap ? 11 : 5);
          simulator.changeSquare(index(b), swap ? 5 : 11);
          await settle();
          expect(latest()).toMatchObject({ result, resultStatus: "reported", specialPieces: [] });
          simulator.changeSquare(index(b), 0);
          await settle();
          expect(latest().result).toBe(result);
          expect(latest().resultStatus).toBe("reported");
          await transport.disconnect(1);
          await transport.connect(1, "DGT_BT_TEST", "test");
          expect(latest().result).toBe(result);
          transport.newGame(1);
          expect(latest().result).toBeUndefined();
          expect(latest().resultStatus).toBe("none");
          await transport.close();
        }
      }
    },
  );
  it("does not declare results for other adjacent squares or duplicate kings and reports conflicting declarations", async () => {
    const { simulator, transport, latest } = setup();
    simulator.codes.fill(0);
    simulator.codes[squareIndex("e4")] = 5;
    simulator.codes[squareIndex("d4")] = 11;
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest().result).toBeUndefined();
    simulator.changeSquare(squareIndex("d4"), 0);
    simulator.changeSquare(squareIndex("d5"), 5);
    await settle();
    expect(latest().result).toBeUndefined();
    simulator.changeSquare(squareIndex("d5"), 11);
    simulator.changeSquare(squareIndex("a1"), 15);
    await settle();
    expect(latest()).toMatchObject({ result: undefined, resultStatus: "conflicting" });
    simulator.changeSquare(squareIndex("a1"), 14);
    await settle();
    expect(latest()).toMatchObject({ result: undefined, resultStatus: "conflicting" });
    expect(() => transport.newGame(1)).toThrow(/Retirez/);
  });
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
      whiteClock: 599,
      blackClock: 600,
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    });
  });
  it("applies a batched simulated position through the real DGT protocol", async () => {
    const { simulator, transport, latest } = setup();
    await transport.connect(1, "DGT_BT_TEST", "test");
    const next = [...INITIAL_CODES];
    next[squareIndex("e2")] = 0;
    next[squareIndex("e4")] = 1;
    simulator.setPosition(next);
    await settle();
    expect(latest()).toMatchObject({
      fen: expect.stringContaining("4P3"),
      lastMove: "e2e4",
      positionStatus: "tracked",
    });
    expect(() => simulator.setPosition([...next, 1])).toThrow(/Position/);
  });
  it("always maps left to white, including when connecting to a running clock", async () => {
    const { simulator, transport, latest } = setup();
    simulator.clock = [0, 9, 0, 0, 8, 0, 17];
    await transport.connect(1, "DGT_BT_TEST", "test");
    expect(latest()).toMatchObject({ whiteClock: 480, blackClock: 540 });
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
    expect(latest()).toMatchObject({ whiteClock: 600, blackClock: 599 });
    simulator.setClock([0, 9, 0x58, 0, 9, 0x59, 9]);
    await settle();
    expect(latest()).toMatchObject({ whiteClock: 599, blackClock: 598 });
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
    await vi.waitFor(
      () => {
        const diagnostics = transport.diagnostics();
        expect(diagnostics).toHaveLength(8);
        for (const board of diagnostics) {
          expect(board).toMatchObject({ connected: true, timeouts: 0, protocolErrors: 0 });
          expect(
            simulators[board.tableId - 1].commands.filter((c) => c === Command.position).length,
          ).toBeGreaterThanOrEqual(4);
        }
      },
      { timeout: 1000, interval: 10 },
    );
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

  it("reconnects automatically with backoff after a link loss, but not after a manual disconnect", async () => {
    const { simulator, transport } = setup({ reconnectInitialMs: 5 });
    const scheduled: number[] = [];
    transport.on("reconnect-scheduled", ({ attempt }) => scheduled.push(attempt));
    await transport.connect(1, "DGT_BT_TEST", "test");
    simulator.fail(new Error("link lost"));
    await vi.waitFor(() => expect(transport.diagnostics()[0]?.connected).toBe(true));
    expect(scheduled).toEqual([1]);
    await transport.disconnect(1);
    simulator.fail(new Error("link lost"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(scheduled).toEqual([1]);
  });
  it("does not schedule a reconnect when disconnecting during connection startup", async () => {
    let releaseOpen!: () => void;
    const opened = new Promise<void>((resolve) => (releaseOpen = resolve));
    const simulator = new ProtocolSimulator();
    const open = simulator.open.bind(simulator);
    simulator.open = async () => {
      await opened;
      await open();
    };
    const transport = new DgtTransport({
      createTransport: () => simulator,
      reconnectInitialMs: 5,
    });
    transports.push(transport);
    const reconnects: number[] = [];
    transport.on("reconnect-scheduled", ({ attempt }) => reconnects.push(attempt));
    const connection = transport.connect(1, "DGT_BT_TEST", "test");
    await Promise.resolve();
    await Promise.resolve();
    const disconnect = transport.disconnect(1);
    releaseOpen();
    await Promise.all([connection, disconnect]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transport.diagnostics()).toEqual([]);
    expect(reconnects).toEqual([]);
  });
});
