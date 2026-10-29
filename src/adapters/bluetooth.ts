import { execFile } from "node:child_process";

export interface BluetoothBoard {
  address: string;
  name: string;
}

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

export const DGT_NAME = /^DGT_BT_[A-Za-z0-9_-]+$/;
const DEVICE_LINE = /^Device ((?:[0-9A-F]{2}:){5}[0-9A-F]{2}) (.+)$/i;

/** Parses `bluetoothctl devices` output and keeps only DGT boards. */
export function parseDgtDevices(output: string): BluetoothBoard[] {
  const boards = new Map<string, BluetoothBoard>();
  for (const line of output.split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line.trim());
    if (match && DGT_NAME.test(match[2].trim())) {
      boards.set(match[1].toUpperCase(), {
        address: match[1].toUpperCase(),
        name: match[2].trim(),
      });
    }
  }
  return [...boards.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const execRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

function describeError(error: unknown): Error {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return new Error("bluetoothctl est introuvable : installez BlueZ (paquet bluez).");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Scans for nearby devices, then lists the DGT_BT_* boards BlueZ has discovered. */
export async function discoverBluetoothBoards(
  options: { scanSeconds?: number; run?: CommandRunner } = {},
): Promise<BluetoothBoard[]> {
  const { scanSeconds = 8, run = execRunner } = options;
  const timeoutMs = (scanSeconds + 10) * 1000;
  try {
    await run("bluetoothctl", ["--timeout", String(scanSeconds), "scan", "on"], timeoutMs);
    return parseDgtDevices(await run("bluetoothctl", ["devices"], timeoutMs));
  } catch (error) {
    throw describeError(error);
  }
}
