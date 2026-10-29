import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppState } from "../domain/types.ts";
export class JsonStore<T> {
  private readonly file: string;
  private readonly fallback: T;
  constructor(file: string, fallback: T) {
    this.file = file;
    this.fallback = fallback;
  }
  async load(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as T;
    } catch {
      return this.fallback;
    }
  }
  async save(value: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, this.file);
  }
}
export type Persisted = Pick<AppState, "tables" | "meeting"> & {
  /** Bluetooth address of each DGT board name, remembered from scans to bind after a restart. */
  addresses?: Record<string, string>;
};
