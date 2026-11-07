import { describe, expect, it } from "vitest";
import { BroadcastCore } from "../src/domain/core.ts";
describe("BroadcastCore", () => {
  it("limits tables and enrolls only with E4 confirmation", () => {
    const core = new BroadcastCore(2);
    expect(() => new BroadcastCore(33)).toThrow();
    expect(() => core.enroll(1, "DGT_BT_A", false)).toThrow();
    expect(core.enroll(1, "DGT_BT_A").physicalId).toBe("DGT_BT_A");
  });
  it("moves a board to another table instead of duplicating its association", () => {
    const core = new BroadcastCore(2);
    core.manualAssociate(1, "DGT_BT_A");
    core.manualAssociate(2, "DGT_BT_A");
    expect(core.getTable(1).physicalId).toBeUndefined();
    expect(core.getTable(1).game.status).toBe("disconnected");
    expect(core.getTable(2).physicalId).toBe("DGT_BT_A");
  });
  it("dissociates a table", () => {
    const core = new BroadcastCore(1);
    core.manualAssociate(1, "DGT_BT_A");
    expect(core.dissociate(1).physicalId).toBeUndefined();
  });
  it("sorts imported players by elo", () => {
    const core = new BroadcastCore(1);
    core.addPlayers([
      { name: "Low", elo: 1000 },
      { name: "High", elo: 2000 },
    ]);
    expect(core.state.meeting?.players[0].name).toBe("High");
  });
  it("adds, labels and removes boards without depending on array indexes", () => {
    const core = new BroadcastCore(0);
    const first = core.addTable("virtual", " Open A ");
    const second = core.addTable("physical", "Open B");
    expect(first.label).toBe("Open A");
    expect(second.id).toBe(2);
    core.removeTable(first.id);
    expect(core.addTable("virtual", "Open C").id).toBe(1);
    expect(() => core.renameTable(second.id, " ")).toThrow();
    core.renameTable(second.id, "Table 1 Open B");
    expect(core.getTable(second.id).label).toBe("Table 1 Open B");
    core.ensureTableCount(3);
    expect(core.state.tables.map((table) => table.id).sort()).toEqual([1, 2, 3]);
  });
});
