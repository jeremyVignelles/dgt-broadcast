import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordingStore, replayRecording } from "../src/dgt/recording.ts";
import { Message, encodeFrame } from "../src/dgt/protocol.ts";

describe("DGT recordings", () => {
  it("persists raw chunk boundaries, markers and independent replay for eight boards", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dgt-recording-"));
    try {
      const store = new RecordingStore(directory);
      const { id } = await store.start({ boards: 8 });
      expect(id).toBeDefined();
      store.mark("Début de capture");
      for (let table = 1; table <= 8; table++) {
        const bytes = encodeFrame(Message.square, [table, table]);
        store.bytes(table, "tx", Uint8Array.of(0x42));
        store.bytes(table, "rx", bytes.slice(0, 2));
        store.bytes(table, "rx", bytes.slice(2));
      }
      await store.stop();
      expect(await store.list()).toEqual([id]);
      const replay = await replayRecording(store.path(id!));
      expect(replay.errors).toEqual([]);
      expect(replay.messages).toHaveLength(8);
      expect(new Set(replay.messages.map((m) => m.tableId)).size).toBe(8);
      expect(await readFile(store.path(id!), "utf8")).toContain("Début de capture");
      expect(() => store.mark("Après")).toThrow(/Aucun/);
      expect(() => store.path("../secret")).toThrow(/invalide/);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
