import { describe, expect, it } from "vitest";
import { discoverBluetoothBoards, parseDgtDevices } from "../src/adapters/bluetooth.ts";
import type { CommandRunner } from "../src/adapters/bluetooth.ts";

const DEVICES = [
  "Device EC:04:19:5F:2E:EB SumUp 002",
  "Device 68:27:19:F3:64:A1 DGT_BT_24902",
  "Device 00:06:66:FF:6C:C2 DGT_BT_23699",
  "Device 48:16:61:AA:8F:69 48-16-61-AA-8F-69",
  "Device 00:06:66:FF:6C:C2 DGT_BT_23699",
  "not a device line",
].join("\n");

describe("parseDgtDevices", () => {
  it("keeps only DGT_BT_* boards, deduplicated and sorted by name", () => {
    expect(parseDgtDevices(DEVICES)).toEqual([
      { address: "00:06:66:FF:6C:C2", name: "DGT_BT_23699" },
      { address: "68:27:19:F3:64:A1", name: "DGT_BT_24902" },
    ]);
  });

  it("ignores names that merely contain DGT_BT_", () => {
    expect(parseDgtDevices("Device 00:06:66:FF:6C:C2 My DGT_BT_1 clone")).toEqual([]);
  });
});

describe("discoverBluetoothBoards", () => {
  it("scans first, then lists devices, without going through a shell", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return args[0] === "devices" ? DEVICES : "";
    };
    const boards = await discoverBluetoothBoards({ scanSeconds: 3, run });
    expect(calls).toEqual([
      ["bluetoothctl", "--timeout", "3", "scan", "on"],
      ["bluetoothctl", "devices"],
    ]);
    expect(boards.map((b) => b.name)).toEqual(["DGT_BT_23699", "DGT_BT_24902"]);
  });

  it("explains how to fix a missing bluetoothctl", async () => {
    const run: CommandRunner = async () => {
      throw Object.assign(new Error("spawn bluetoothctl ENOENT"), { code: "ENOENT" });
    };
    await expect(discoverBluetoothBoards({ run })).rejects.toThrow(/bluez/);
  });
});
