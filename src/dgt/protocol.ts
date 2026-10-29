export type Result = "1-0" | "0-1" | "1/2-1/2";
export type ClockSide = "left" | "right";
export interface Piece {
  role: "pawn" | "rook" | "knight" | "bishop" | "king" | "queen";
  color: "white" | "black";
}
export type Position = Map<string, Piece | null>;

export const Command = {
  idle: 0x40,
  clock: 0x41,
  position: 0x42,
  updates: 0x43,
  boardUpdates: 0x44,
  serial: 0x45,
  history: 0x49,
  niceUpdates: 0x4b,
  battery: 0x4c,
  version: 0x4d,
  longSerial: 0x55,
} as const;
export const Message = {
  position: 0x86,
  clock: 0x8d,
  square: 0x8e,
  history: 0x8f,
  serial: 0x91,
  version: 0x93,
  battery: 0xa0,
  longSerial: 0xa2,
} as const;

const PIECES: ReadonlyArray<Piece | null> = [
  null,
  { role: "pawn", color: "white" },
  { role: "rook", color: "white" },
  { role: "knight", color: "white" },
  { role: "bishop", color: "white" },
  { role: "king", color: "white" },
  { role: "queen", color: "white" },
  { role: "pawn", color: "black" },
  { role: "rook", color: "black" },
  { role: "knight", color: "black" },
  { role: "bishop", color: "black" },
  { role: "king", color: "black" },
  { role: "queen", color: "black" },
];
export const RESULTS: Readonly<Record<number, Result>> = {
  13: "1/2-1/2",
  14: "1-0",
  15: "0-1",
};

export function squareName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 63)
    throw new Error(`Case DGT invalide : ${index}`);
  return `${String.fromCharCode(97 + (index % 8))}${8 - Math.floor(index / 8)}`;
}
export function squareIndex(square: string): number {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error("Case DGT invalide");
  return (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
}
export function piece(code: number): Piece | null {
  if (!Number.isInteger(code) || code < 0 || code > 15)
    throw new Error(`Pièce DGT invalide : ${code}`);
  return PIECES[code] ?? null;
}

export interface Frame {
  id: number;
  payload: Uint8Array;
}
export function encodeFrame(id: number, payload: readonly number[] | Uint8Array): Uint8Array {
  const size = payload.length + 3;
  if (id < 0x80 || id > 0xff || size > 0x3fff || payload.some((v) => v < 0 || v > 0x7f))
    throw new Error("Trame DGT invalide");
  return Uint8Array.from([id, size >> 7, size & 0x7f, ...payload]);
}

/** Serial reads are chunks, not messages. Resynchronize at the next message bit. */
export class FrameParser {
  private pending = new Uint8Array();

  finish(): void {
    if (this.pending.length)
      throw new Error(`Trame DGT tronquée (${this.pending.length} octets restants)`);
  }

  push(chunk: Uint8Array): { frames: Frame[]; errors: string[] } {
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.length);
    const frames: Frame[] = [];
    const errors: string[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (!(bytes[offset] & 0x80)) {
        errors.push(`Octet hors trame DGT : ${bytes[offset]}`);
        offset++;
        continue;
      }
      if (bytes.length - offset < 3) break;
      if ((bytes[offset + 1] | bytes[offset + 2]) & 0x80) {
        errors.push("En-tête DGT invalide");
        offset++;
        continue;
      }
      const length = (bytes[offset + 1] << 7) | bytes[offset + 2];
      if (length < 3) {
        errors.push("Longueur DGT invalide");
        offset++;
        continue;
      }
      const end = Math.min(offset + length, bytes.length);
      let nextHeader = offset + 3;
      while (nextHeader < end && !(bytes[nextHeader] & 0x80)) nextHeader++;
      if (nextHeader < end) {
        errors.push("Trame DGT interrompue");
        offset = nextHeader;
        continue;
      }
      if (bytes.length - offset < length) break;
      frames.push({ id: bytes[offset], payload: bytes.slice(offset + 3, offset + length) });
      offset += length;
    }
    this.pending = bytes.slice(offset);
    return { frames, errors };
  }
}

export interface ClockReading {
  connected: boolean;
  running: boolean;
  activeSide?: ClockSide;
  leverHigh: ClockSide;
  batteryLow: boolean;
  left: ClockTime;
  right: ClockTime;
}
export interface ClockTime {
  seconds: number;
  flagFallen: boolean;
  flagIndicated: boolean;
  perMove: boolean;
}
export interface BatteryReading {
  percent: number;
  remainingHours?: number;
  remainingMinutes?: number;
  onHours: number;
  onMinutes?: number;
  standbyDays?: number;
  standbyHours?: number;
  standbyMinutes?: number;
  charging?: boolean;
  discharging?: boolean;
}
export type HistoryEntry =
  | { kind: "square"; square: string; code: number }
  | { kind: "clock"; side: ClockSide; seconds: number }
  | { kind: "tag"; code: number; name: string };
export type DecodedMessage =
  | { kind: "position"; codes: number[] }
  | { kind: "square"; square: string; index: number; code: number }
  | { kind: "clock"; clock: ClockReading }
  | { kind: "clock-ack"; ack: number[] }
  | { kind: "clock-empty" }
  | { kind: "battery"; battery: BatteryReading }
  | { kind: "history"; entries: HistoryEntry[]; warnings: string[]; raw: number[] }
  | { kind: "serial"; serial: string }
  | { kind: "version"; version: string }
  | { kind: "unknown"; id: number; payload: number[] };

function bcd(value: number, max: number): number {
  const number = (value >> 4) * 10 + (value & 15);
  if ((value & 15) > 9 || number > max) throw new Error(`Temps DGT invalide : ${value}`);
  return number;
}
function clockTime(hours: number, minutes: number, seconds: number): ClockTime {
  return {
    seconds: bcd(hours & 15, 9) * 3600 + bcd(minutes, 59) * 60 + bcd(seconds, 59),
    flagFallen: Boolean(hours & 0x10),
    flagIndicated: Boolean(hours & 0x40),
    perMove: Boolean(hours & 0x20),
  };
}
const TAGS: Readonly<Record<number, string>> = {
  0: "nop",
  0x6a: "powerup",
  0x6b: "eof",
  0x6c: "four-rows",
  0x6d: "empty-board",
  0x6e: "downloaded",
  0x6f: "initial",
  0x7a: "initial-rotated",
  0x7b: "start",
  0x7c: "watchdog",
  0x7d: "reserved-1",
  0x7e: "reserved-2",
  0x7f: "nop",
};
export function decodeHistory(data: Uint8Array): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let i = 0; i < data.length;) {
    const first = data[i++];
    if (Object.hasOwn(TAGS, first)) {
      entries.push({ kind: "tag", code: first, name: TAGS[first] });
      if (first === 0x6b) {
        if (i !== data.length) throw new Error("Données après la fin de l'historique DGT");
        return entries;
      }
    } else if (first >= 0x40 && first <= 0x5f) {
      if (i >= data.length) throw new Error("Historique DGT tronqué (case)");
      const code = first & 15;
      entries.push({ kind: "square", square: squareName(data[i++]), code });
    } else if ((first >= 0x60 && first <= 0x69) || (first >= 0x70 && first <= 0x79)) {
      if (i + 1 >= data.length) throw new Error("Historique DGT tronqué (pendule)");
      const seconds = (first & 15) * 3600 + bcd(data[i++], 59) * 60 + bcd(data[i++], 59);
      entries.push({ kind: "clock", side: first & 0x10 ? "left" : "right", seconds });
    } else throw new Error(`Entrée d'historique DGT inconnue : ${first}`);
  }
  throw new Error("Historique DGT sans marqueur de fin");
}

export function decode(frame: Frame): DecodedMessage {
  const p = frame.payload;
  const size = (n: number) => {
    if (p.length !== n) throw new Error(`Longueur invalide pour le message DGT ${frame.id}`);
  };
  switch (frame.id) {
    case Message.position:
      size(64);
      for (const code of p) piece(code);
      return { kind: "position", codes: [...p] };
    case Message.square:
      size(2);
      piece(p[1]);
      return { kind: "square", square: squareName(p[0]), index: p[0], code: p[1] };
    case Message.clock: {
      size(7);
      if ((p[0] & 15) === 10 || (p[3] & 15) === 10)
        return {
          kind: "clock-ack",
          ack: [
            (p[1] & 0x7f) | ((p[3] << 3) & 0x80),
            (p[2] & 0x7f) | ((p[3] << 2) & 0x80),
            (p[4] & 0x7f) | ((p[0] << 3) & 0x80),
            (p[5] & 0x7f) | ((p[0] << 2) & 0x80),
          ],
        };
      if (p.every((v) => v === 0)) return { kind: "clock-empty" };
      const status = p[6];
      return {
        kind: "clock",
        clock: {
          connected: !(status & 0x20),
          running: Boolean(status & 1),
          activeSide: (status & 0x18) === 8 ? "right" : (status & 0x18) === 16 ? "left" : undefined,
          leverHigh: status & 2 ? "right" : "left",
          batteryLow: Boolean(status & 4),
          right: clockTime(p[0], p[1], p[2]),
          left: clockTime(p[3], p[4], p[5]),
        },
      };
    }
    case Message.battery: {
      // The 2012 header specifies 7 bytes but also describes a 12-byte variant.
      if ((p.length !== 4 && p.length !== 9) || p[0] > 100)
        throw new Error("Réponse batterie DGT invalide");
      return {
        kind: "battery",
        battery: {
          percent: p[0],
          remainingHours: p[1] === 127 ? undefined : p[1],
          remainingMinutes: p[2] === 127 ? undefined : p[2],
          onHours: p[3],
          ...(p.length === 9
            ? {
                onMinutes: p[4],
                standbyDays: p[5],
                standbyHours: p[6],
                standbyMinutes: p[7],
                charging: Boolean(p[8] & 1),
                discharging: Boolean(p[8] & 2),
              }
            : {}),
        },
      };
    }
    case Message.serial:
    case Message.longSerial:
      size(frame.id === Message.serial ? 5 : 10);
      return { kind: "serial", serial: String.fromCharCode(...p) };
    case Message.version:
      size(2);
      return { kind: "version", version: `${p[0]}.${p[1]}` };
    case Message.history: {
      // The cyclic EEPROM can begin with the square byte of an overwritten entry.
      const partialStart = p.length === 0x1f00 && p[0] > 0 && p[0] < 0x40;
      return {
        kind: "history",
        entries: decodeHistory(partialStart ? p.slice(1) : p),
        warnings: partialStart
          ? [
              "Mémoire circulaire pleine : premier octet orphelin ignoré ; début d'historique incomplet.",
            ]
          : [],
        raw: [...p],
      };
    }
    default:
      return { kind: "unknown", id: frame.id, payload: [...p] };
  }
}
