<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ConnectionStatus, LogicalTable } from "../../../../src/domain/types.ts";
import { formatClock, parseFen } from "../../board.js";
import Simulator from "./Simulator.vue";

type Device = {
  id: string;
  name: string;
  source: "bluetooth" | "serial";
  path?: string;
  address?: string;
};
const tables = ref<LogicalTable[]>([]);
const path = ref(location.pathname.replace(/\/$/, "") || "/admin");
const error = ref("");
const notice = ref("");
const busy = ref(false);
const reconnecting = ref<number[]>([]);
const scanning = ref(false);
const devices = ref<Device[]>([]);
const chosen = ref<string[]>([]);
const label = ref("");
const streamOnline = ref(false);
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const selected = computed(() => tables.value.filter((table) => table.visible && table.physicalId));
const board = computed(() => {
  const match = path.value.match(/^\/admin\/boards\/(\d+)$/);
  return match ? selected.value.find((table) => table.id === Number(match[1])) : undefined;
});
const squares = computed(() => (board.value ? parseFen(board.value.game.fen) : []));
const statusLabels: Record<ConnectionStatus, string> = {
  connected: "Connecté",
  degraded: "Connexion instable",
  reconnecting: "Reconnexion en cours…",
  disconnected: "Déconnecté",
  associated: "En attente de connexion",
  discovered: "Découvert",
  enrolling: "Appairage en cours…",
};
function canReconnect(table: LogicalTable) {
  return !["connected", "degraded", "reconnecting", "enrolling"].includes(table.game.status);
}
async function reconnectBoard(table: LogicalTable) {
  if (reconnecting.value.includes(table.id)) return;
  reconnecting.value.push(table.id);
  error.value = "";
  try {
    await api("/api/boards/reconnect", { tableId: table.id });
  } catch (caught) {
    showError(caught);
  } finally {
    reconnecting.value = reconnecting.value.filter((id) => id !== table.id);
  }
}

function navigate(next: string) {
  history.pushState(null, "", next);
  path.value = next;
  error.value = "";
  notice.value = "";
  if (next === "/admin/add/physical") void scan();
}
function pop() {
  path.value = location.pathname.replace(/\/$/, "") || "/admin";
  if (board.value) label.value = board.value.label;
  if (path.value === "/admin/add/physical") void scan();
}
async function api<T>(url: string, data?: object): Promise<T> {
  const response = await fetch(url, {
    method: data === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Erreur HTTP ${response.status}`);
  return result as T;
}
function showError(caught: unknown) {
  error.value = caught instanceof Error ? caught.message : String(caught);
}
function connect() {
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/stream`,
  );
  socket.onopen = () => {
    streamOnline.value = true;
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "projection") tables.value = message.tables;
  };
  socket.onclose = () => {
    streamOnline.value = false;
    if (!disposed) reconnect = setTimeout(connect, 2000);
  };
}
async function scan() {
  if (scanning.value) return;
  scanning.value = true;
  error.value = "";
  chosen.value = [];
  const [bluetooth, serial] = await Promise.allSettled([
    api<{ boards: Device[]; errors: string[] }>("/api/discovery/scan", {}),
    api<Array<{ path: string; manufacturer?: string; friendlyName?: string }>>(
      "/api/dgt/serial/ports",
    ),
  ]);
  const found: Device[] = [];
  const errors: string[] = [];
  if (bluetooth.status === "fulfilled") {
    found.push(...bluetooth.value.boards);
    errors.push(...bluetooth.value.errors);
  } else errors.push(`Bluetooth : ${String(bluetooth.reason)}`);
  if (serial.status === "fulfilled") {
    found.push(
      ...serial.value.map((port) => ({
        id: `serial:${port.path}`,
        name: port.friendlyName || port.manufacturer || port.path,
        source: "serial" as const,
        path: port.path,
      })),
    );
  } else errors.push(`Ports série : ${String(serial.reason)}`);
  for (const table of tables.value.filter(
    (item) => !item.visible && item.kind === "physical" && item.physicalId,
  )) {
    const serialPath = table.serialPath;
    if (!serialPath && !table.physicalId!.startsWith("DGT_BT_")) continue;
    const id = serialPath ? `serial:${serialPath}` : table.physicalId!;
    if (!found.some((device) => device.id.toLowerCase() === id.toLowerCase())) {
      found.push({
        id,
        name: table.label,
        source: serialPath ? "serial" : "bluetooth",
        path: serialPath,
      });
    }
  }
  devices.value = found;
  error.value = errors.join(" · ");
  scanning.value = false;
}
function alreadySelected(device: Device) {
  return selected.value.some((table) =>
    device.source === "bluetooth"
      ? table.physicalId === device.id
      : table.serialPath?.toLowerCase() === device.path?.toLowerCase(),
  );
}
async function addVirtual() {
  busy.value = true;
  error.value = "";
  try {
    const table = await api<LogicalTable>("/api/boards/add", {
      kind: "virtual",
      label: "Échiquier virtuel",
    });
    label.value = table.label;
    navigate(`/admin/boards/${table.id}`);
  } catch (caught) {
    showError(caught);
  } finally {
    busy.value = false;
  }
}
async function addPhysical() {
  busy.value = true;
  error.value = "";
  const errors: string[] = [];
  let bluetoothAdded = false;
  for (const device of devices.value.filter((item) => chosen.value.includes(item.id))) {
    try {
      await api("/api/boards/add", {
        kind: "physical",
        label: device.name,
        ...(device.source === "serial" ? { path: device.path } : { physicalId: device.id }),
      });
      chosen.value = chosen.value.filter((id) => id !== device.id);
      if (device.source === "bluetooth") bluetoothAdded = true;
    } catch (caught) {
      errors.push(`${device.name} : ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  if (bluetoothAdded) {
    try {
      const result = await api<{ errors: string[] }>("/api/bluetooth/connect", {});
      errors.push(...result.errors);
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
  }
  busy.value = false;
  if (errors.length) error.value = errors.join(" · ");
  else navigate("/admin");
}
async function remove(table: LogicalTable) {
  if (
    !confirm(
      table.kind === "virtual"
        ? `Retirer et oublier « ${table.label} » ?`
        : `Détacher « ${table.label} » de la diffusion ?`,
    )
  )
    return;
  busy.value = true;
  try {
    await api("/api/boards/remove", { tableId: table.id });
  } catch (caught) {
    showError(caught);
  } finally {
    busy.value = false;
  }
}
async function rename() {
  if (!board.value) return;
  busy.value = true;
  try {
    await api("/api/boards/rename", { tableId: board.value.id, label: label.value });
    notice.value = "Libellé enregistré.";
    error.value = "";
  } catch (caught) {
    showError(caught);
  } finally {
    busy.value = false;
  }
}
function openBoard(table: LogicalTable) {
  label.value = table.label;
  navigate(`/admin/boards/${table.id}`);
}
onMounted(async () => {
  window.addEventListener("popstate", pop);
  try {
    const state = await api<{ tables: LogicalTable[] }>("/api/config");
    tables.value = state.tables;
    if (board.value) label.value = board.value.label;
    connect();
    if (path.value === "/admin/add/physical") void scan();
  } catch (caught) {
    showError(caught);
  }
});
onUnmounted(() => {
  disposed = true;
  if (reconnect) clearTimeout(reconnect);
  socket?.close();
  window.removeEventListener("popstate", pop);
});
</script>

<template>
  <div class="shell">
    <header>
      <a href="/admin" class="brand" @click.prevent="navigate('/admin')"
        >DGT <span>Broadcast</span></a
      >
      <nav>
        <a href="/debug">Diagnostic</a
        ><a href="/" target="_blank" rel="noopener">Ouvrir la diffusion ↗</a>
      </nav>
    </header>
    <main>
      <p v-if="!streamOnline" class="notice" role="status">Connexion au flux d'état en cours…</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <template v-if="path === '/admin'">
        <div class="heading">
          <div>
            <p class="eyebrow">DIFFUSION</p>
            <h1>Échiquiers sélectionnés</h1>
            <p>Choisissez les échiquiers à afficher et personnalisez leur libellé.</p>
          </div>
          <button @click="navigate('/admin/add')">Ajouter un échiquier</button>
        </div>
        <div v-if="!selected.length" class="empty">
          Aucun échiquier sélectionné. Ajoutez un échiquier pour commencer.
        </div>
        <div v-else class="cards">
          <article v-for="table in selected" :key="table.id" class="card">
            <button class="board-link" @click="openBoard(table)">
              <span class="card-title">{{ table.label }}</span>
              <span class="muted">{{
                table.kind === "virtual" ? "Échiquier virtuel" : table.physicalId
              }}</span>
              <span class="muted"
                >Batterie :
                {{
                  typeof table.game.battery === "number" ? `${table.game.battery} %` : "inconnue"
                }}</span
              >
            </button>
            <div class="connection-status" role="status">
              <button
                v-if="canReconnect(table)"
                class="broken reconnect"
                :disabled="reconnecting.includes(table.id) || !streamOnline"
                :aria-label="`Reconnecter ${table.label}`"
                :title="`Reconnecter ${table.label}`"
                @click="reconnectBoard(table)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1M3 3l18 18"
                  />
                </svg>
              </button>
              <span :class="`status-${table.game.status}`">{{
                statusLabels[table.game.status]
              }}</span>
            </div>
            <p v-if="table.game.retryScheduled" class="muted">
              Nouvelle tentative automatique prévue.
            </p>
            <p v-if="table.game.connectionError" class="connection-error" role="alert">
              {{ table.game.connectionError }}
            </p>
            <button class="secondary" :disabled="busy" @click="remove(table)">Détacher</button>
          </article>
        </div>
      </template>
      <template v-else-if="path === '/admin/add'">
        <button class="back" @click="navigate('/admin')">← Retour</button>
        <h1>Ajouter un échiquier</h1>
        <p>Choisissez le type d'échiquier.</p>
        <div class="choices">
          <button class="choice" @click="navigate('/admin/add/physical')">
            <strong>Échiquier physique</strong><span>Bluetooth ou USB</span></button
          ><button class="choice" :disabled="busy" @click="addVirtual">
            <strong>Échiquier virtuel</strong><span>Simulateur intégré</span>
          </button>
        </div>
      </template>
      <template v-else-if="path === '/admin/add/physical'">
        <button class="back" @click="navigate('/admin/add')">← Retour</button>
        <div class="heading">
          <div>
            <h1>Échiquiers physiques</h1>
            <p>
              Allumez et branchez les échiquiers. Les ports série listés ne sont pas nécessairement
              des échiquiers DGT.
            </p>
          </div>
          <button class="secondary" :disabled="scanning" @click="scan">Relancer le scan</button>
        </div>
        <p v-if="scanning" role="status">Recherche Bluetooth et USB en cours…</p>
        <p v-else-if="!devices.length" class="empty">Aucun périphérique détecté.</p>
        <div v-else class="device-list">
          <label v-for="device in devices" :key="device.id" class="device"
            ><input
              v-model="chosen"
              type="checkbox"
              :value="device.id"
              :disabled="alreadySelected(device)"
            /><span
              ><strong>{{ device.name }}</strong
              ><small
                >{{
                  device.source === "bluetooth"
                    ? `Bluetooth · ${device.address ?? ""}`
                    : `Port série · ${device.path}`
                }}
                {{ alreadySelected(device) ? " · Déjà sélectionné" : "" }}</small
              ></span
            ></label
          >
        </div>
        <button :disabled="busy || scanning || !chosen.length" @click="addPhysical">
          {{ busy ? "Connexion en cours…" : `Ajouter la sélection (${chosen.length})` }}
        </button>
      </template>
      <template v-else-if="board">
        <button class="back" @click="navigate('/admin')">← Échiquiers</button>
        <div class="heading">
          <div>
            <p class="eyebrow">
              {{ board.kind === "virtual" ? "ÉCHIQUIER VIRTUEL" : "ÉCHIQUIER PHYSIQUE" }}
            </p>
            <h1>{{ board.label }}</h1>
            <p>
              {{ statusLabels[board.game.status]
              }}<template v-if="board.game.status !== 'connected'">
                · Dernière position conservée</template
              >
            </p>
            <p v-if="board.game.retryScheduled">Nouvelle tentative automatique prévue.</p>
            <p v-if="board.game.connectionError" class="connection-error" role="alert">
              {{ board.game.connectionError }}
            </p>
            <button
              v-if="canReconnect(board)"
              class="secondary"
              :disabled="reconnecting.includes(board.id) || !streamOnline"
              @click="reconnectBoard(board)"
            >
              Reconnecter
            </button>
          </div>
        </div>
        <form class="rename" @submit.prevent="rename">
          <label>Libellé <input v-model="label" maxlength="100" required /></label
          ><button :disabled="busy">Enregistrer</button>
        </form>
        <Simulator v-if="board.kind === 'virtual'" :key="board.id" :table-id="board.id" />
        <div v-else class="physical-view">
          <div class="chessboard" aria-label="Dernière position de l'échiquier">
            <div
              v-for="(square, index) in squares"
              :key="index"
              class="square"
              :class="(Math.floor(index / 8) + index) % 2 ? 'dark' : 'light'"
            >
              <span v-if="square" :class="square.white ? 'white-piece' : 'black-piece'">{{
                square.glyph
              }}</span>
            </div>
          </div>
          <div>
            <h2>Position reçue</h2>
            <p>
              Blancs : {{ formatClock(board.game.whiteClock) }} · Noirs :
              {{ formatClock(board.game.blackClock) }}
            </p>
            <p>
              Batterie :
              {{ typeof board.game.battery === "number" ? `${board.game.battery} %` : "inconnue" }}
            </p>
          </div>
        </div>
      </template>
      <template v-else
        ><p>Échiquier ou page introuvable.</p>
        <button @click="navigate('/admin')">Retour à l'administration</button></template
      >
    </main>
  </div>
</template>
