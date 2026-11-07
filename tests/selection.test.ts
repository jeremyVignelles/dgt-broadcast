import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LogicalTable } from "../src/domain/types.ts";
import { INITIAL_CODES } from "../src/dgt/simulator.ts";

describe("board selection", () => {
  let directory: string;
  let server: ChildProcessWithoutNullStreams;
  let base: string;
  let output = "";

  async function start(development = false) {
    server = spawn(process.execPath, ["src/server.ts", ...(development ? ["--dev"] : [])], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: "0",
        TABLES: "0",
        DGT_BLUETOOTH: "off",
        DGT_DATA_DIR: directory,
      },
    });
    server.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server startup timed out: ${output}`)),
        10000,
      );
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited: ${code} ${output}`));
      });
      server.stdout.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
    });
  }
  async function stop() {
    if (server.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    server.kill("SIGTERM");
    await exited;
  }
  async function post<T>(path: string, value: object): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result as T;
  }
  async function tables(): Promise<LogicalTable[]> {
    return (await fetch(`${base}/api/tables`)).json() as Promise<LogicalTable[]>;
  }
  async function waitFor(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for board state");
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dgt-selection-"));
    await start();
  });
  afterAll(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a virtual board active without its editor and restores its position on restart", async () => {
    const board = await post<LogicalTable>("/api/boards/add", { kind: "virtual", label: "Open A" });
    await post("/api/boards/rename", { tableId: board.id, label: "Open B · 1" });
    const forbidden = await fetch(`${base}/api/dgt/disconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableId: board.id }),
    });
    expect(forbidden.status).toBe(400);
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/dgt/simulator/${board.id}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "ready") resolve();
        if (message.type === "error") reject(new Error(message.error));
      });
    });
    const codes = [...INITIAL_CODES];
    codes[52] = 0;
    codes[36] = 1;
    ws.send(JSON.stringify({ kind: "position", codes }));
    ws.send(
      JSON.stringify({
        kind: "clock",
        leftSeconds: 30,
        rightSeconds: 30,
        running: true,
        activeSide: "left",
        connected: true,
      }),
    );
    await waitFor(async () => (await tables())[0].game.fen.includes("4P3"));
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const active = (await tables())[0];
    expect(active.game.status).toBe("connected");
    expect(active.game.whiteClock).toBeLessThan(30);
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
        tables: LogicalTable[];
      };
      return (saved.tables[0].game.whiteClock ?? 30) < 30;
    });
    await stop();
    await start();
    await waitFor(async () => (await tables())[0].game.status === "connected");
    const restored = (await tables())[0];
    expect(restored.label).toBe("Open B · 1");
    expect(restored.game.fen).toContain("4P3");
    expect(restored.game.whiteClock).toBeLessThan(30);
    await post("/api/boards/remove", { tableId: board.id });
    expect(await tables()).toEqual([]);
  }, 25000);

  it("retains detached physical boards and restores them on reselection", async () => {
    const board = await post<LogicalTable>("/api/boards/add", {
      kind: "physical",
      label: "Open A",
      physicalId: "DGT_BT_TEST",
    });
    await post("/api/boards/remove", { tableId: board.id });
    expect((await tables())[0]).toMatchObject({ visible: false, physicalId: "DGT_BT_TEST" });
    const selected = await post<LogicalTable>("/api/boards/add", {
      kind: "physical",
      label: "Open B",
      physicalId: "DGT_BT_TEST",
    });
    expect(selected).toMatchObject({ id: board.id, visible: true, label: "Open A" });
    expect(await tables()).toHaveLength(1);
  });

  it("reports startup and manual reconnection failures for the selected board", async () => {
    await stop();
    await start();
    await waitFor(async () => (await tables())[0]?.game.status === "disconnected");
    const restored = (await tables())[0];
    expect(restored.game.connectionError).toContain("Bluetooth désactivé");
    const response = await fetch(`${base}/api/boards/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableId: restored.id }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Bluetooth désactivé");
    expect((await tables())[0].game).toMatchObject({
      status: "disconnected",
      connectionError: "Bluetooth désactivé (DGT_BLUETOOTH=off)",
    });
    await post("/api/boards/remove", { tableId: restored.id });
    const unavailable = await fetch(`${base}/api/boards/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableId: restored.id }),
    });
    expect(unavailable.status).toBe(400);
  });

  it("reports serial connection failures on the retained board", async () => {
    const serialPath = process.platform === "win32" ? "COM999" : "/dev/ttyUSB98765";
    const response = await fetch(`${base}/api/boards/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "physical", label: "USB", path: serialPath }),
    });
    expect(response.status).toBe(400);
    const board = (await tables()).find((table) => table.serialPath === serialPath)!;
    expect(board.visible).toBe(true);
    expect(board.game.status).toBe("disconnected");
    expect(board.game.connectionError).toBeTruthy();
    const retry = await fetch(`${base}/api/boards/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tableId: board.id }),
    });
    expect(retry.status).toBe(400);
    expect(
      (await tables()).find((item) => item.id === board.id)?.game.connectionError,
    ).toBeTruthy();
    await post("/api/boards/remove", { tableId: board.id });
  });

  it("serves Vite and its HMR websocket alongside the application in development", async () => {
    await stop();
    await start(true);
    for (const path of ["/", "/debug", "/admin", "/admin/boards/1"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("/admin/@vite/client");
    }
    const client = await (await fetch(`${base}/admin/@vite/client`)).text();
    const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    const module = await fetch(`${base}/admin/src/App.vue`);
    expect(module.status).toBe(200);
    expect(await module.text()).toContain("createHotContext");
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/admin/?token=${token}`, "vite-hmr", {
      headers: { origin: base },
    });
    try {
      const message = await new Promise<string>((resolve, reject) => {
        ws.once("message", (data) => resolve(data.toString()));
        ws.once("error", reject);
      });
      expect(JSON.parse(message)).toMatchObject({ type: "connected" });
    } finally {
      ws.close();
    }
  }, 15000);
});
