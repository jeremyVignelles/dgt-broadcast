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
import { VirtualBoard } from "./dgt/virtual-board.ts";
import { squareIndex } from "./dgt/protocol.ts";
import type { ViteDevServer } from "vite";

const port = Number(process.env.PORT ?? 8787),
  webRoot = resolve(process.cwd(), "services/web");
const development = process.argv.includes("--dev");
let vite: ViteDevServer | undefined;
// Pairing and rfcomm binding rely on BlueZ, so they are Linux-only; on Windows, COM ports are used.
const isWindows = process.platform === "win32";
// Linux pairs and binds through BlueZ; Windows boards are paired in the OS and exposed as COM ports.
const bluetoothEnabled =
  process.env.DGT_BLUETOOTH !== "off" && (process.platform === "linux" || isWindows);
const pages: Record<string, string> = {
  "/debug": "admin.html",
};
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const core = new BroadcastCore(Number(process.env.TABLES ?? 0));
const protocolSimulators = new Map<string, ProtocolSimulator>();
const virtualBoards = new Map<number, VirtualBoard>();
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
dgtTransport.on("reconnect-scheduled", (data) => {
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { reconnect: data } });
  const table = core.state.tables.find((candidate) => candidate.id === data.tableId);
  if (table?.visible && table.physicalId === data.physicalId) {
    core.updateGame(data.tableId, { retryScheduled: true });
    publish();
  }
});
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
if (persisted.tables.length <= 32) core.state.tables = persisted.tables;
core.state.meeting = persisted.meeting;
for (const table of core.state.tables) {
  table.kind ??= table.physicalId?.startsWith("DGT_BT_SIM_") ? "virtual" : "physical";
  if (!table.physicalId) table.visible = false;
  if (table.physicalId) {
    table.game.connectionError = undefined;
    table.game.retryScheduled = false;
  }
}
for (const table of core.state.tables)
  if (table.physicalId)
    dgtTransport.restoreResult(table.physicalId, table.game.result, table.game.resultStatus);
for (const table of core.state.tables) {
  if (table.physicalId && table.kind !== "virtual")
    core.updateGame(table.id, {
      status: "associated",
      whiteClock: null,
      blackClock: null,
      clock: undefined,
      battery: undefined,
      boardBattery: undefined,
    });
  else if (table.physicalId) table.game.status = "associated";
}
const addresses: Record<string, string> = { ...persisted.addresses };
const clients = new Set<import("ws").WebSocket>();
const simulatorClients = new Map<number, import("ws").WebSocket>();
const simulatorClientAlive = new Map<import("ws").WebSocket, boolean>();
function publish() {
  const payload = JSON.stringify({ type: "projection", ...core.state });
  for (const ws of clients) if (ws.readyState === 1) ws.send(payload);
}
let persistTimer: NodeJS.Timeout | undefined;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persist().catch((error: unknown) => console.error("State persistence failed:", error));
  }, 1000);
}
dgtTransport.on("state", ({ tableId, patch }: { tableId: number; patch: Partial<GameState> }) => {
  const table = core.state.tables.find((candidate) => candidate.id === tableId);
  if (!table || table.physicalId !== patch.physicalId) return;
  core.updateGame(tableId, {
    ...patch,
    ...(patch.status === "connected" ? { connectionError: undefined } : {}),
    ...(patch.status === "connected" || patch.status === "reconnecting"
      ? { retryScheduled: false }
      : {}),
  });
  publish();
  persistSoon();
});
dgtTransport.on("board-error", ({ tableId, error }: { tableId: number; error: Error }) => {
  console.error(`DGT board on table ${tableId}:`, error.message);
  recorder.append({ type: "fault", tableId, data: error.message });
  const table = core.state.tables.find((candidate) => candidate.id === tableId);
  if (table?.visible) {
    core.updateGame(tableId, { connectionError: error.message });
    publish();
  }
});
function persist() {
  return store.save({ tables: core.state.tables, meeting: core.state.meeting, addresses });
}
async function associate(tableId: number, physicalId: string, confirmE4 = true) {
  const current = core.getTable(tableId);
  if (current.physicalId !== physicalId) delete current.serialPath;
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
const connectionAttempts = new Map<number, Promise<void>>();
function connectionStatus(tableId: number, status: GameState["status"], connectionError?: string) {
  const table = core.state.tables.find((candidate) => candidate.id === tableId);
  if (!table || !table.visible) return;
  core.updateGame(tableId, {
    status,
    connectionError,
    ...(status === "reconnecting" ? { retryScheduled: false } : {}),
  });
  publish();
}
function trackConnection(tableId: number, work: () => Promise<void>): Promise<void> {
  const pending = connectionAttempts.get(tableId);
  if (pending) return pending;
  connectionStatus(tableId, "reconnecting");
  const attempt = Promise.resolve()
    .then(work)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      connectionStatus(tableId, "disconnected", message);
      throw error;
    })
    .finally(() => {
      if (connectionAttempts.get(tableId) === attempt) connectionAttempts.delete(tableId);
    });
  connectionAttempts.set(tableId, attempt);
  return attempt;
}
async function connectBluetoothBoards(tableIds?: number[]): Promise<{
  status: number;
  body: {
    boards: Awaited<ReturnType<typeof connectBoards>>["boards"];
    created: number;
    errors: string[];
    error?: string;
  };
}> {
  const boards = core.state.tables
    .filter(
      (t) =>
        t.visible &&
        !t.serialPath &&
        (!tableIds || tableIds.includes(t.id)) &&
        (connectionAttempts.has(t.id) || !["connected", "degraded"].includes(t.game.status)) &&
        t.physicalId?.startsWith("DGT_BT_") &&
        !t.physicalId.startsWith("DGT_BT_SIM_"),
    )
    .map((t) => ({ tableId: t.id, name: t.physicalId!, address: addresses[t.physicalId!] }));
  const result: {
    boards: Awaited<ReturnType<typeof connectBoards>>["boards"];
    created: number;
    errors: string[];
  } = {
    boards: [],
    created: 0,
    errors: [],
  };
  const fresh = boards.filter((board) => !connectionAttempts.has(board.tableId));
  let batch: Promise<Awaited<ReturnType<typeof connectBoards>>> | undefined;
  const getBatch = () => {
    batch ??= (async () => {
      if (!bluetoothEnabled) throw new Error("Bluetooth désactivé (DGT_BLUETOOTH=off)");
      const connected = await connectBoards(
        fresh
          .filter((board) => board.address)
          .map((board) => ({ ...board, address: board.address! })),
        isWindows ? windowsConnectDeps() : undefined,
      );
      result.boards.push(...connected.boards);
      result.created = connected.created;
      return connected;
    })();
    return batch;
  };
  await Promise.all(
    boards.map(async (board) => {
      try {
        await trackConnection(board.tableId, async () => {
          if (!bluetoothEnabled) throw new Error("Bluetooth désactivé (DGT_BLUETOOTH=off)");
          if (!board.address) throw new Error("Adresse Bluetooth inconnue : relancez un scan.");
          const connected = await getBatch();
          const entry = connected.boards.find((candidate) => candidate.tableId === board.tableId);
          if (!entry?.paired || !entry.device) {
            const reason = connected.errors.find((error) => error.startsWith(`${board.name} :`));
            throw new Error(
              reason ??
                (isWindows
                  ? "Échiquier non appairé ou port COM sortant absent (paramètres Bluetooth de Windows)."
                  : "Appairage ou liaison RFCOMM impossible."),
            );
          }
          await dgtTransport.connect(entry.tableId, entry.name, entry.device);
        });
      } catch (error) {
        result.errors.push(
          `${board.name} : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  return { status: 200, body: result };
}
async function startVirtualBoard(tableId: number) {
  const table = core.getTable(tableId);
  const physicalId = `DGT_BT_SIM_PROTOCOL_${tableId}`;
  const path = `sim:${tableId}`;
  if (virtualBoards.has(tableId)) {
    await dgtTransport.connect(tableId, physicalId, path);
    return;
  }
  const board = new VirtualBoard(table.game);
  virtualBoards.set(tableId, board);
  protocolSimulators.set(path, board.transport);
  core.enroll(tableId, physicalId);
  try {
    await dgtTransport.connect(tableId, physicalId, path);
  } catch (error) {
    virtualBoards.delete(tableId);
    protocolSimulators.delete(path);
    board.close();
    throw error;
  }
}
async function reconnectBoard(tableId: number): Promise<void> {
  const table = core.getTable(tableId);
  if (!table.visible || !table.physicalId) throw new Error("Échiquier non sélectionné");
  if (
    (table.game.status === "connected" || table.game.status === "degraded") &&
    !connectionAttempts.has(tableId)
  )
    throw new Error("La liaison est déjà ouverte.");
  if (table.kind === "virtual") {
    await trackConnection(tableId, () => startVirtualBoard(tableId));
  } else if (table.serialPath) {
    await trackConnection(tableId, () =>
      dgtTransport.connect(tableId, table.physicalId!, table.serialPath!),
    );
  } else if (table.physicalId.startsWith("DGT_BT_")) {
    const outcome = await connectBluetoothBoards([tableId]);
    if (outcome.body.errors.length) throw new Error(outcome.body.errors.join(" ; "));
  } else {
    await trackConnection(tableId, async () => {
      throw new Error(
        "Port série inconnu : reconnectez cet échiquier depuis la page de diagnostic.",
      );
    });
  }
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
const server = http.createServer((req, res) => {
  if (vite && req.url?.startsWith("/admin/")) {
    const originalUrl = req.url;
    vite.middlewares(req, res, () => {
      req.url = originalUrl;
      void handleRequest(req, res);
    });
  } else void handleRequest(req, res);
});
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (url.pathname === "/api/health")
      return json(res, { ok: true, tables: core.state.tables.length });
    if (url.pathname === "/api/config" && req.method === "GET") return json(res, core.state);
    if (url.pathname === "/api/tables" && req.method === "GET") return json(res, core.state.tables);
    if (url.pathname === "/api/boards/add" && req.method === "POST") {
      const b = await body(req);
      if (b.kind !== "virtual" && b.kind !== "physical")
        throw new Error("Type d'échiquier invalide");
      if (typeof b.label !== "string" || !b.label.trim() || b.label.trim().length > 100)
        throw new Error("Le libellé doit contenir entre 1 et 100 caractères");
      if (
        b.kind === "physical" &&
        b.path !== undefined &&
        (typeof b.path !== "string" || !isValidSerialPath(b.path))
      )
        throw new Error("Chemin de port série invalide");
      const physicalId = b.path
        ? `DGT_USB_${b.path
            .split(/[\\/]/)
            .at(-1)
            .replace(/[^A-Za-z0-9_-]/g, "_")}`
        : b.physicalId;
      if (
        b.kind === "physical" &&
        (typeof physicalId !== "string" || !/^DGT_(?:BT|USB)_[A-Za-z0-9_-]+$/.test(physicalId))
      )
        throw new Error("Identifiant d'échiquier invalide");
      let table =
        b.kind === "physical"
          ? core.state.tables.find((candidate) => candidate.physicalId === physicalId)
          : undefined;
      if (table?.visible) throw new Error("Cet échiquier est déjà sélectionné");
      if (table) {
        table.visible = true;
      } else {
        table = core.addTable(b.kind, b.label);
        if (b.kind === "physical") core.enroll(table.id, physicalId);
      }
      if (b.path) table.serialPath = b.path;
      if (b.kind === "virtual") {
        try {
          await startVirtualBoard(table.id);
        } catch (error) {
          core.removeTable(table.id);
          throw error;
        }
      }
      await persist();
      publish();
      if (b.kind === "physical" && table.serialPath)
        await trackConnection(table.id, () =>
          dgtTransport.connect(table.id, table.physicalId!, table.serialPath!),
        );
      return json(res, table);
    }
    if (url.pathname === "/api/boards/rename" && req.method === "POST") {
      const b = await body(req);
      const table = core.renameTable(b.tableId, b.label);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/boards/reconnect" && req.method === "POST") {
      const { tableId } = await body(req);
      await reconnectBoard(tableId);
      return json(res, core.getTable(tableId));
    }
    if (url.pathname === "/api/boards/remove" && req.method === "POST") {
      const { tableId } = await body(req);
      const table = core.getTable(tableId);
      table.visible = false;
      publish();
      const pending = connectionAttempts.get(tableId);
      if (pending)
        await pending.catch((error: unknown) =>
          console.error(`Connexion interrompue pour l'échiquier ${tableId} :`, error),
        );
      simulatorClients.get(tableId)?.close(1000, "Échiquier retiré");
      simulatorClients.delete(tableId);
      await dgtTransport.disconnect(tableId);
      const virtual = virtualBoards.get(tableId);
      if (virtual) {
        virtual.close();
        virtualBoards.delete(tableId);
        protocolSimulators.delete(`sim:${tableId}`);
      }
      if (table.kind === "virtual") core.removeTable(tableId);
      else {
        table.visible = false;
        core.updateGame(tableId, { status: "disconnected" });
      }
      await persist();
      publish();
      return json(res, { ok: true });
    }
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
      if (table.kind === "virtual")
        throw new Error("Un simulateur ne peut pas être associé à un port série");
      const physicalId =
        b.physicalId ??
        `DGT_USB_${b.path
          .split("/")
          .at(-1)
          .replace(/[^A-Za-z0-9_-]/g, "_")}`;
      await associate(table.id, physicalId);
      table.kind = "physical";
      table.serialPath = b.path;
      await persist();
      await dgtTransport.connect(table.id, physicalId, b.path);
      return json(res, dgtTransport.diagnostics());
    }
    if (url.pathname === "/api/dgt/disconnect" && req.method === "POST") {
      const b = await body(req);
      if (core.getTable(b.tableId).kind === "virtual")
        throw new Error("Retirez le simulateur depuis l'administration");
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
      if (
        core.getTable(b.tableId).kind === "virtual" ||
        String(b.physicalId).startsWith("DGT_BT_SIM_")
      )
        throw new Error("Un simulateur ne peut pas être associé à un échiquier physique");
      return json(res, await associate(b.tableId, b.physicalId));
    }
    if (url.pathname === "/api/tables/dissociate" && req.method === "POST") {
      const tableId = (await body(req)).tableId;
      if (core.getTable(tableId).kind === "virtual")
        throw new Error("Retirez le simulateur depuis l'administration");
      await dgtTransport.disconnect(tableId);
      const table = core.dissociate(tableId);
      await persist();
      publish();
      return json(res, table);
    }
    if (url.pathname === "/api/tables/enroll" && req.method === "POST") {
      const b = await body(req);
      if (
        core.getTable(b.tableId).kind === "virtual" ||
        String(b.physicalId).startsWith("DGT_BT_SIM_")
      )
        throw new Error("Un simulateur ne peut pas être associé à un échiquier physique");
      return json(res, await associate(b.tableId, b.physicalId, b.confirmE4 !== false));
    }
    if (url.pathname === "/api/tables/visibility" && req.method === "POST") {
      const b = await body(req);
      if (core.getTable(b.tableId).kind === "virtual")
        throw new Error("Gérez les simulateurs depuis l'administration");
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
      if (url.pathname === "/simulator" || url.pathname === "/simulator/") {
        res.writeHead(302, { location: "/admin" });
        return res.end();
      }
      const viteEntry = url.pathname === "/" ? "display.html" : "index.html";
      const targetPath =
        pages[url.pathname] ??
        (url.pathname === "/" || url.pathname === "/admin" || url.pathname.startsWith("/admin/")
          ? development
            ? `admin/${viteEntry}`
            : url.pathname.startsWith("/admin/assets/")
              ? join("dist", "admin", url.pathname.slice("/admin/".length))
              : join("dist", "admin", viteEntry)
          : url.pathname.slice(1));
      const target = resolve(webRoot, targetPath);
      if (!target.startsWith(webRoot + sep)) return json(res, { error: "invalid path" }, 400);
      try {
        const file = await readFile(target);
        if (vite && extname(target) === ".html") {
          const html =
            targetPath.startsWith("admin/") && targetPath.endsWith(".html")
              ? await vite.transformIndexHtml(url.pathname, file.toString("utf8"))
              : file
                  .toString("utf8")
                  .replace(
                    "</head>",
                    '<script type="module" src="/admin/@vite/client"></script></head>',
                  );
          res.writeHead(200, { "content-type": mimeTypes[".html"] });
          return res.end(html);
        }
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
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "projection", ...core.state }));
  ws.on("close", () => clients.delete(ws));
});
server.on("upgrade", (req, socket, head) => {
  if (vite && req.headers["sec-websocket-protocol"] === "vite-hmr") return;
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/api/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  const simulatorMatch = pathname.match(/^\/api\/dgt\/simulator\/(\d+)$/);
  if (!simulatorMatch) return socket.destroy();
  const tableId = Number(simulatorMatch[1]);
  const board = virtualBoards.get(tableId);
  if (!board) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (simulatorClients.has(tableId)) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "Un simulateur est déjà ouvert pour cet échiquier.",
        }),
      );
      ws.close(1008);
      return;
    }

    simulatorClients.set(tableId, ws);
    simulatorClientAlive.set(ws, true);
    ws.on("pong", () => simulatorClientAlive.set(ws, true));
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.kind === "position") board.transport.setPosition(event.codes);
        else if (event.kind === "square")
          board.transport.changeSquare(squareIndex(event.square), event.code);
        else if (event.kind === "clock")
          board.setClock(
            event.leftSeconds,
            event.rightSeconds,
            event.running,
            event.activeSide,
            event.connected,
          );
        else if (event.kind === "battery") board.transport.setBattery(event.percent);
        else throw new Error("Événement simulé inconnu");
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    const disconnect = () => {
      if (simulatorClients.get(tableId) === ws) simulatorClients.delete(tableId);
      simulatorClientAlive.delete(ws);
    };
    ws.on("close", disconnect);
    ws.on("error", (error) => {
      console.error(`Simulator WebSocket error on table ${tableId}:`, error);
      disconnect();
    });
    ws.send(JSON.stringify({ type: "ready" }));
  });
});
if (development) {
  const { createServer } = await import("vite");
  vite = await createServer({
    configFile: resolve("vite.config.ts"),
    configLoader: "runner",
    root: resolve(webRoot, "admin"),
    appType: "custom",
    server: { middlewareMode: true, hmr: { server } },
  });
  const staticFiles = ["admin.html", "admin.js", "admin.css", "board.js", "layout.js"].map((file) =>
    resolve(webRoot, file),
  );
  vite.watcher.add(staticFiles);
  vite.watcher.on("change", (file) => {
    if (staticFiles.includes(resolve(file))) vite?.hot.send({ type: "full-reload", path: "*" });
  });
}
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
  if (address && typeof address !== "string") {
    console.log(`DGT Broadcast listening on http://127.0.0.1:${address.port}`);
    console.log(`   Admin page available at http://127.0.0.1:${address.port}/admin/`);
  }
  // Restored tables are only "associated"; reconnect their boards without operator action.
  void connectBluetoothBoards()
    .then(({ body }) => {
      if (body.error) console.error("Startup reconnection skipped:", body.error);
      else for (const e of body.errors ?? []) console.error("Startup reconnection:", e);
    })
    .catch((error: unknown) => console.error("Startup reconnection failed:", error));
  for (const table of core.state.tables.filter((candidate) => candidate.visible)) {
    if (table.kind === "virtual") {
      void reconnectBoard(table.id).catch((error: unknown) =>
        console.error("Simulator startup failed:", error),
      );
    } else if (table.serialPath && table.physicalId) {
      void reconnectBoard(table.id).catch((error: unknown) =>
        console.error("Serial startup failed:", error),
      );
    } else if (table.physicalId && !table.physicalId.startsWith("DGT_BT_")) {
      void reconnectBoard(table.id).catch((error: unknown) =>
        console.error("Startup reconnection failed:", error),
      );
    }
  }
});
async function shutdown() {
  clearInterval(simulatorHeartbeat);
  if (persistTimer) clearTimeout(persistTimer);
  server.close();
  for (const ws of clients) ws.close();
  for (const ws of simulatorClients.values()) ws.close();
  wss.close();
  try {
    await vite?.close();
    await persist();
    for (const board of virtualBoards.values()) board.close();
    await dgtTransport.close();
    if (recorder.status().open) await recorder.stop();
  } catch (error) {
    console.error("Shutdown failed:", error);
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
