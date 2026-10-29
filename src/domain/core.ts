import { INITIAL_FEN, validateTableId } from "./types.ts";
import type { AppState, GameState, LogicalTable, Meeting, Player } from "./types.ts";

export class BroadcastCore {
  readonly state: AppState;
  constructor(tableCount = 4) {
    if (tableCount < 1 || tableCount > 32) throw new Error("tableCount must be between 1 and 32");
    this.state = {
      tables: Array.from({ length: tableCount }, (_, i) => this.table(i + 1)),
      discovered: [],
    };
  }
  private table(id: number): LogicalTable {
    return {
      id,
      label: `Table ${id}`,
      visible: true,
      game: {
        tableId: id,
        fen: INITIAL_FEN,
        whiteClock: 0,
        blackClock: 0,
        battery: 100,
        status: "disconnected",
        updatedAt: new Date().toISOString(),
      },
    };
  }
  discover(ids: string[]): string[] {
    this.state.discovered = ids.filter((x) => /^DGT_BT_[A-Za-z0-9_-]+$/.test(x));
    return this.state.discovered;
  }
  enroll(tableId: number, physicalId: string, confirmE4 = true): LogicalTable {
    validateTableId(tableId);
    if (!confirmE4) throw new Error("Enrollment requires the white king on E4");
    if (!/^DGT_(?:BT|USB)_[A-Za-z0-9_-]+$/.test(physicalId))
      throw new Error("Invalid physical board id");
    const table = this.getTable(tableId);
    for (const other of this.state.tables) {
      if (other !== table && other.physicalId === physicalId) this.dissociate(other.id);
    }
    table.physicalId = physicalId;
    table.game.physicalId = physicalId;
    table.game.status = "associated";
    return table;
  }
  dissociate(tableId: number): LogicalTable {
    const table = this.getTable(tableId);
    delete table.physicalId;
    delete table.game.physicalId;
    table.game.status = "disconnected";
    return table;
  }
  manualAssociate(tableId: number, physicalId: string): LogicalTable {
    return this.enroll(tableId, physicalId, true);
  }
  ensureTableCount(count: number): void {
    validateTableId(count);
    for (let id = this.state.tables.length + 1; id <= count; id++)
      this.state.tables.push(this.table(id));
  }
  getTable(id: number): LogicalTable {
    validateTableId(id);
    const table = this.state.tables.find((t) => t.id === id);
    if (!table) throw new Error("Unknown table");
    return table;
  }
  updateGame(id: number, patch: Partial<GameState>): GameState {
    const table = this.getTable(id);
    table.game = { ...table.game, ...patch, tableId: id, updatedAt: new Date().toISOString() };
    return table.game;
  }
  setVisible(id: number, visible: boolean): LogicalTable {
    const table = this.getTable(id);
    table.visible = visible;
    return table;
  }
  startMeeting(name = "Local meeting"): Meeting {
    this.state.meeting = {
      id: `meeting-${Date.now()}`,
      name,
      status: "active",
      players: [],
      createdAt: new Date().toISOString(),
    };
    return this.state.meeting;
  }
  addPlayers(players: Player[]): Player[] {
    if (!this.state.meeting) this.startMeeting();
    this.state.meeting!.players.push(...players);
    this.state.meeting!.players.sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0));
    return this.state.meeting!.players;
  }
}
