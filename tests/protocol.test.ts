import { describe, expect, it } from "vitest";
import { DgtClient, RequestTimeout } from "../src/dgt/client.ts";
import {
  Command,
  FrameParser,
  Message,
  decode,
  decodeHistory,
  encodeFrame,
} from "../src/dgt/protocol.ts";
import { INITIAL_CODES, ProtocolSimulator } from "../src/dgt/simulator.ts";

describe("DGT framing", () => {
  it("handles all splits, coalescing, noise and the actual field-update identifier", () => {
    const bytes = encodeFrame(Message.square, [36, 1]);
    for (let split = 1; split < bytes.length; split++) {
      const parser = new FrameParser();
      expect(parser.push(bytes.slice(0, split)).frames).toEqual([]);
      expect(decode(parser.push(bytes.slice(split)).frames[0])).toEqual({
        kind: "square",
        index: 36,
        square: "e4",
        code: 1,
      });
    }
    const parser = new FrameParser();
    const parsed = parser.push(Uint8Array.from([0, 0x8e, 0, 9, 1, ...bytes, ...bytes]));
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.frames).toHaveLength(2);
    expect(() => decode({ id: 0x86, payload: Uint8Array.of(36, 1) })).toThrow(/Longueur/);
  });
  it("decodes a 67-byte board and rejects invalid squares or pieces", () => {
    expect(decode({ id: Message.position, payload: Uint8Array.from(INITIAL_CODES) })).toMatchObject(
      { kind: "position", codes: INITIAL_CODES },
    );
    expect(() => decode({ id: Message.square, payload: Uint8Array.of(64, 1) })).toThrow(/invalide/);
    expect(() => decode({ id: Message.square, payload: Uint8Array.of(0, 16) })).toThrow(/invalide/);
  });
  it("uses 7-bit lengths for large history frames", () => {
    const parser = new FrameParser();
    const bytes = encodeFrame(Message.history, [...Array<number>(300).fill(127), 0x6b]);
    expect(bytes.slice(1, 3)).toEqual(Uint8Array.of(2, 48));
    expect(decode(parser.push(bytes).frames[0])).toMatchObject({ kind: "history" });
  });
});
describe("DGT observations", () => {
  it("reports a partial oldest EEPROM entry in a full circular buffer without losing raw bytes", () => {
    const raw = Uint8Array.from([58, ...Array<number>(7934).fill(127), 0x6b]);
    const message = decode({ id: Message.history, payload: raw });
    expect(message.kind).toBe("history");
    if (message.kind !== "history") throw new Error("Expected history");
    expect(message.warnings).toHaveLength(1);
    expect(message.raw).toEqual([...raw]);
    expect(message.entries.at(-1)).toMatchObject({ name: "eof" });
    expect(() => decode({ id: Message.history, payload: Uint8Array.of(58, 0x6b) })).toThrow(
      /inconnue/,
    );
  });
  it("identifies the decreasing clock side from captured hardware status bytes", () => {
    const left = decode({
      id: Message.clock,
      payload: Uint8Array.of(1, 0x30, 0x30, 1, 0x30, 0x29, 0x11),
    });
    expect(left).toMatchObject({
      kind: "clock",
      clock: {
        activeSide: "left",
        leverHigh: "left",
        running: true,
        left: { seconds: 5429 },
        right: { seconds: 5430 },
      },
    });
    const right = decode({
      id: Message.clock,
      payload: Uint8Array.of(1, 0x30, 0x28, 1, 0x30, 0x29, 0x0b),
    });
    expect(right).toMatchObject({
      kind: "clock",
      clock: {
        activeSide: "right",
        leverHigh: "right",
        running: true,
        left: { seconds: 5429 },
        right: { seconds: 5428 },
      },
    });
  });
  it("decodes right-first BCD clocks, flags, side and disconnected status", () => {
    expect(
      decode({ id: Message.clock, payload: Uint8Array.of(0x71, 0x23, 0x45, 2, 0x34, 0x56, 0x1f) }),
    ).toEqual({
      kind: "clock",
      clock: {
        connected: true,
        running: true,
        activeSide: undefined,
        leverHigh: "right",
        batteryLow: true,
        right: { seconds: 5025, flagFallen: true, flagIndicated: true, perMove: true },
        left: { seconds: 9296, flagFallen: false, flagIndicated: false, perMove: false },
      },
    });
    expect(
      decode({ id: Message.clock, payload: Uint8Array.of(0, 0, 0, 0, 0, 0, 0x20) }),
    ).toMatchObject({ kind: "clock", clock: { connected: false } });
    expect(() =>
      decode({ id: Message.clock, payload: Uint8Array.of(0, 0x60, 0, 0, 0, 0, 1) }),
    ).toThrow(/invalide/);
  });
  it("does not mistake clock acknowledgements or empty Bluetooth messages for times", () => {
    expect(
      decode({ id: Message.clock, payload: Uint8Array.of(0x0a, 0x10, 9, 0, 0x12, 0, 0) }),
    ).toEqual({ kind: "clock-ack", ack: [0x10, 9, 0x12, 0] });
    expect(decode({ id: Message.clock, payload: new Uint8Array(7) })).toEqual({
      kind: "clock-empty",
    });
  });
  it("accepts documented battery layouts and keeps unavailable estimates unknown", () => {
    expect(decode({ id: Message.battery, payload: Uint8Array.of(85, 127, 127, 3) })).toMatchObject({
      kind: "battery",
      battery: { percent: 85, remainingHours: undefined, remainingMinutes: undefined, onHours: 3 },
    });
    expect(
      decode({ id: Message.battery, payload: Uint8Array.of(90, 2, 30, 5, 0, 1, 2, 3, 1) }),
    ).toMatchObject({
      kind: "battery",
      battery: { percent: 90, charging: true, discharging: false },
    });
    expect(() => decode({ id: Message.battery, payload: Uint8Array.of(101, 0, 0, 0) })).toThrow(
      /invalide/,
    );
  });
  it("decodes EEPROM tags, square changes, clock sides and special pieces", () => {
    expect(
      decodeHistory(Uint8Array.of(0x6a, 0x6f, 0x4e, 36, 0x71, 0x23, 0x45, 0x60, 0x10, 0x20, 0x6b)),
    ).toEqual([
      { kind: "tag", code: 0x6a, name: "powerup" },
      { kind: "tag", code: 0x6f, name: "initial" },
      { kind: "square", square: "e4", code: 14 },
      { kind: "clock", side: "left", seconds: 5025 },
      { kind: "clock", side: "right", seconds: 620 },
      { kind: "tag", code: 0x6b, name: "eof" },
    ]);
    expect(() => decodeHistory(Uint8Array.of(0x40))).toThrow(/tronqué/);
    expect(() => decodeHistory(Uint8Array.of(0x70, 0))).toThrow(/tronqué/);
    expect(() => decodeHistory(Uint8Array.of(0x6a))).toThrow(/fin/);
  });
});
describe("DGT client", () => {
  it("retries only within the queued request and keeps other requests serialized", async () => {
    const simulator = new ProtocolSimulator();
    const client = new DgtClient(simulator);
    await client.open();
    simulator.ignoredCommands.add(Command.battery);
    client.on("retry", () => simulator.ignoredCommands.delete(Command.battery));
    try {
      const battery = client.request(Command.battery, "battery", 5, 2);
      const position = client.readPosition();
      expect((await battery).kind).toBe("battery");
      expect((await position).kind).toBe("position");
      expect(simulator.commands).toEqual([Command.battery, Command.battery, Command.position]);
      expect(client.metrics).toMatchObject({ timeouts: 1, retries: 1 });
    } finally {
      await client.close();
    }
  });
  it("serializes requests while decoding unsolicited messages and recovering from timeouts", async () => {
    const simulator = new ProtocolSimulator();
    const client = new DgtClient(simulator);
    await client.open();
    const messages: string[] = [];
    client.on("message", (m) => messages.push(m.kind));
    const [position, battery] = await Promise.all([client.readPosition(), client.readBattery()]);
    expect(position.kind).toBe("position");
    expect(battery.kind).toBe("battery");
    simulator.emitFrame(Message.clock, [0x0a, 0x10, 1, 0, 0, 0, 0]);
    simulator.ignoredCommands.add(Command.clock);
    await expect(client.request(Command.clock, "clock", 5)).rejects.toBeInstanceOf(RequestTimeout);
    expect(messages).toContain("clock-ack");
    expect((await client.readPosition()).kind).toBe("position");
    expect(client.metrics.timeouts).toBe(1);
    await client.close();
  });
});
