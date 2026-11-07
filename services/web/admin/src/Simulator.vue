<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

type Color = "white" | "black";
type Role = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";
type Piece = { color: Color; role: Role };
const props = defineProps<{ tableId: number }>();
type Projection = {
  tables: Array<{
    id: number;
    game: {
      fen: string;
      battery?: number;
      clock?: {
        connected: boolean;
        running: boolean;
        activeSide?: "left" | "right";
        left: { seconds: number };
        right: { seconds: number };
      };
    };
  }>;
};
type DragSource = { kind: "square"; square: string } | { kind: "palette"; piece: Piece };
type SimEvent =
  | { kind: "position"; codes: number[] }
  | {
      kind: "clock";
      leftSeconds: number;
      rightSeconds: number;
      running: boolean;
      activeSide: "left" | "right";
      connected: boolean;
    }
  | { kind: "battery"; percent: number };

const glyphs: Record<Color, Record<Role, string>> = {
  white: { king: "♔", queen: "♕", rook: "♖", bishop: "♗", knight: "♘", pawn: "♙" },
  black: { king: "♚", queen: "♛", rook: "♜", bishop: "♝", knight: "♞", pawn: "♟" },
};
const roles: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];
const colors: Color[] = ["white", "black"];
const pieceCode: Record<Color, Record<Role, number>> = {
  white: { pawn: 1, rook: 2, knight: 3, bishop: 4, king: 5, queen: 6 },
  black: { pawn: 7, rook: 8, knight: 9, bishop: 10, king: 11, queen: 12 },
};

const connected = ref(false);
const status = ref("Connexion au serveur…");
const error = ref("");
const pieces = reactive<Record<string, Piece | null>>({});
const dragSource = ref<DragSource>();
const clockEnabled = ref(true);
const running = ref(false);
const activeSide = ref<Color>("white");
const seconds = reactive<Record<Color, number>>({ white: 600, black: 600 });
const fields = reactive<Record<Color, { hours: number; minutes: number; seconds: number }>>({
  white: { hours: 0, minutes: 10, seconds: 0 },
  black: { hours: 0, minutes: 10, seconds: 0 },
});
const battery = ref(85);
const gameFen = ref("");

let simSocket: WebSocket | undefined;
let streamSocket: WebSocket | undefined;
let lastClockSend = 0;
let lastBattery = 85;
let lastPosition = "";
let messageQueue = Promise.resolve();
let clockFieldsInitialized = false;

const squareNames = Array.from(
  { length: 64 },
  (_, i) => `${String.fromCharCode(97 + (i % 8))}${8 - Math.floor(i / 8)}`,
);
const boardRows = Array.from({ length: 8 }, (_, row) => squareNames.slice(row * 8, row * 8 + 8));
const formatted = computed(() => ({
  white: formatTime(seconds.white),
  black: formatTime(seconds.black),
}));

function formatTime(total: number): string {
  const clamped = Math.max(0, Math.floor(total));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function fenPieces(fen: string) {
  const [placement = ""] = fen.split(" ");
  const rows = placement.split("/");
  const next = Object.fromEntries(squareNames.map((square) => [square, null])) as Record<
    string,
    Piece | null
  >;
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const token of rows[rank] ?? "") {
      if (/\d/.test(token)) {
        file += Number(token);
        continue;
      }
      const piece = "kqrbnp".includes(token.toLowerCase())
        ? ({
            role: (
              { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" } as const
            )[token.toLowerCase() as "k" | "q" | "r" | "b" | "n" | "p"],
            color: token === token.toUpperCase() ? "white" : "black",
          } satisfies Piece)
        : null;
      next[`${String.fromCharCode(97 + file)}${8 - rank}`] = piece;
      file++;
    }
  }
  return next;
}

function importFen(fen: string) {
  Object.assign(pieces, fenPieces(fen));
}

function codeAt(square: string) {
  const piece = pieces[square];
  return piece ? pieceCode[piece.color][piece.role] : 0;
}

function send(event: SimEvent) {
  if (!simSocket || simSocket.readyState !== WebSocket.OPEN) return;
  messageQueue = messageQueue.then(() => {
    if (simSocket?.readyState === WebSocket.OPEN) simSocket.send(JSON.stringify(event));
  });
}

function sendClock(force = false) {
  const now = performance.now();
  if (!force && now - lastClockSend < 900) return;
  lastClockSend = now;
  send({
    kind: "clock",
    leftSeconds: seconds.white,
    rightSeconds: seconds.black,
    running: clockEnabled.value && running.value,
    activeSide: activeSide.value === "white" ? "left" : "right",
    connected: clockEnabled.value,
  });
}

function setClockFromFields(color: Color) {
  const value = fields[color];
  value.hours = clampInteger(value.hours, 0, 9);
  value.minutes = clampInteger(value.minutes, 0, 59);
  value.seconds = clampInteger(value.seconds, 0, 59);
  seconds[color] = value.hours * 3600 + value.minutes * 60 + value.seconds;
  sendClock(true);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(Number(value) || 0)));
}

function togglePlay() {
  if (!clockEnabled.value) return;
  if (!running.value && seconds[activeSide.value] === 0) return;
  running.value = !running.value;
  sendClock(true);
}

function pressClock(color: Color) {
  activeSide.value = color === "white" ? "black" : "white";
  running.value = true;
  sendClock(true);
}

function onClockToggle() {
  if (!clockEnabled.value) running.value = false;
  sendClock(true);
}

function setBattery() {
  battery.value = clampInteger(battery.value, 0, 100);
  if (battery.value !== lastBattery) {
    lastBattery = battery.value;
    send({ kind: "battery", percent: battery.value });
  }
}

function setDrag(source: DragSource, event: DragEvent) {
  dragSource.value = source;
  event.dataTransfer?.setData("text/plain", "dgt-piece");
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function dropOn(square: string) {
  const source = dragSource.value;
  if (!source) return;
  const piece = source.kind === "palette" ? source.piece : pieces[source.square];
  if (!piece) return;
  if (source.kind === "square" && source.square !== square) pieces[source.square] = null;
  pieces[square] = piece;
  sendPosition();
  dragSource.value = undefined;
}

function dropOutside() {
  const source = dragSource.value;
  if (source?.kind === "square") {
    pieces[source.square] = null;
    sendPosition();
  }
  dragSource.value = undefined;
}

function sendPosition(force = false) {
  const position = squareNames.map((square) => codeAt(square)).join(",");
  if (!force && position === lastPosition) return;
  lastPosition = position;
  send({ kind: "position", codes: squareNames.map((square) => codeAt(square)) });
}

function connect() {
  if (simSocket && simSocket.readyState <= WebSocket.OPEN) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/dgt/simulator/${props.tableId}`);
  simSocket = socket;
  status.value = "Connexion de l’échiquier simulé…";
  socket.onopen = () => {
    if (simSocket !== socket) return;
    status.value = "Initialisation de l’échiquier…";
  };
  socket.onmessage = (event) => {
    if (simSocket !== socket) return;
    const message = JSON.parse(event.data);
    if (message.type === "error") {
      error.value = message.error;
      status.value = "Connexion refusée";
      return;
    }
    if (message.type === "ready") {
      connected.value = true;
      status.value = "Échiquier connecté";
      error.value = "";
    }
  };
  socket.onclose = () => {
    if (simSocket !== socket) return;
    connected.value = false;
    status.value = "Échiquier déconnecté";
  };
  socket.onerror = () => {
    if (simSocket !== socket) return;
    error.value = "Connexion au simulateur impossible.";
  };
}

function connectProjection() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  streamSocket = new WebSocket(`${protocol}//${location.host}/api/stream`);
  streamSocket.onmessage = (event) => {
    const message = JSON.parse(event.data) as Projection & { type: string };
    if (message.type !== "projection") return;
    const table = message.tables.find((candidate) => candidate.id === props.tableId);
    if (!table) return;
    if (table.game.fen && table.game.fen !== gameFen.value) {
      gameFen.value = table.game.fen;
      importFen(gameFen.value);
    }
    if (typeof table.game.battery === "number") {
      battery.value = table.game.battery;
      lastBattery = battery.value;
    }
    if (table.game.clock) {
      const clock = table.game.clock;
      clockEnabled.value = clock.connected;
      running.value = clock.running;
      activeSide.value = clock.activeSide === "right" ? "black" : "white";
      seconds.white = clock.left.seconds;
      seconds.black = clock.right.seconds;
      if (!clockFieldsInitialized) {
        for (const color of colors) {
          fields[color].hours = Math.floor(seconds[color] / 3600);
          fields[color].minutes = Math.floor((seconds[color] % 3600) / 60);
          fields[color].seconds = seconds[color] % 60;
        }
        clockFieldsInitialized = true;
      }
    }
  };
  streamSocket.onclose = () => {
    if (connected.value) {
      error.value = "Flux d’état interrompu.";
    }
  };
}

onMounted(() => {
  importFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  connectProjection();
  connect();
});
onUnmounted(() => {
  simSocket?.close();
  streamSocket?.close();
});
</script>

<template>
  <div class="simulator-shell" @dragover.prevent @drop="dropOutside">
    <div class="topbar">
      <div class="connection" :class="{ online: connected }">
        <span class="connection-dot"></span>
        {{ status }}
      </div>
    </div>

    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>

    <section class="workbench">
      <div class="board-column">
        <div class="section-heading">
          <div>
            <p class="eyebrow">SIMULATEUR PROTOCOLAIRE</p>
            <h1>Échiquier</h1>
          </div>
          <span class="hint"
            >Glisser une pièce pour la déplacer · hors du plateau pour la retirer</span
          >
        </div>
        <div class="board-layout">
          <div class="rank-labels" aria-hidden="true">
            <span v-for="rank in 8" :key="rank">{{ 9 - rank }}</span>
          </div>
          <div class="board-frame">
            <div class="simulator-board">
              <div v-for="(row, rowIndex) in boardRows" :key="rowIndex" class="board-row">
                <div
                  v-for="square in row"
                  :key="square"
                  class="square"
                  :class="[
                    (square.charCodeAt(0) - 97 + Number(square[1])) % 2 ? 'dark' : 'light',
                    { 'drag-target': dragSource },
                  ]"
                  @dragover.prevent
                  @drop.stop.prevent="dropOn(square)"
                >
                  <span
                    v-if="pieces[square]"
                    class="board-piece"
                    :class="pieces[square]?.color"
                    :draggable="connected"
                    @dragstart="setDrag({ kind: 'square', square }, $event)"
                    @dragend="dragSource = undefined"
                    >{{ glyphs[pieces[square]!.color][pieces[square]!.role] }}</span
                  >
                  <small v-if="rowIndex === 7" class="file-label">{{ square[0] }}</small>
                </div>
              </div>
            </div>
          </div>
          <div class="rank-labels" aria-hidden="true">
            <span v-for="rank in 8" :key="rank">{{ 9 - rank }}</span>
          </div>
        </div>
        <div class="palette-panel">
          <div class="palette-title">
            <h2>Pièces</h2>
            <span>À déposer sur une case</span>
          </div>
          <div v-for="color in colors" :key="color" class="piece-row">
            <span class="color-label">{{ color === "white" ? "Blancs" : "Noirs" }}</span>
            <button
              v-for="role in roles"
              :key="role"
              class="palette-piece"
              :class="color"
              :aria-label="`${role} ${color}`"
              :draggable="connected"
              @dragstart="setDrag({ kind: 'palette', piece: { color, role } }, $event)"
              @dragend="dragSource = undefined"
            >
              {{ glyphs[color][role] }}
            </button>
          </div>
        </div>
      </div>

      <aside class="controls-column">
        <section class="card clock-card">
          <div class="card-heading">
            <div>
              <p class="eyebrow">TEMPS DE JEU</p>
              <h2>Pendule</h2>
            </div>
            <label class="switch" title="Activer ou désactiver la pendule">
              <input v-model="clockEnabled" type="checkbox" @change="onClockToggle" />
              <span class="switch-track"></span>
            </label>
          </div>
          <div class="clocks" :class="{ disabled: !clockEnabled }">
            <button
              class="clock-side white-side"
              :class="{ active: running && activeSide === 'white' }"
              :disabled="!clockEnabled"
              @click="pressClock('white')"
            >
              <span class="clock-color">BLANCS</span>
              <strong>{{ formatted.white }}</strong>
              <span class="clock-hint">{{
                activeSide === "white" && running ? "EN COURS" : "APPUYER"
              }}</span>
            </button>
            <button
              class="clock-side black-side"
              :class="{ active: running && activeSide === 'black' }"
              :disabled="!clockEnabled"
              @click="pressClock('black')"
            >
              <span class="clock-color">NOIRS</span>
              <strong>{{ formatted.black }}</strong>
              <span class="clock-hint">{{
                activeSide === "black" && running ? "EN COURS" : "APPUYER"
              }}</span>
            </button>
          </div>
          <div class="clock-setup">
            <span class="setup-label">Régler le temps</span>
            <div v-for="color in colors" :key="color" class="time-fields">
              <span>{{ color === "white" ? "Blancs" : "Noirs" }}</span>
              <label
                ><input
                  v-model.number="fields[color].hours"
                  type="number"
                  min="0"
                  max="9"
                  @change="setClockFromFields(color)"
                />
                h</label
              >
              <label
                ><input
                  v-model.number="fields[color].minutes"
                  type="number"
                  min="0"
                  max="59"
                  @change="setClockFromFields(color)"
                />
                m</label
              >
              <label
                ><input
                  v-model.number="fields[color].seconds"
                  type="number"
                  min="0"
                  max="59"
                  @change="setClockFromFields(color)"
                />
                s</label
              >
            </div>
          </div>
          <button
            class="play-button"
            :class="{ playing: running }"
            :disabled="!clockEnabled"
            @click="togglePlay"
          >
            <span>{{ running ? "Ⅱ" : "▶" }}</span>
            {{ running ? "Pause" : "Démarrer" }}
          </button>
        </section>

        <section class="card battery-card">
          <div class="card-heading">
            <div>
              <p class="eyebrow">ÉCHIQUIER SIMULÉ</p>
              <h2>Batterie</h2>
            </div>
            <span class="battery-value">{{ battery }}<small>%</small></span>
          </div>
          <label class="range-label">
            <span>Niveau de charge</span>
            <input v-model.number="battery" type="range" min="0" max="100" @input="setBattery" />
          </label>
          <label class="battery-entry">
            <span>Pourcentage</span>
            <input v-model.number="battery" type="number" min="0" max="100" @change="setBattery" />
          </label>
        </section>

        <section class="card note-card">
          <span class="note-icon">↗</span>
          <p>Le simulateur utilise le décodeur DGT et reste actif lorsque cette page est fermée.</p>
        </section>
      </aside>
    </section>
  </div>
</template>

<style scoped src="./simulator.css"></style>
