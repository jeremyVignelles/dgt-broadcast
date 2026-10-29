import { describe, expect, it } from "vitest";
import { ensureRfcommBindings, parseRfcommBindings, planBindings } from "../src/adapters/rfcomm.ts";
import type { CommandRunner } from "../src/adapters/bluetooth.ts";

const A = "00:06:66:FF:6C:C2";
const B = "68:27:19:F3:64:A1";
const C = "68:27:19:F3:64:A2";

describe("parseRfcommBindings", () => {
  it("reads device numbers and addresses from `rfcomm` output", () => {
    const output = [
      `rfcomm0: ${A} channel 1 clean `,
      `rfcomm3: ${B.toLowerCase()} channel 1 closed`,
      "garbage",
    ].join("\n");
    expect(parseRfcommBindings(output)).toEqual([
      { device: 0, address: A },
      { device: 3, address: B },
    ]);
  });
});

describe("planBindings", () => {
  it("reuses existing bindings and fills the lowest free numbers", () => {
    const plan = planBindings([A, B, C, A.toLowerCase()], [{ device: 1, address: B }]);
    expect(plan.bindings).toEqual([
      { device: 0, address: A },
      { device: 1, address: B },
      { device: 2, address: C },
    ]);
    expect(plan.missing).toEqual([
      { device: 0, address: A },
      { device: 2, address: C },
    ]);
  });

  it("rejects anything that is not a Bluetooth address", () => {
    expect(() => planBindings(["00:06;rm -rf"], [])).toThrow(/invalide/);
  });
});

describe("ensureRfcommBindings", () => {
  it("binds every missing board with a single pkexec call, without a shell string", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      return command === "rfcomm" ? `rfcomm0: ${B} channel 1 clean` : "";
    };
    const result = await ensureRfcommBindings([A, B, C], { run, script: "/opt/bind.sh" });
    expect(calls).toEqual([["rfcomm"], ["pkexec", "/bin/sh", "/opt/bind.sh", "1", A, "2", C]]);
    expect(result.created).toHaveLength(2);
  });

  it("does not prompt when everything is already bound", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (command) => {
      calls.push(command);
      return `rfcomm4: ${A} channel 1 clean`;
    };
    const result = await ensureRfcommBindings([A], { run });
    expect(calls).toEqual(["rfcomm"]);
    expect(result.bindings).toEqual([{ device: 4, address: A }]);
  });

  it("explains a dismissed password prompt", async () => {
    const run: CommandRunner = async (command) => {
      if (command === "pkexec") throw Object.assign(new Error("exit 126"), { code: 126 });
      return "";
    };
    await expect(ensureRfcommBindings([A], { run })).rejects.toThrow(/Élévation refusée/);
  });
});
