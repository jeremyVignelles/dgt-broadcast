import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import type { WriteStream } from "node:fs";
import { FrameParser, decode } from "./protocol.ts";

export const CAPTURE_STEPS = [
  "Ne manipulez rien. Télécharger d'abord l'historique interne avec le bouton dédié.",
  "Installer la position initiale, pendule arrêtée ; attendre deux secondes.",
  "Démarrer le temps des blancs, attendre, puis jouer e2-e4 et basculer la pendule.",
  "Jouer e7-e5 et basculer la pendule. Mettre ensuite la pendule en pause, puis reprendre.",
  "Effectuer une capture ; retirer la victime avant de déplacer la pièce, puis essayer dans l'autre ordre.",
  "Préparer un roque, l'effectuer en déplaçant roi puis tour ; refaire avec tour puis roi.",
  "Préparer et effectuer une promotion, puis une prise en passant.",
  "Soulever une pièce, la reposer sur sa case ; déplacer lentement une pièce au-dessus de plusieurs cases.",
  "Si disponibles, poser puis retirer chacune des trois pièces spéciales de résultat.",
  "Débrancher puis rebrancher la pendule, sans changer ses réglages.",
  "Éteindre puis rallumer un plateau ; reconnecter depuis l'administration.",
  "Stabilité : connecter tous les plateaux, les laisser fonctionner et jouer quelques coups sur chacun.",
] as const;

export interface RecordingRow {
  type: "metadata" | "bytes" | "marker" | "diagnostics" | "fault" | "connection" | "end";
  atMs: number;
  tableId?: number;
  direction?: "rx" | "tx";
  hex?: string;
  data?: unknown;
}
const VALID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RecordingStore {
  private readonly directory: string;
  private stream?: WriteStream;
  private started = 0;
  private id?: string;
  private error?: string;
  private rows = 0;
  private stopping = false;
  private starting = false;
  constructor(directory: string) {
    this.directory = directory;
  }

  status() {
    return {
      id: this.id,
      open: Boolean(this.stream) || this.starting,
      active: Boolean(this.stream) && !this.error && !this.stopping,
      rows: this.rows,
      error: this.error,
    };
  }
  path(id: string): string {
    if (!VALID_ID.test(id)) throw new Error("Identifiant d'enregistrement invalide");
    return join(this.directory, `${id}.jsonl`);
  }
  async list(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    return (await readdir(this.directory))
      .filter((name) => name.endsWith(".jsonl") && VALID_ID.test(name.slice(0, -6)))
      .map((name) => name.slice(0, -6));
  }
  async start(metadata: unknown): Promise<ReturnType<RecordingStore["status"]>> {
    if (this.stream || this.starting)
      throw new Error("Un enregistrement est déjà ouvert ; arrêtez-le d'abord");
    this.starting = true;
    try {
      await mkdir(this.directory, { recursive: true });
      this.id = randomUUID();
      this.started = performance.now();
      this.rows = 0;
      this.error = undefined;
      const stream = createWriteStream(this.path(this.id), { flags: "wx" });
      this.stream = stream;
      stream.on("error", (error) => {
        this.error = error.message;
      });
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => {
          stream.removeListener("error", reject);
          resolve();
        });
        stream.once("error", reject);
      }).catch((error: unknown) => {
        this.stream = undefined;
        throw error;
      });
      this.append({
        type: "metadata",
        data: { schema: 1, startedAt: new Date().toISOString(), boards: metadata },
      });
      return this.status();
    } finally {
      this.starting = false;
    }
  }
  append(row: Omit<RecordingRow, "atMs">): void {
    const stream = this.stream;
    if (!stream || this.error || this.stopping) return;
    if (stream.writableLength > 4 * 1024 * 1024) {
      this.error = "Enregistrement arrêté : stockage trop lent (tampon supérieur à 4 Mio)";
      stream.destroy(new Error(this.error));
      return;
    }
    const data: RecordingRow = {
      ...row,
      atMs: Math.round((performance.now() - this.started) * 1000) / 1000,
    };
    stream.write(`${JSON.stringify(data)}\n`);
    this.rows++;
  }
  bytes(tableId: number, direction: "rx" | "tx", bytes: Uint8Array): void {
    this.append({ type: "bytes", tableId, direction, hex: Buffer.from(bytes).toString("hex") });
  }
  mark(label: string): void {
    if (!this.status().active) throw new Error(this.error ?? "Aucun enregistrement actif");
    if (typeof label !== "string" || !label.trim() || label.length > 500)
      throw new Error("Marqueur requis (500 caractères maximum)");
    this.append({ type: "marker", data: label });
  }
  async stop() {
    const stream = this.stream;
    if (!stream) throw new Error("Aucun enregistrement ouvert");
    if (this.stopping) throw new Error("Arrêt de l'enregistrement déjà en cours");
    this.append({ type: "end" });
    this.stopping = true;
    try {
      stream.end();
      await finished(stream);
      if (this.error) throw new Error(this.error);
    } finally {
      this.stream = undefined;
      this.stopping = false;
    }
    return this.status();
  }
}

/** Deterministic replay of received chunks, preserving separate decoders per board. */
export async function replayRecording(path: string) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const parsers = new Map<number, FrameParser>();
  const messages: Array<{ tableId: number; atMs: number; message: ReturnType<typeof decode> }> = [];
  const errors: string[] = [];
  let metadata = false;
  let ended = false;
  let index = 0;
  for await (const line of lines) {
    index++;
    if (!line.trim()) continue;
    const row: RecordingRow = JSON.parse(line);
    if (!Number.isFinite(row.atMs) || row.atMs < 0)
      throw new Error(`Temps invalide à la ligne ${index}`);
    if (row.type === "metadata") metadata = true;
    if (row.type === "end") ended = true;
    if (row.type === "connection" && row.tableId !== undefined) {
      try {
        parsers.get(row.tableId)?.finish();
      } catch (error) {
        errors.push(`Table ${row.tableId} : ${String(error)}`);
      }
      parsers.delete(row.tableId);
      continue;
    }
    if (row.type !== "bytes" || row.direction !== "rx") continue;
    if (
      !Number.isInteger(row.tableId) ||
      row.tableId! < 1 ||
      row.tableId! > 32 ||
      !row.hex ||
      !/^(?:[0-9a-f]{2})+$/i.test(row.hex)
    )
      throw new Error(`Capture invalide à la ligne ${index}`);
    const tableId = row.tableId!;
    let parser = parsers.get(tableId);
    if (!parser) {
      parser = new FrameParser();
      parsers.set(tableId, parser);
    }
    const parsed = parser.push(Buffer.from(row.hex, "hex"));
    errors.push(...parsed.errors.map((error) => `Table ${tableId} : ${error}`));
    for (const frame of parsed.frames) {
      try {
        messages.push({ tableId, atMs: row.atMs, message: decode(frame) });
      } catch (error) {
        errors.push(`Table ${tableId} : ${String(error)}`);
      }
    }
  }
  if (!metadata) throw new Error("Métadonnées d'enregistrement absentes");
  if (!ended) errors.push("Session incomplète : marqueur de fin absent");
  for (const [tableId, parser] of parsers) {
    try {
      parser.finish();
    } catch (error) {
      errors.push(`Table ${tableId} : ${String(error)}`);
    }
  }
  return { messages, errors };
}
