import { join } from "node:path";
import { DgtTransport } from "../src/adapters/dgt.ts";
import { RecordingStore } from "../src/dgt/recording.ts";

const args = process.argv.slice(2);
const durationIndex = args.indexOf("--seconds");
let seconds = 60;
if (durationIndex !== -1) {
  seconds = Number(args[durationIndex + 1]);
  args.splice(durationIndex, 2);
}
const history = args.includes("--history");
const paths = args.filter((arg) => arg !== "--history");
if (
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 86400 ||
  !paths.length ||
  paths.length > 32 ||
  new Set(paths).size !== paths.length ||
  paths.some(
    (path) => !/^\/dev\/(?:rfcomm\d+|ttyUSB\d+|ttyACM\d+|serial\/by-id\/[^/]+)$/.test(path),
  )
)
  throw new Error(
    "Usage : npm run dgt:probe -- [--seconds 60] [--history] /dev/rfcomm0 [/dev/rfcomm1 …]",
  );

const recorder = new RecordingStore(join(process.env.DGT_DATA_DIR ?? "data", "recordings"));
const transport = new DgtTransport();
transport.on("raw", ({ tableId, direction, bytes }) => recorder.bytes(tableId, direction, bytes));
transport.on("board-error", ({ tableId, error }) => {
  console.error(`Table ${tableId} : ${error.message}`);
  recorder.append({ type: "fault", tableId, data: error.message });
});
transport.on("diagnostics", (data) => recorder.append({ type: "diagnostics", data }));
transport.on("retry", (data) =>
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { retry: data } }),
);
transport.on("request-timeout", (data) =>
  recorder.append({ type: "diagnostics", tableId: data.tableId, data: { requestTimeout: data } }),
);
transport.on("connection", (data) =>
  recorder.append({ type: "connection", tableId: data.tableId, data }),
);
await recorder.start({ paths, seconds, history });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let interrupted = false;
try {
  const results = await Promise.allSettled(
    paths.map(async (path, i) => {
      await transport.connect(i + 1, `DGT_BT_PROBE_${i + 1}`, path);
      if (history) await transport.readHistory(i + 1);
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`${paths[index]} : ${String(result.reason)}`);
      process.exitCode = 1;
    }
  }
  const connected = transport.diagnostics().filter((board) => board.connected).length;
  if (!connected)
    throw new Error("Aucun plateau connecté : test de stabilité annulé, capture conservée");
  recorder.mark("Début de la fenêtre de stabilité");
  console.log(
    `Observation pendant ${seconds} s ; ne pas ouvrir les mêmes ports dans un autre processus.`,
  );
  const { setTimeout } = await import("node:timers/promises");
  try {
    await setTimeout(seconds * 1000, undefined, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    interrupted = true;
  }
  const diagnostics = transport.diagnostics();
  recorder.append({ type: "diagnostics", data: diagnostics });
  console.log(
    JSON.stringify(
      {
        requestedBoards: paths.length,
        observationSeconds: seconds,
        interrupted,
        boards: diagnostics,
      },
      null,
      2,
    ),
  );
  if (
    interrupted ||
    diagnostics.length !== paths.length ||
    diagnostics.some((b) => !b.connected || b.timeouts || b.protocolErrors || b.consecutiveFailures)
  )
    process.exitCode = 1;
} finally {
  await transport.close();
  await recorder.stop();
  console.log(`Capture : ${recorder.path(recorder.status().id!)}`);
}
