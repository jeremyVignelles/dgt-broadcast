import http from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { BroadcastCore } from "./domain/core.ts";
import { JsonStore } from "./adapters/storage.ts";
import type { Persisted } from "./adapters/storage.ts";
import { discoverBluetoothBoards } from "./adapters/bluetooth.ts";
import { listWindowsBoards, windowsConnectDeps } from "./adapters/windows-bluetooth.ts";
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
// Pairing and rfcomm binding rely on BlueZ, so they are Linux-only; on Windows, COM ports are used.
const isWindows = process.platform === "win32";
// Linux pairs and binds through BlueZ; Windows boards are paired in the OS and exposed as COM ports.
const bluetoothEnabled =
  process.env.DGT_BLUETOOTH !== "off" && (process.platform === "linux" || isWindows);
const pages: Record<string, string> = {
  "/": "display.html",
  "/admin": "admin.html",
  "/simulator": "dist/simulator/index.html",
  "/simulator/": "dist/simulator/index.html",
};
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const core = new BroadcastCore(Number(process.env.TABLES ?? 4));
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
  if (table.physicalId?.startsWith("DGT_BT_SIM_")) core.dissociate(table.id);
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
const simulatorClients = new Map<number, import("ws").WebSocket>();
const simulatorClientAlive = new Map<import("ws").WebSocket, boolean>();
function publish() {
  const payload = JSON.stringify({ type: "projection", ...core.state });
  for (const ws of clients) if (ws.readyState === 1) ws.send(payload);
}
dgtTransport.on("state", ({ tableId, patch }: { tableId: number; patch: Partial<GameState> }) => {
  if (core.getTable(tableId).physicalId !== patch.physicalId) return;
  core.updateGame(tableId, patch);
  publish();
  if (patch.resultStatus !== undefined && !patch.physicalId?.startsWith("DGT_BT_SIM_"))
    void persist().catch((error: unknown) => console.error("Result persistence failed:", error));
});
dgtTransport.on("board-error", ({ tableId, error }: { tableId: number; error: Error }) => {
  console.error(`DGT board on table ${tableId}:`, error.message);
  recorder.append({ type: "fault", tableId, data: error.message });
});
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
      source: "bluetooth";
    }[] = [];
    const errors: string[] = [];
    if (bluetoothEnabled) {
      try {
        for (const b of await (isWindows ? listWindowsBoards() : discoverBluetoothBoards())) {
          boards.push({ id: b.name, name: b.name, address: b.address, source: "bluetooth" });
          addresses[b.name] = b.address;
        }
        await persist();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    core.discover(boards.map((b) => b.id));
    return { boards, errors };
  })().finally(() => (scan = undefined));
  return scan;
}
async function connectBluetoothBoards(): Promise<{ status: number; body: any }> {
  if (!bluetoothEnabled)
    return { status: 400, body: { error: "Bluetooth désactivé (DGT_BLUETOOTH=off)" } };
  const boards = core.state.tables
    .filter(
      (t) =>
        t.physicalId?.startsWith("DGT_BT_") &&
        !t.physicalId.startsWith("DGT_BT_SIM_"),
    )
    .map((t) => ({ tableId: t.id, name: t.physicalId!, address: addresses[t.physicalId!] }));
  const unknown = boards.filter((b) => !b.address).map((b) => b.name);
  if (unknown.length > 0)
    return {
      status: 400,
      body: { error: `Adresse inconnue, relancez un scan : ${unknown.join(", ")}` },
    };
  const result = await connectBoards(
    boards.map((b) => ({ ...b, address: b.address! })),
    isWindows ? windowsConnectDeps() : undefined,
  );
  await Promise.all(
    result.boards.map(async (board) => {
      if (!board.paired || !board.device) {
        if (board.paired && isWindows)
          result.errors.push(
            `${board.name} : aucun port COM sortant (Paramètres Bluetooth > Ports COM)`,
          );
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
  return { status: 200, body: result };
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
      await persist();
      publish();
      return json(res, core.state.tables);
    }
    if (url.pathname === "/api/dgt/diagnostics" && req.method === "GET")
      return json(res, { boards: dgtTransport.diagnostics(), recording: recorder.status() });
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
      const outcome = await connectBluetoothBoards();
      return json(res, outcome.body, outcome.status);
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
    if (req.method === "GET") {
      const targetPath = pages[url.pathname] ??
        (url.pathname.startsWith("/simulator/")
        ? join("dist", "simulator", url.pathname.slice("/simulator/".length))
          : url.pathname.slice(1));
      const target = resolve(webRoot, targetPath);
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
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "projection", ...core.state }));
  ws.on("close", () => clients.delete(ws));
});
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/api/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  const simulatorMatch = pathname.match(/^\/api\/dgt\/simulator\/(\d+)$/);
  if (!simulatorMatch) return socket.destroy();
  const tableId = Number(simulatorMatch[1]);
  try {
    core.getTable(tableId);
  } catch {
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const physicalId = `DGT_BT_SIM_PROTOCOL_${tableId}`;
    const path = `sim:${tableId}`;
    if (
      simulatorClients.has(tableId) ||
      (core.getTable(tableId).physicalId && core.getTable(tableId).physicalId !== physicalId)
    ) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: simulatorClients.has(tableId)
            ? "Un simulateur est déjà ouvert pour cette table."
            : "Cette table est déjà associée à un échiquier physique.",
        }),
      );
      ws.close(1008);
      return;
    }

    const simulator = new ProtocolSimulator();
    simulatorClients.set(tableId, ws);
    simulatorClientAlive.set(ws, true);
    protocolSimulators.set(path, simulator);
    core.enroll(tableId, physicalId);
    publish();
    ws.on("pong", () => simulatorClientAlive.set(ws, true));
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.kind === "position") simulator.setPosition(event.codes);
        else if (event.kind === "square")
          simulator.changeSquare(squareIndex(event.square), event.code);
        else if (event.kind === "clock")
          simulator.setTimes(
            event.leftSeconds,
            event.rightSeconds,
            event.running,
            event.activeSide,
            event.connected,
          );
        else if (event.kind === "battery") simulator.setBattery(event.percent);
        else throw new Error("Événement simulé inconnu");
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
      }
    });

    let cleanup: Promise<void> | undefined;
    const disconnect = () => {
      cleanup ??= (async () => {
        if (simulatorClients.get(tableId) === ws) simulatorClients.delete(tableId);
        simulatorClientAlive.delete(ws);
        if (protocolSimulators.get(path) === simulator) protocolSimulators.delete(path);
        await dgtTransport.disconnect(tableId);
        const table = core.getTable(tableId);
        if (table.physicalId === physicalId) {
          core.dissociate(tableId);
          publish();
        }
      })().catch((error: unknown) => console.error("Simulator disconnect failed:", error));
      return cleanup;
    };
    ws.on("close", () => void disconnect());
    ws.on("error", (error) => {
      console.error(`Simulator WebSocket error on table ${tableId}:`, error);
      void disconnect();
    });
    void dgtTransport
      .connect(tableId, physicalId, path)
      .then(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ready" }));
      })
      .catch((error: unknown) => {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          ws.close(1011);
        }
      });
  });
});
const simulatorHeartbeat = setInterval(() => {
  for (const [tableId, ws] of simulatorClients) {
    if (simulatorClientAlive.get(ws) === false) {
      ws.terminate();
      console.warn(`Simulator heartbeat expired on table ${tableId}`);
    } else if (ws.readyState === 1) {
      simulatorClientAlive.set(ws, false);
      ws.ping();
    }
  }
}, 15_000);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(`DGT Broadcast listening on http://127.0.0.1:${address.port}`);
  // Restored tables are only "associated"; reconnect their boards without operator action.
  if (bluetoothEnabled)
    void connectBluetoothBoards()
      .then(({ body }) => {
        if (body.error) console.error("Startup reconnection skipped:", body.error);
        else for (const e of body.errors ?? []) console.error("Startup reconnection:", e);
      })
      .catch((error: unknown) => console.error("Startup reconnection failed:", error));
});
async function shutdown() {
  clearInterval(simulatorHeartbeat);
  server.close();
  for (const ws of clients) ws.close();
  for (const ws of simulatorClients.values()) ws.close();
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
