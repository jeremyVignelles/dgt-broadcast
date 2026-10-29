import { escapeHtml } from "./board.js";

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
        <td>${t.physicalId ? `<button class="secondary" data-dissociate="${t.id}">Dissocier</button>` : ""}</td>
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
