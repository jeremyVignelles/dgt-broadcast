import { bestGrid } from "./layout.js";
import {
  escapeHtml,
  formatClock,
  lastMoveSquares,
  parseFen,
  sideToMove,
  squareName,
} from "./board.js";

const grid = document.getElementById("grid");
const offline = document.getElementById("offline");

const STATUS = {
  connected: { level: "ok" },
  degraded: { level: "warn", text: "Connexion instable" },
  reconnecting: { level: "warn", text: "Reconnexion…" },
  disconnected: { level: "off", text: "Déconnecté" },
  associated: { level: "off", text: "En attente" },
  discovered: { level: "off", text: "En attente" },
  enrolling: { level: "off", text: "Appairage…" },
};
const LOW_BATTERY = 20;

let tables = [];
let renderedIds = "";
const cache = new Map();

function playerHtml(player, fallback) {
  const elo = player?.elo ? `<span class="elo">${escapeHtml(player.elo)}</span>` : "";
  return `<span class="name">${escapeHtml(player?.name ?? fallback)}</span>${elo}`;
}

function batteryHtml(battery) {
  if (typeof battery !== "number") return '<span class="badge unknown">🔋 ?</span>';
  if (battery < LOW_BATTERY) return `<span class="badge low">🪫 ${battery}%</span>`;
  return `<span class="badge good">🔋 ${battery}%</span>`;
}

function boardHtml(game) {
  const highlighted = new Set(lastMoveSquares(game.lastMove));
  return parseFen(game.fen)
    .map((square, i) => {
      const color = (Math.floor(i / 8) + i) % 2 ? "dark" : "light";
      const last = highlighted.has(squareName(i)) ? " last" : "";
      const piece = square
        ? `<span class="piece ${square.white ? "w" : "b"}">${square.glyph}</span>`
        : "";
      return `<div class="sq ${color}${last}">${piece}</div>`;
    })
    .join("");
}

function tableHtml(table) {
  const game = table.game;
  const status = STATUS[game.status] ?? STATUS.disconnected;
  const turn = game.clock
    ? game.clock.connected && game.clock.running && game.whiteClockSide && game.clock.activeSide
      ? game.clock.activeSide === game.whiteClockSide
        ? "white"
        : "black"
      : undefined
    : game.positionStatus === "unresolved"
      ? undefined
      : sideToMove(game.fen);
  const clock = (side, value) =>
    `<span class="clock${status.level === "ok" && turn === side ? " active" : ""}">${formatClock(value)}</span>`;
  const overlay = status.text ? `<div class="overlay">${status.text}</div>` : "";
  return `<div class="table ${status.level}">
    <div class="strip"><span class="num">${escapeHtml(table.id)}</span>${playerHtml(game.black, "Noir")}${clock("black", game.blackClock)}</div>
    <div class="board">${boardHtml(game)}${overlay}</div>
    <div class="strip">${playerHtml(game.white, "Blanc")}${game.result ? `<span class="badge">${escapeHtml(game.result)}</span>` : ""}${batteryHtml(game.battery)}${clock("white", game.whiteClock)}</div>
  </div>`;
}

function layout() {
  const { columns, rows } = bestGrid(tables.length, grid.clientWidth, grid.clientHeight);
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
}

function render() {
  tables = tables.filter((t) => t.visible);
  if (tables.length === 0) {
    grid.innerHTML = '<div class="empty">Aucun échiquier à afficher</div>';
    grid.style.gridTemplateColumns = grid.style.gridTemplateRows = "1fr";
    renderedIds = "";
    cache.clear();
    return;
  }
  const ids = tables.map((t) => t.id).join(",");
  if (ids !== renderedIds) {
    grid.innerHTML = tables.map((t) => `<div class="cell" data-id="${t.id}"></div>`).join("");
    renderedIds = ids;
    cache.clear();
  }
  for (const table of tables) {
    const html = tableHtml(table);
    if (cache.get(table.id) === html) continue;
    cache.set(table.id, html);
    grid.querySelector(`[data-id="${table.id}"]`).innerHTML = html;
  }
  layout();
}

function connect() {
  const socket = new WebSocket(`ws://${location.host}/api/stream`);
  socket.onopen = () => (offline.hidden = true);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "projection") return;
    tables = message.tables;
    render();
  };
  socket.onclose = () => {
    offline.hidden = false;
    setTimeout(connect, 2000);
  };
}

window.addEventListener("resize", layout);
document.addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "f" || event.key === "F") document.documentElement.requestFullscreen();
});
connect();
