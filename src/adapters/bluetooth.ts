import { execFile, spawn } from "node:child_process";

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

/** Minimal view of an interactive process, injectable for tests. */
export interface InteractiveProcess {
  write(line: string): void;
  onOutput(listener: (text: string) => void): void;
  onExit(listener: (error?: Error) => void): void;
  kill(): void;
}
export type InteractiveSpawner = (command: string, args: string[]) => InteractiveProcess;

export const spawnInteractive: InteractiveSpawner = (command, args) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  return {
    write: (line) => child.stdin.write(`${line}\n`),
    onOutput: (listener) => {
      child.stdout.on("data", (data: Buffer) => listener(data.toString("utf8")));
      child.stderr.on("data", (data: Buffer) => listener(data.toString("utf8")));
    },
    onExit: (listener) => {
      child.on("error", (error) => listener(describeError(error)));
      child.on("exit", () => listener());
    },
    kill: () => child.kill(),
  };
};

// Strips the ANSI colours and readline markers that bluetoothctl prints.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|[\x01\x02]/g;

/** True when `bluetoothctl info` reports the device as paired. */
export function isPaired(info: string): boolean {
  return /^\s*Paired: yes$/m.test(info);
}

export async function isBoardPaired(address: string, run: CommandRunner = execRunner) {
  return isPaired(await run("bluetoothctl", ["info", address], 10_000));
}

/**
 * Pairs and trusts a board through an interactive `bluetoothctl` session. DGT boards have no
 * screen, so the passkey confirmation is accepted automatically ("Just Works" pairing).
 */
export function pairBoard(
  address: string,
  options: { spawn?: InteractiveSpawner; timeoutMs?: number } = {},
): Promise<void> {
  const { spawn: start = spawnInteractive, timeoutMs = 45_000 } = options;
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(address)) {
    return Promise.reject(new Error(`Adresse Bluetooth invalide : ${address}`));
  }
  return new Promise((resolve, reject) => {
    const session = start("bluetoothctl", []);
    let pending = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.write("quit");
      setTimeout(() => session.kill(), 500).unref();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`Appairage de ${address} trop long : échiquier allumé et proche ?`)),
      timeoutMs,
    );
    // Each step fires at most once: bluetoothctl echoes some messages twice.
    const steps: [RegExp, (match: RegExpExecArray) => void][] = [
      [/Agent (?:is already )?registered/, () => session.write("default-agent")],
      [/Default agent request successful/, () => session.write(`pair ${address}`)],
      [/Confirm passkey \d+|Authorize service|Request confirmation/, () => session.write("yes")],
      [/Pairing successful|Error\.AlreadyExists/, () => session.write(`trust ${address}`)],
      [/trust succeeded/, () => finish()],
      [
        /Failed to pair: (?!org\.bluez\.Error\.AlreadyExists)\S+|Device \S+ not available/,
        (match) => finish(new Error(`Appairage de ${address} refusé : ${match[0]}`)),
      ],
    ];
    const done = new Set<RegExp>();
    session.onOutput((chunk) => {
      pending += chunk.replace(ANSI, "");
      for (const [pattern, action] of steps) {
        if (settled) return;
        const match = done.has(pattern) ? null : pattern.exec(pending);
        if (match) {
          done.add(pattern);
          pending = pending.slice(match.index + match[0].length);
          action(match);
        }
      }
    });
    session.onExit((error) =>
      finish(error ?? new Error(`bluetoothctl s'est arrêté pendant l'appairage de ${address}`)),
    );
    session.write("agent KeyboardDisplay");
  });
}
