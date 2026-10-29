import { escapeHtml, formatClock } from "./board.js";

const $ = (selector) => document.querySelector(selector);

const STATUS_LABELS = {
  connected: ["Connecté", "ok"],
  degraded: ["Instable", "warn"],
  reconnecting: ["Reconnexion", "warn"],
  disconnected: ["Déconnecté", "bad"],
  associated: ["Associé", "warn"],
  discovered: ["Découvert", "warn"],
  enrolling: ["Appairage", "warn"],
};

// Short scripted game used to exercise the display without a physical board.
const DEMO_GAME = [
  ["", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
  ["e2e4", "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"],
  ["e7e5", "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"],
  ["g1f3", "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"],
  ["b8c6", "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"],
  ["f1c4", "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"],
  ["f8c5", "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"],
  ["c2c3", "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R b KQkq - 0 4"],
];
const demoStep = new Map();

let tables = [];
let lastScan = [];

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Erreur");
  return data;
}

function report(error) {
  $("#scan-errors").innerHTML = `<li>${escapeHtml(error.message)}</li>`;
}

function renderTables() {
  $("#tables tbody").innerHTML = tables
    .map((t) => {
      const [label, cls] = STATUS_LABELS[t.game.status] ?? ["?", ""];
      const battery = typeof t.game.battery === "number" ? `${t.game.battery}%` : "?";
      return `<tr>
        <td>${escapeHtml(t.label)}</td>
        <td>${t.physicalId ? escapeHtml(t.physicalId) : '<span class="hint">—</span>'}</td>
        <td class="${cls}">${label}</td>
        <td>${battery}</td>
        <td><input type="checkbox" data-visible="${t.id}" ${t.visible ? "checked" : ""} /></td>
        <td>${t.game.clock?.connected ? `G ${formatClock(t.game.clock.left.seconds)} / D ${formatClock(t.game.clock.right.seconds)} · ${t.game.clock.running ? "marche" : "pause"}` : "Pendule absente / inconnue"}${t.game.result ? ` · ${escapeHtml(t.game.result)}` : ""}${t.game.resultStatus === "conflicting" ? " · Résultats contradictoires" : ""}${t.game.positionStatus === "unresolved" ? " · Position non reconstruite" : ""}</td>
        <td>${t.physicalId ? `<button class="secondary" data-new-game="${t.id}">Nouvelle partie</button> <button class="secondary" data-refresh="${t.id}">Relire les données</button> <button class="secondary" data-history="${t.id}">Historique</button> <button class="secondary" data-disconnect="${t.id}">Déconnecter</button> <button class="secondary" data-dissociate="${t.id}">Dissocier</button>` : ""}</td>
      </tr>`;
    })
    .join("");
}

function renderSimulator() {
  $("#simulator tbody").innerHTML = tables
    .map((t) => {
      const options = Object.entries(STATUS_LABELS)
        .map(
          ([value, [label]]) =>
            `<option value="${value}" ${t.game.status === value ? "selected" : ""}>${label}</option>`,
        )
        .join("");
      return `<tr>
        <td>${escapeHtml(t.label)}</td>
        <td><select data-sim-status="${t.id}">${options}</select></td>
        <td><input type="number" min="0" max="100" value="${t.game.battery ?? ""}" data-sim-battery="${t.id}" /></td>
        <td>
          <button class="secondary" data-sim-next="${t.id}">Coup suivant</button>
          <button class="secondary" data-sim-reset="${t.id}">Réinitialiser</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderDiscovered() {
  const body = $("#discovered tbody");
  if (lastScan.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Aucun échiquier trouvé.</td></tr>';
    return;
  }
  const tableOptions = tables
    .map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`)
    .join("");
  const chosen = new Map(
    [...body.querySelectorAll("select[data-target]")].map((s) => [s.dataset.target, s.value]),
  );
  body.innerHTML = lastScan
    .map((b) => {
      const current = tables.find((t) => t.physicalId === b.id);
      return `<tr>
        <td>${escapeHtml(b.name)}</td>
        <td>${escapeHtml(b.address ?? "—")}</td>
        <td>${b.source === "bluetooth" ? "Bluetooth" : "Simulateur"}</td>
        <td>
          <select data-target="${escapeHtml(b.id)}">${tableOptions}</select>
          <button data-associate="${escapeHtml(b.id)}">Associer</button>
          ${current ? `<span class="ok">→ ${escapeHtml(current.label)}</span>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  for (const b of lastScan) {
    const current = tables.find((t) => t.physicalId === b.id);
    const value = chosen.get(b.id) ?? (current ? String(current.id) : undefined);
    if (value) body.querySelector(`[data-target="${b.id}"]`).value = value;
  }
}

function setState(state) {
  tables = state.tables;
  renderTables();
  renderSimulator();
}

$("#scan").onclick = async () => {
  const button = $("#scan");
  button.disabled = true;
  $("#scan-errors").innerHTML = "";
  $("#scan-status").textContent = "Scan en cours (≈ 8 s)…";
  try {
    const result = await api("/api/discovery/scan", {});
    lastScan = result.boards;
    $("#scan-errors").innerHTML = result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    const bluetooth = lastScan.filter((b) => b.source === "bluetooth").length;
    $("#scan-status").textContent = `${bluetooth} échiquier(s) Bluetooth trouvé(s)`;
    renderDiscovered();
  } catch (error) {
    $("#scan-status").textContent = "";
    report(error);
  } finally {
    button.disabled = false;
  }
};

$("#connect").onclick = async () => {
  const button = $("#connect");
  button.disabled = true;
  $("#scan-errors").innerHTML = "";
  $("#connect-status").textContent =
    "Appairage puis liaison… validez la demande de mot de passe si elle apparaît.";
  try {
    const result = await api("/api/bluetooth/connect", {});
    $("#connect-status").textContent =
      result.boards.length === 0
        ? "Aucun échiquier Bluetooth associé."
        : result.boards
            .map((b) => `Table ${b.tableId} → ${b.device}${b.paired ? "" : " (non appairé)"}`)
            .join(", ");
    $("#scan-errors").innerHTML = result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
  } catch (error) {
    $("#connect-status").textContent = "";
    report(error);
  } finally {
    button.disabled = false;
  }
};

document.addEventListener("click", async (event) => {
  const { dataset } = event.target;
  try {
    if (dataset.associate) {
      const select = document.querySelector(`[data-target="${dataset.associate}"]`);
      await api("/api/tables/associate", {
        tableId: Number(select.value),
        physicalId: dataset.associate,
      });
    } else if (dataset.dissociate) {
      await api("/api/tables/dissociate", { tableId: Number(dataset.dissociate) });
    } else if (dataset.disconnect) {
      await api("/api/dgt/disconnect", { tableId: Number(dataset.disconnect) });
    } else if (dataset.newGame) {
      await api("/api/dgt/new-game", { tableId: Number(dataset.newGame) });
    } else if (dataset.refresh) {
      event.target.disabled = true;
      try {
        await api("/api/dgt/refresh", { tableId: Number(dataset.refresh) });
      } finally {
        event.target.disabled = false;
      }
    } else if (dataset.history) {
      const history = await api("/api/dgt/history", { tableId: Number(dataset.history) });
      if (history.warnings?.length) report(new Error(history.warnings.join(" ; ")));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(history, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `dgt-history-table-${dataset.history}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (dataset.simNext || dataset.simReset) {
      const id = Number(dataset.simNext ?? dataset.simReset);
      const step = dataset.simReset ? 0 : ((demoStep.get(id) ?? 0) + 1) % DEMO_GAME.length;
      demoStep.set(id, step);
      await api("/api/simulator/move", {
        tableId: id,
        lastMove: DEMO_GAME[step][0],
        fen: DEMO_GAME[step][1],
      });
    }
  } catch (error) {
    report(error);
  }
});

document.addEventListener("change", async (event) => {
  const { dataset, checked, value } = event.target;
  try {
    if (dataset.visible) {
      await api("/api/tables/visibility", { tableId: Number(dataset.visible), visible: checked });
    } else if (dataset.simStatus) {
      await api("/api/simulator/status", { tableId: Number(dataset.simStatus), status: value });
    } else if (dataset.simBattery) {
      const t = tables.find((x) => x.id === Number(dataset.simBattery));
      await api("/api/simulator/status", {
        tableId: t.id,
        status: t.game.status,
        battery: Number(value),
      });
    }
  } catch (error) {
    report(error);
  }
});

$("#add-tables").onclick = async () => {
  try {
    await api("/api/tables/count", { count: Number($("#table-count").value) });
  } catch (error) {
    report(error);
  }
};
$("#serial-list").onclick = async () => {
  try {
    $("#serial-ports").textContent = JSON.stringify(await api("/api/dgt/serial/ports"), null, 2);
  } catch (error) {
    report(error);
  }
};
$("#serial-connect").onclick = async () => {
  const button = $("#serial-connect");
  button.disabled = true;
  try {
    await api("/api/dgt/serial/connect", {
      tableId: Number($("#serial-table").value),
      path: $("#serial-path").value,
    });
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};

let captureSteps = [];
async function protocolEvent(event) {
  try {
    await api("/api/dgt/simulator/event", {
      tableId: Number($("#protocol-table").value),
      ...event,
    });
  } catch (error) {
    report(error);
  }
}
$("#protocol-connect").onclick = async () => {
  const button = $("#protocol-connect");
  button.disabled = true;
  try {
    await api("/api/dgt/simulator/connect", { tableId: Number($("#protocol-table").value) });
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};
$("#protocol-change").onclick = () =>
  protocolEvent({
    kind: "square",
    square: $("#protocol-square").value,
    code: Number($("#protocol-piece").value),
  });
$("#protocol-fault").onclick = () => protocolEvent({ kind: "fault" });
$("#protocol-clock").onclick = () =>
  protocolEvent({
    kind: "clock",
    leftSeconds: Number($("#protocol-left").value),
    rightSeconds: Number($("#protocol-right").value),
    running: $("#protocol-running").checked,
    activeSide: $("#protocol-active").value,
    connected: $("#protocol-clock-connected").checked,
  });
$("#protocol-battery-send").onclick = () =>
  protocolEvent({ kind: "battery", percent: Number($("#protocol-battery").value) });
let captureStep = 0;
function renderCaptureStep() {
  $("#capture-instruction").textContent =
    `${captureStep + 1}/${captureSteps.length} — ${captureSteps[captureStep] ?? ""}`;
}
function renderRecording(recording) {
  $("#capture-status").textContent = recording.error
    ? `ÉCHEC : ${recording.error}`
    : `${recording.active ? "Enregistrement en cours" : "Arrêté"} · ${recording.rows} lignes`;
  $("#capture-start").disabled = recording.open;
  $("#capture-stop").disabled = !recording.open;
}
async function loadRecordings() {
  const data = await api("/api/dgt/recordings");
  captureSteps = data.steps;
  renderCaptureStep();
  renderRecording(data.recording);
  $("#capture-files").innerHTML = data.sessions
    .map(
      (id) =>
        `<li><a href="/api/dgt/recordings/${encodeURIComponent(id)}.jsonl">Télécharger ${escapeHtml(id)}</a></li>`,
    )
    .join("");
}
$("#capture-start").onclick = async () => {
  try {
    $("#capture-start").disabled = true;
    const data = await api("/api/dgt/recordings/start", {});
    captureStep = 0;
    if (data.warnings.length) report(new Error(data.warnings.join(" ; ")));
    await loadRecordings();
  } catch (error) {
    report(error);
    $("#capture-start").disabled = false;
  }
};
$("#capture-stop").onclick = async () => {
  try {
    await api("/api/dgt/recordings/stop", {});
    await loadRecordings();
  } catch (error) {
    report(error);
  }
};
$("#capture-next").onclick = async () => {
  try {
    await api("/api/dgt/recordings/mark", {
      label: `Début étape ${captureStep + 1} : ${captureSteps[captureStep]}`,
    });
    $("#capture-instruction").textContent =
      `Étape marquée. ${captureSteps[captureStep]} Cliquez sur « Étape suivante » après l'action.`;
  } catch (error) {
    report(error);
  }
};
$("#capture-skip").onclick = async () => {
  try {
    await api("/api/dgt/recordings/mark", { label: `Fin / passage de l'étape ${captureStep + 1}` });
    captureStep = Math.min(captureStep + 1, captureSteps.length - 1);
    renderCaptureStep();
  } catch (error) {
    report(error);
  }
};
$("#capture-mark").onclick = async () => {
  try {
    await api("/api/dgt/recordings/mark", { label: $("#capture-marker").value });
    $("#capture-marker").value = "";
  } catch (error) {
    report(error);
  }
};
let diagnosticsPending = false;
async function refreshDiagnostics() {
  if (diagnosticsPending) return;
  diagnosticsPending = true;
  try {
    const data = await api("/api/dgt/diagnostics");
    renderRecording(data.recording);
    $("#diagnostic-summary").textContent =
      `${data.boards.filter((b) => b.connected).length}/${data.boards.length} liaisons ouvertes.`;
    $("#diagnostics tbody").innerHTML = data.boards
      .map(
        (b) => `<tr>
      <td>${b.tableId} · ${escapeHtml(b.path)}</td>
      <td>${escapeHtml(b.serial ?? "?")} / v${escapeHtml(b.version ?? "?")}</td>
      <td>${b.connected ? "Ouverte" : "Fermée"} · batterie ${escapeHtml({ unknown: "inconnue", available: "reçue", unresponsive: "sans réponse, nouvelle tentative périodique" }[b.batteryStatus])}<br>Dernière mesure : ${escapeHtml(b.lastBatteryReceivedAt ?? "jamais")}<br>Dernière tentative : ${escapeHtml(b.lastBatteryAttemptAt ?? "jamais")}</td>
      <td>${escapeHtml(b.lastPositionAt ?? "Jamais")}</td>
      <td>${b.messages} / ${b.rxBytes}</td>
      <td>${b.lastResponseMs ?? "?"} / ${b.maxResponseMs}</td>
      <td>${b.timeouts} / ${b.protocolErrors} · ${b.retries ?? 0} relances</td>
      <td>${escapeHtml(b.lastError ?? "")}</td></tr>`,
      )
      .join("");
  } catch (error) {
    report(error);
  } finally {
    diagnosticsPending = false;
  }
}

function connect() {
  const socket = new WebSocket(`ws://${location.host}/api/stream`);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "projection") return;
    setState(message);
    if (lastScan.length) renderDiscovered();
  };
  socket.onclose = () => setTimeout(connect, 2000);
}

setState(await api("/api/config"));
renderDiscovered();
connect();
try {
  await loadRecordings();
  await refreshDiagnostics();
} catch (error) {
  report(error);
}
setInterval(() => void refreshDiagnostics(), 2000);
