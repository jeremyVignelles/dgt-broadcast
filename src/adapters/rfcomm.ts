import { resolve } from "node:path";
import { execRunner } from "./bluetooth.ts";
import type { CommandRunner } from "./bluetooth.ts";

export interface RfcommBinding {
  device: number;
  address: string;
}

export const MAC_ADDRESS = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const MAX_DEVICE = 255;
const BINDING_LINE = /^rfcomm(\d+):\s+((?:[0-9A-F]{2}:){5}[0-9A-F]{2})\b/i;
/** Root-side helper; it re-validates its arguments before calling `rfcomm bind`. */
export const BIND_SCRIPT = resolve(import.meta.dirname, "../../scripts/rfcomm-bind.sh");

export function devicePath(device: number): string {
  return `/dev/rfcomm${device}`;
}

/** Parses the output of `rfcomm` (no arguments), which lists bindings without root. */
export function parseRfcommBindings(output: string): RfcommBinding[] {
  const bindings: RfcommBinding[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = BINDING_LINE.exec(line.trim());
    if (match) bindings.push({ device: Number(match[1]), address: match[2].toUpperCase() });
  }
  return bindings;
}

/** Reuses existing bindings and gives each remaining address the lowest free device number. */
export function planBindings(
  addresses: string[],
  existing: RfcommBinding[],
): { bindings: RfcommBinding[]; missing: RfcommBinding[] } {
  const used = new Set(existing.map((b) => b.device));
  const bindings: RfcommBinding[] = [];
  const missing: RfcommBinding[] = [];
  let next = 0;
  for (const raw of new Set(addresses.map((a) => a.toUpperCase()))) {
    if (!MAC_ADDRESS.test(raw)) throw new Error(`Adresse Bluetooth invalide : ${raw}`);
    const current = existing.find((b) => b.address === raw);
    if (current) {
      bindings.push(current);
      continue;
    }
    while (used.has(next)) next++;
    if (next > MAX_DEVICE) throw new Error("Plus aucun numéro /dev/rfcommN disponible.");
    used.add(next);
    const binding = { device: next, address: raw };
    bindings.push(binding);
    missing.push(binding);
  }
  return { bindings, missing };
}

function describeError(error: unknown): Error {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "ENOENT")
    return new Error("pkexec ou rfcomm est introuvable (paquets polkit/bluez).");
  // pkexec: 126 = authentication dismissed or refused, 127 = not authorized / failed.
  if (code === 126 || code === 127) {
    return new Error("Élévation refusée ou annulée : les échiquiers n'ont pas été liés.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Ensures every address has a /dev/rfcommN binding. Missing bindings are created with a single
 * `pkexec` call (one password prompt); bindings are kept until the machine reboots.
 */
export async function ensureRfcommBindings(
  addresses: string[],
  options: { run?: CommandRunner; script?: string } = {},
): Promise<{ bindings: RfcommBinding[]; created: RfcommBinding[] }> {
  const { run = execRunner, script = BIND_SCRIPT } = options;
  try {
    const plan = planBindings(addresses, parseRfcommBindings(await run("rfcomm", [], 5000)));
    if (plan.missing.length > 0) {
      const args = plan.missing.flatMap((b) => [String(b.device), b.address]);
      await run("pkexec", ["/bin/sh", script, ...args], 120_000);
    }
    return { bindings: plan.bindings, created: plan.missing };
  } catch (error) {
    throw describeError(error);
  }
}
