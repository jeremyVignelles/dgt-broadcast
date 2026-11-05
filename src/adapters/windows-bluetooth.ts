import { execRunner } from "./bluetooth.ts";
import type { BluetoothBoard, CommandRunner } from "./bluetooth.ts";
import type { ConnectDeps } from "./connect.ts";
import { DGT_NAME } from "./bluetooth.ts";

export interface WindowsBoard extends BluetoothBoard {
  /** Outgoing Bluetooth COM port, absent when Windows has not created one. */
  port?: string;
}

// One line per device: "D<TAB>InstanceId<TAB>FriendlyName" for paired devices, "P<TAB>InstanceId<TAB>FriendlyName" for COM ports.
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-PnpDevice -Class Bluetooth -PresentOnly | Where-Object { $_.InstanceId -like 'BTHENUM\\DEV_*' } | ForEach-Object { "D\`t$($_.InstanceId)\`t$($_.FriendlyName)" }
Get-PnpDevice -Class Ports -PresentOnly | Where-Object { $_.InstanceId -like 'BTHENUM\\*' } | ForEach-Object { "P\`t$($_.InstanceId)\`t$($_.FriendlyName)" }
`;

function formatAddress(hex: string): string {
  return hex.toUpperCase().match(/../g)!.join(":");
}

/**
 * Parses the script output. Outgoing COM ports are matched to boards through the Bluetooth address
 * embedded in their instance id; the incoming port carries an all-zero address and is ignored.
 */
export function parseWindowsBoards(output: string): WindowsBoard[] {
  const boards = new Map<string, WindowsBoard>();
  const ports = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [kind, instanceId = "", name = ""] = line.trim().split("\t");
    if (kind === "D") {
      const address = /DEV_([0-9A-F]{12})/i.exec(instanceId)?.[1];
      if (address && DGT_NAME.test(name.trim())) {
        const formatted = formatAddress(address);
        boards.set(formatted, { address: formatted, name: name.trim() });
      }
    } else if (kind === "P") {
      const address = /&([0-9A-F]{12})_[0-9A-F]+$/i.exec(instanceId)?.[1];
      const port = /\((COM\d+)\)/i.exec(name)?.[1];
      if (address && port && !/^0+$/.test(address)) ports.set(formatAddress(address), port);
    }
  }
  for (const board of boards.values()) board.port = ports.get(board.address)?.toUpperCase();
  return [...boards.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listWindowsBoards(run: CommandRunner = execRunner): Promise<WindowsBoard[]> {
  const output = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
    20_000,
  );
  return parseWindowsBoards(output);
}

/**
 * Windows pairs boards in its own settings and exposes them as COM ports, so "connecting"
 * only resolves each address to its COM port instead of pairing and binding.
 */
export function windowsConnectDeps(list: () => Promise<WindowsBoard[]> = listWindowsBoards) {
  let cache: Promise<WindowsBoard[]> | undefined;
  const boards = () => (cache ??= list());
  const deps: ConnectDeps = {
    isPaired: async (address) => (await boards()).some((b) => b.address === address.toUpperCase()),
    devicePath: (device) => `COM${device}`,
    scan: async () => undefined,
    pair: async () => {
      throw new Error(
        "Échiquier non appairé : ajoutez-le dans Paramètres Windows > Bluetooth et appareils.",
      );
    },
    bind: async (addresses) => {
      const found = await boards();
      const bindings = addresses.flatMap((address) => {
        const port = found.find((b) => b.address === address.toUpperCase())?.port;
        const device = port ? Number(port.slice(3)) : undefined;
        return device === undefined ? [] : [{ device, address: address.toUpperCase() }];
      });
      return { bindings, created: [] };
    },
  };
  return deps;
}
