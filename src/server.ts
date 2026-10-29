import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { BroadcastCore } from "./domain/core.ts";
import { SimulatorTransport } from "./adapters/simulator.ts";
import { JsonStore } from "./adapters/storage.ts";
import type { Persisted } from "./adapters/storage.ts";
import { discoverBluetoothBoards } from "./adapters/bluetooth.ts";
import { connectBoards } from "./adapters/connect.ts";
import { DgtTransport } from "./adapters/dgt.ts";
import { parsePlayersCsv, toPgn } from "./adapters/export.ts";
import type { GameState } from "./domain/types.ts";

const port = Number(process.env.PORT ?? 8787),
  webRoot = resolve(process.cwd(), "services/web");
const simulatorEnabled = process.env.DGT_SIMULATOR !== "off";
const bluetoothEnabled = process.env.DGT_BLUETOOTH !== "off";
const pages: Record<string, string> = { "/": "display.html", "/admin": "admin.html" };
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const core = new BroadcastCore(Number(process.env.TABLES ?? 4));
const simulator = new SimulatorTransport(core.state.tables.length);
const dgtTransport = new DgtTransport();
const store = new JsonStore<Persisted>(join(process.env.DGT_DATA_DIR ?? "data", "config.json"), {
  tables: core.state.tables,
  meeting: undefined,
});
const persisted = await store.load();
if (persisted.tables.length >= 1 && persisted.tables.length <= 32)
  core.state.tables = persisted.tables;
core.state.meeting = persisted.meeting;
const addresses: Record<string, string> = { ...persisted.addresses };
const clients = new Set<import("ws").WebSocket>();
function publish() {
  const payload = JSON.stringify({ type: "projection", ...core.state });
  for (const ws of clients) if (ws.readyState === 1) ws.send(payload);
}
simulator.on("state", (game: GameState) => {
  const table = core.getTable(game.tableId);
  if (table.physicalId && table.physicalId !== game.physicalId) return;
  core.updateGame(game.tableId, game);
  publish();
});
dgtTransport.on("state", ({ tableId, patch }: { tableId: number; patch: Partial<GameState> }) => {
  if (core.getTable(tableId).physicalId !== patch.physicalId) return;
  core.updateGame(tableId, patch);
  publish();
});
dgtTransport.on("board-error", ({ tableId, error }: { tableId: number; error: Error }) =>
  console.error(`DGT board on table ${tableId}:`, error.message),
);
if (simulatorEnabled) simulator.start();
function persist() {
  return store.save({ tables: core.state.tables, meeting: core.state.meeting, addresses });
}
let scan: Promise<unknown> | undefined;
function scanBoards() {
  scan ??= (async () => {
    const boards: {
      id: string;
      name: string;
      address?: string;
      source: "bluetooth" | "simulator";
    }[] = [];
    const errors: string[] = [];
    if (bluetoothEnabled) {
      try {
        for (const b of await discoverBluetoothBoards()) {
          boards.push({ id: b.name, name: b.name, address: b.address, source: "bluetooth" });
          addresses[b.name] = b.address;
        }
        await persist();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (simulatorEnabled) {
      for (const g of simulator.snapshot())
        boards.push({ id: g.physicalId!, name: g.physicalId!, source: "simulator" });
    }
    core.discover(boards.map((b) => b.id));
    return { boards, errors };
  })().finally(() => (scan = undefined));
  return scan;
}
function json(res: http.ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (url.pathname === "/api/health")
      return json(res, { ok: true, tables: core.state.tables.length });
    if (url.pathname === "/api/config" && req.method === "GET") return json(res, core.state);
    if (url.pathname === "/api/tables" && req.method === "GET") return json(res, core.state.tables);
    if (url.pathname === "/api/discovery/scan" && req.method === "POST")
      return json(res, await scanBoards());
    if (url.pathname === "/api/bluetooth/connect" && req.method === "POST") {
      if (!bluetoothEnabled)
        return json(res, { error: "Bluetooth désactivé (DGT_BLUETOOTH=off)" }, 400);
      const simulated = new Set(simulator.snapshot().map((g) => g.physicalId));
      const boards = core.state.tables
        .filter((t) => t.physicalId && !simulated.has(t.physicalId))
        .map((t) => ({ tableId: t.id, name: t.physicalId!, address: addresses[t.physicalId!] }));
      const unknown = boards.filter((b) => !b.address).map((b) => b.name);
      if (unknown.length > 0)
        return json(
          res,
          { error: `Adresse inconnue, relancez un scan : ${unknown.join(", ")}` },
          400,
        );
      const result = await connectBoards(boards.map((b) => ({ ...b, address: b.address! })));
      for (const board of result.boards) {
        if (!board.paired || !board.device) {
          core.updateGame(board.tableId, { status: "disconnected", battery: undefined });
          continue;
        }
        try {
          await dgtTransport.connect(board.tableId, board.name, board.device);
        } catch (error) {
          core.updateGame(board.tableId, { status: "disconnected", battery: undefined });
          result.errors.push(
            `${board.name} : ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      publish();
      return json(res, result);
    }
    if (url.pathname === "/api/tables/associate" && req.method === "POST") {
      const b = await body(req);
      const table = core.manualAssociate(b.tableId, b.physicalId);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/tables/dissociate" && req.method === "POST") {
      const table = core.dissociate((await body(req)).tableId);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/tables/enroll" && req.method === "POST") {
      const b = await body(req);
      const table = core.enroll(b.tableId, b.physicalId, b.confirmE4 !== false);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/tables/visibility" && req.method === "POST") {
      const b = await body(req);
      const table = core.setVisible(b.tableId, Boolean(b.visible));
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/meeting" && req.method === "POST") {
      const meeting = core.startMeeting((await body(req)).name);
      await persist();
      return json(res, meeting);
    }
    if (url.pathname === "/api/players/import" && req.method === "POST") {
      const b = await body(req);
      return json(res, core.addPlayers(parsePlayersCsv(b.csv ?? "")));
    }
    const exportMatch = url.pathname.match(/^\/api\/export\/(\d+)\.(pgn|json)$/);
    if (exportMatch) {
      const state = core.state;
      return exportMatch[2] === "json"
        ? json(res, state)
        : (res.writeHead(200, { "content-type": "application/x-chess-pgn" }),
          res.end(toPgn(core.getTable(Number(exportMatch[1])).game)));
    }
    if (url.pathname === "/api/simulator/move" && req.method === "POST") {
      const b = await body(req);
      simulator.move(b.tableId, b.lastMove, b.fen);
      return json(res, core.getTable(b.tableId).game);
    }
    if (url.pathname === "/api/simulator/status" && req.method === "POST") {
      const b = await body(req);
      simulator.setStatus(b.tableId, b.status, b.battery);
      return json(res, core.getTable(b.tableId).game);
    }
    if (req.method === "GET") {
      const target = resolve(webRoot, pages[url.pathname] ?? url.pathname.slice(1));
      if (!target.startsWith(webRoot + sep)) return json(res, { error: "invalid path" }, 400);
      try {
        const file = await readFile(target);
        res.writeHead(200, { "content-type": mimeTypes[extname(target)] ?? "text/plain" });
        return res.end(file);
      } catch {}
    }
    json(res, { error: "not found" }, 404);
  } catch (error) {
    json(res, { error: error instanceof Error ? error.message : "request failed" }, 400);
  }
});
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "projection", ...core.state }));
  ws.on("close", () => clients.delete(ws));
});
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/api/stream")
    return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
server.listen(port, "127.0.0.1", () =>
  console.log(`DGT Broadcast listening on http://127.0.0.1:${port}`),
);
