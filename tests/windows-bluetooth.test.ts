import { expect, it } from "vitest";
import { listWindowsBoards, parseWindowsBoards } from "../src/adapters/windows-bluetooth.ts";

const OUTPUT = [
  "D\tBTHENUM\\DEV_000666B8269C\\7&6CDF9A2&0&BLUETOOTHDEVICE_000666B8269C\tDGT_BT_24301",
  "D\tBTHENUM\\DEV_E422A5BCEC28\\7&6CDF9A2&0&BLUETOOTHDEVICE_E422A5BCEC28\tPLT BB PRO 2",
  "P\tBTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&2B056E2C&0&000000000000_0000000C\tSerial link (COM3)",
  "P\tBTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0002\\7&2B056E2C&0&000666B8269C_C00000000\tSerial link (COM4)",
].join("\r\n");

it("matches DGT boards to their outgoing COM port", () => {
  expect(parseWindowsBoards(OUTPUT)).toEqual([
    { address: "00:06:66:B8:26:9C", name: "DGT_BT_24301", port: "COM4" },
  ]);
});

it("lists boards through PowerShell", async () => {
  const boards = await listWindowsBoards(async (command) => {
    expect(command).toBe("powershell.exe");
    return OUTPUT;
  });
  expect(boards[0].port).toBe("COM4");
});
