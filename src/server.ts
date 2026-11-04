import http from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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
import { CAPTURE_STEPS, RecordingStore } from "./dgt/recording.ts";
import { SerialPort } from "serialport";
import { isValidSerialPath } from "./dgt/ports.ts";
import { SerialTransport } from "./dgt/serial.ts";
import { ProtocolSimulator } from "./dgt/simulator.ts";
import { squareIndex } from "./dgt/protocol.ts";

const port = Number(process.env.PORT ?? 8787),
  webRoot = resolve(process.cwd(), "services/web");
const simulatorEnabled = process.env.DGT_SIMULATOR !== "off";
// Pairing and rfcomm binding rely on BlueZ, so they are Linux-only; on Windows, COM ports are used.
const bluetoothEnabled = process.env.DGT_BLUETOOTH !== "off" && process.platform === "linux";
const pages: Record<string, string> = { "/": "display.html", "/admin": "admin.html" };
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const core = new BroadcastCore(Number(process.env.TABLES ?? 4));
const simulator = new SimulatorTransport(core.state.tables.length);
const protocolSimulators = new Map<string, ProtocolSimulator>();
const dgtTransport = new DgtTransport({
  createTransport: (path) => protocolSimulators.get(path) ?? new SerialTransport(path),
});
const recorder = new RecordingStore(join(process.env.DGT_DATA_DIR ?? "data", "recordings"));
dgtTransport.on("raw", ({ tableId, direction, bytes }) =>
  recorder.bytes(tableId, direction, bytes),
);
dgtTransport.on("diagnostics", (data) => recorder.append({ type: "diagnostics", data }));
dgtTransport.on("connection", (data) =>
  recorder.append({ type: "connection", tableId: data.tableId, data }),
);
dgtTransport.on("reconnect-scheduled", (data) =>
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { reconnect: data } }),
);
dgtTransport.on("retry", (data) =>
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { retry: data } }),
);
dgtTransport.on("request-timeout", (data) =>
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { requestTimeout: data } }),
);
const store = new JsonStore<Persisted>(join(process.env.DGT_DATA_DIR ?? "data", "config.json"), {
  tables: core.state.tables,
  meeting: undefined,
});
const persisted = await store.load();
if (persisted.tables.length >= 1 && persisted.tables.length <= 32)
  core.state.tables = persisted.tables;
core.state.meeting = persisted.meeting;
for (const table of core.state.tables)
  if (table.physicalId)
    dgtTransport.restoreResult(table.physicalId, table.game.result, table.game.resultStatus);
for (const table of core.state.tables) {
  if (table.physicalId && !/^DGT_BT_SIM_\d+$/.test(table.physicalId))
    core.updateGame(table.id, {
      status: "associated",
      whiteClock: null,
      blackClock: null,
      clock: undefined,
      battery: undefined,
      boardBattery: undefined,
    });
}
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
  if (patch.resultStatus !== undefined)
    void persist().catch((error: unknown) => console.error("Result persistence failed:", error));
});
dgtTransport.on("board-error", ({ tableId, error }: { tableId: number; error: Error }) => {
  console.error(`DGT board on table ${tableId}:`, error.message);
  recorder.append({ type: "fault", tableId, data: error.message });
});
if (simulatorEnabled) simulator.start();
function persist() {
  return store.save({ tables: core.state.tables, meeting: core.state.meeting, addresses });
}
async function associate(tableId: number, physicalId: string, confirmE4 = true) {
  const previous = core.state.tables
    .filter(
      (t) =>
        (t.id === tableId && t.physicalId !== physicalId) ||
        (t.id !== tableId && t.physicalId === physicalId),
    )
    .map((t) => t.id);
  const table = core.enroll(tableId, physicalId, confirmE4);
  await Promise.all(previous.map((id) => dgtTransport.disconnect(id)));
  await persist();
  publish();
  return table;
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
    if (url.pathname === "/api/tables/count" && req.method === "POST") {
      const { count } = await body(req);
      core.ensureTableCount(count);
      if (simulatorEnabled) simulator.ensureTables(count);
      await persist();
      publish();
      return json(res, core.state.tables);
    }
    if (url.pathname === "/api/dgt/diagnostics" && req.method === "GET")
      return json(res, { boards: dgtTransport.diagnostics(), recording: recorder.status() });
    if (url.pathname === "/api/dgt/simulator/connect" && req.method === "POST") {
      const { tableId } = await body(req);
      core.getTable(tableId);
      const path = `sim:${tableId}`;
      const physicalId = `DGT_BT_SIM_PROTOCOL_${tableId}`;
      if (!protocolSimulators.has(path)) protocolSimulators.set(path, new ProtocolSimulator());
      await associate(tableId, physicalId);
      await dgtTransport.connect(tableId, physicalId, path);
      return json(res, core.getTable(tableId).game);
    }
    if (url.pathname === "/api/dgt/simulator/event" && req.method === "POST") {
      const b = await body(req);
      const path = `sim:${b.tableId}`;
      const simulator = protocolSimulators.get(path);
      if (
        !simulator ||
        !dgtTransport
          .diagnostics()
          .some((d) => d.tableId === b.tableId && d.path === path && d.connected)
      )
        throw new Error("Simulateur protocolaire non connecté");
      if (b.kind === "square") simulator.changeSquare(squareIndex(b.square), b.code);
      else if (b.kind === "clock")
        simulator.setTimes(b.leftSeconds, b.rightSeconds, b.running, b.activeSide, b.connected);
      else if (b.kind === "battery") simulator.setBattery(b.percent);
      else if (b.kind === "fault") simulator.fail(new Error("Panne de liaison simulée"));
      else throw new Error("Événement simulé inconnu");
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/dgt/serial/ports" && req.method === "GET")
      return json(res, await SerialPort.list());
    if (url.pathname === "/api/dgt/serial/connect" && req.method === "POST") {
      const b = await body(req);
      if (typeof b.path !== "string" || !isValidSerialPath(b.path))
        throw new Error("Chemin de port série invalide");
      const table = core.getTable(b.tableId);
      const physicalId =
        b.physicalId ??
        `DGT_USB_${b.path
          .split("/")
          .at(-1)
          .replace(/[^A-Za-z0-9_-]/g, "_")}`;
      await associate(table.id, physicalId);
      await dgtTransport.connect(table.id, physicalId, b.path);
      return json(res, dgtTransport.diagnostics());
    }
    if (url.pathname === "/api/dgt/disconnect" && req.method === "POST") {
      const b = await body(req);
      core.getTable(b.tableId);
      await dgtTransport.disconnect(b.tableId);
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/dgt/history" && req.method === "POST") {
      const b = await body(req);
      return json(res, await dgtTransport.readHistory(b.tableId));
    }
    if (url.pathname === "/api/dgt/new-game" && req.method === "POST") {
      const { tableId } = await body(req);
      dgtTransport.newGame(tableId);
      await persist();
      return json(res, core.getTable(tableId).game);
    }
    if (url.pathname === "/api/dgt/refresh" && req.method === "POST") {
      await dgtTransport.refresh((await body(req)).tableId);
      return json(res, dgtTransport.diagnostics());
    }
    if (url.pathname === "/api/dgt/recordings" && req.method === "GET")
      return json(res, {
        recording: recorder.status(),
        sessions: await recorder.list(),
        steps: CAPTURE_STEPS,
      });
    if (url.pathname === "/api/dgt/recordings/start" && req.method === "POST") {
      await recorder.start(dgtTransport.diagnostics());
      const warnings: string[] = [];
      await Promise.all(
        dgtTransport
          .diagnostics()
          .filter((d) => d.connected)
          .map(async (d) => {
            try {
              await dgtTransport.refresh(d.tableId);
            } catch (error) {
              const warning = `Table ${d.tableId} : ${String(error)}`;
              recorder.append({ type: "fault", tableId: d.tableId, data: warning });
              warnings.push(warning);
            }
          }),
      );
      return json(res, { ...recorder.status(), warnings });
    }
    if (url.pathname === "/api/dgt/recordings/mark" && req.method === "POST") {
      recorder.mark((await body(req)).label);
      return json(res, recorder.status());
    }
    if (url.pathname === "/api/dgt/recordings/stop" && req.method === "POST")
      return json(res, await recorder.stop());
    const recordingMatch = url.pathname.match(/^\/api\/dgt\/recordings\/([0-9a-f-]+)\.jsonl$/);
    if (recordingMatch && req.method === "GET") {
      res.setHeader("content-type", "application/x-ndjson");
      res.setHeader("content-disposition", `attachment; filename="${recordingMatch[1]}.jsonl"`);
      await pipeline(createReadStream(recorder.path(recordingMatch[1])), res);
      return;
    }
    if (url.pathname === "/api/discovery/scan" && req.method === "POST")
      return json(res, await scanBoards());
    if (url.pathname === "/api/bluetooth/connect" && req.method === "POST") {
      if (!bluetoothEnabled)
        return json(res, { error: "Bluetooth désactivé (DGT_BLUETOOTH=off)" }, 400);
      const simulated = new Set(simulator.snapshot().map((g) => g.physicalId));
      const boards = core.state.tables
        .filter(
          (t) =>
            t.physicalId?.startsWith("DGT_BT_") &&
            !t.physicalId.startsWith("DGT_BT_SIM_") &&
            !simulated.has(t.physicalId),
        )
        .map((t) => ({ tableId: t.id, name: t.physicalId!, address: addresses[t.physicalId!] }));
      const unknown = boards.filter((b) => !b.address).map((b) => b.name);
      if (unknown.length > 0)
        return json(
          res,
          { error: `Adresse inconnue, relancez un scan : ${unknown.join(", ")}` },
          400,
        );
      const result = await connectBoards(boards.map((b) => ({ ...b, address: b.address! })));
      await Promise.all(
        result.boards.map(async (board) => {
          if (!board.paired || !board.device) {
            core.updateGame(board.tableId, { status: "disconnected", battery: undefined });
            return;
          }
          try {
            await dgtTransport.connect(board.tableId, board.name, board.device);
          } catch (error) {
            core.updateGame(board.tableId, { status: "disconnected", battery: undefined });
            result.errors.push(
              `${board.name} : ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
      publish();
      return json(res, result);
    }
    if (url.pathname === "/api/tables/associate" && req.method === "POST") {
      const b = await body(req);
      return json(res, await associate(b.tableId, b.physicalId));
    }
    if (url.pathname === "/api/tables/dissociate" && req.method === "POST") {
      const tableId = (await body(req)).tableId;
      await dgtTransport.disconnect(tableId);
      const table = core.dissociate(tableId);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/tables/enroll" && req.method === "POST") {
      const b = await body(req);
      return json(res, await associate(b.tableId, b.physicalId, b.confirmE4 !== false));
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
    if (res.destroyed || res.headersSent) {
      console.error("HTTP request failed:", error);
      res.destroy();
      return;
    }
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
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(`DGT Broadcast listening on http://127.0.0.1:${address.port}`);
});
async function shutdown() {
  server.close();
  for (const ws of clients) ws.close();
  wss.close();
  try {
    await dgtTransport.close();
    if (recorder.status().open) await recorder.stop();
  } catch (error) {
    console.error("Shutdown failed:", error);
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
