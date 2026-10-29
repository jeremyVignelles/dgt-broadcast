import { describe, expect, it } from "vitest";
import { isPaired, pairBoard } from "../src/adapters/bluetooth.ts";
import type { InteractiveProcess } from "../src/adapters/bluetooth.ts";
import { connectBoards } from "../src/adapters/connect.ts";
import type { ConnectDeps } from "../src/adapters/connect.ts";

const ADDRESS = "68:27:19:F3:61:50";

/** Fake `bluetoothctl` replying to each command with the given output. */
function fakeBluetoothctl(replies: Record<string, string>) {
  const written: string[] = [];
  let output: (text: string) => void = () => {};
  const process: InteractiveProcess = {
    write(line) {
      written.push(line);
      const reply = replies[line.split(" ")[0]];
      if (reply) queueMicrotask(() => output(reply));
    },
    onOutput: (listener) => (output = listener),
    onExit: () => {},
    kill: () => {},
  };
  return { written, spawn: () => process };
}

describe("isPaired", () => {
  it("reads the Paired flag of `bluetoothctl info`", () => {
    expect(isPaired("\tName: DGT_BT_1\n\tPaired: yes\n")).toBe(true);
    expect(isPaired("\tPaired: no\n\tBonded: no\n")).toBe(false);
  });
});

describe("pairBoard", () => {
  it("registers an agent, pairs, confirms the passkey and trusts the board", async () => {
    const fake = fakeBluetoothctl({
      // bluetoothctl echoes some lines twice; each step must still run only once.
      agent: "Agent registered\nagent KeyboardDisplay\nAgent is already registered\n",
      "default-agent": "\x1b[0;94mDefault agent request successful\x1b[0m\n".repeat(2),
      pair: "Attempting to pair\n[agent] Confirm passkey 194435 (yes/no): ",
      yes: "[CHG] Device Bonded: yes\nPairing successful\n",
      trust: `Changing ${ADDRESS} trust succeeded\n`,
    });
    await pairBoard(ADDRESS, { spawn: fake.spawn });
    expect(fake.written).toEqual([
      "agent KeyboardDisplay",
      "default-agent",
      `pair ${ADDRESS}`,
      "yes",
      `trust ${ADDRESS}`,
      "quit",
    ]);
  });

  it("reports a refused pairing", async () => {
    const fake = fakeBluetoothctl({
      agent: "Agent registered\n",
      "default-agent": "Default agent request successful\n",
      pair: "Failed to pair: org.bluez.Error.AuthenticationFailed\n",
    });
    await expect(pairBoard(ADDRESS, { spawn: fake.spawn })).rejects.toThrow(/AuthenticationFailed/);
  });

  it("rejects invalid addresses before starting bluetoothctl", async () => {
    await expect(pairBoard("x; reboot")).rejects.toThrow(/invalide/);
  });
});

describe("connectBoards", () => {
  const boards = [
    { tableId: 1, name: "DGT_BT_1", address: "00:06:66:FF:6C:C2" },
    { tableId: 2, name: "DGT_BT_2", address: ADDRESS },
  ];

  it("scans and pairs only unpaired boards, then binds everything at once", async () => {
    const calls: string[] = [];
    const deps: ConnectDeps = {
      isPaired: async (address) => address !== ADDRESS,
      scan: async () => calls.push("scan"),
      pair: async (address) => void calls.push(`pair ${address}`),
      bind: async (addresses) => {
        calls.push(`bind ${addresses.join(" ")}`);
        return {
          bindings: addresses.map((address, device) => ({ device, address })),
          created: [],
        };
      },
    };
    const result = await connectBoards(boards, deps);
    expect(calls).toEqual(["scan", `pair ${ADDRESS}`, `bind 00:06:66:FF:6C:C2 ${ADDRESS}`]);
    expect(result.boards.map((b) => [b.device, b.paired])).toEqual([
      ["/dev/rfcomm0", true],
      ["/dev/rfcomm1", true],
    ]);
    expect(result.errors).toEqual([]);
  });

  it("keeps going when a board refuses pairing", async () => {
    const deps: ConnectDeps = {
      isPaired: async () => false,
      scan: async () => undefined,
      pair: async (address) => {
        if (address === ADDRESS) throw new Error("refusé");
      },
      bind: async (addresses) => ({
        bindings: addresses.map((address, device) => ({ device, address })),
        created: [],
      }),
    };
    const result = await connectBoards(boards, deps);
    expect(result.boards.map((b) => b.paired)).toEqual([true, false]);
    expect(result.errors).toEqual(["DGT_BT_2 : refusé"]);
  });
});
