import { discoverBluetoothBoards, isBoardPaired, pairBoard } from "./bluetooth.ts";
import { devicePath, ensureRfcommBindings } from "./rfcomm.ts";
import type { RfcommBinding } from "./rfcomm.ts";

export interface BoardToConnect {
  tableId: number;
  name: string;
  address: string;
}
export interface ConnectedBoard extends BoardToConnect {
  device: string;
  paired: boolean;
}
export interface ConnectDeps {
  isPaired: (address: string) => Promise<boolean>;
  scan: () => Promise<unknown>;
  pair: (address: string) => Promise<void>;
  bind: (addresses: string[]) => Promise<{ bindings: RfcommBinding[]; created: RfcommBinding[] }>;
  devicePath?: (device: number) => string;
}

const defaultDeps: ConnectDeps = {
  isPaired: (address) => isBoardPaired(address),
  scan: () => discoverBluetoothBoards(),
  pair: (address) => pairBoard(address),
  bind: (addresses) => ensureRfcommBindings(addresses),
};

/**
 * Pairs the boards that are not paired yet (one at a time, after a scan so BlueZ sees them),
 * then creates every missing /dev/rfcommN binding with a single elevation prompt.
 */
export async function connectBoards(boards: BoardToConnect[], deps: ConnectDeps = defaultDeps) {
  const errors: string[] = [];
  const paired = new Map<string, boolean>();
  for (const board of boards) {
    paired.set(board.address, await deps.isPaired(board.address).catch(() => false));
  }
  if (boards.some((b) => !paired.get(b.address))) {
    await deps.scan().catch(() => undefined);
    for (const board of boards) {
      if (paired.get(board.address)) continue;
      try {
        await deps.pair(board.address);
        paired.set(board.address, true);
      } catch (error) {
        errors.push(`${board.name} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const { bindings, created } =
    boards.length > 0
      ? await deps.bind(boards.map((b) => b.address))
      : { bindings: [], created: [] };
  const connected: ConnectedBoard[] = boards.map((board) => {
    const binding = bindings.find((b) => b.address === board.address.toUpperCase());
    return {
      ...board,
      device: binding ? (deps.devicePath ?? devicePath)(binding.device) : "",
      paired: paired.get(board.address) ?? false,
    };
  });
  return { boards: connected, created: created.length, errors };
}
