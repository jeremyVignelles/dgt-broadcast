<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { LogicalTable } from "../../../../../src/domain/types.ts";
import { bestGrid } from "../../../layout.js";
import TableCard from "./TableCard.vue";

const tables = ref<LogicalTable[]>([]);
const offline = ref(false);
const grid = ref<HTMLElement>();
const size = ref({ width: 0, height: 0 });
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | undefined;
let disposed = false;

const visible = computed(() => tables.value.filter((table) => table.visible));
const gridStyle = computed(() => {
  const { columns, rows } = bestGrid(visible.value.length, size.value.width, size.value.height);
  return {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  };
});

function connect() {
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/stream`,
  );
  socket.onopen = () => (offline.value = false);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "projection") tables.value = message.tables;
  };
  socket.onclose = () => {
    if (disposed) return;
    offline.value = true;
    retry = setTimeout(connect, 2000);
  };
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "f" || event.key === "F") void document.documentElement.requestFullscreen();
}
function onDblClick() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    size.value = { width: grid.value!.clientWidth, height: grid.value!.clientHeight };
  });
  observer.observe(grid.value!);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("dblclick", onDblClick);
  connect();
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(retry);
  socket?.close();
  observer?.disconnect();
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("dblclick", onDblClick);
});
</script>

<template>
  <main ref="grid" id="grid" :style="visible.length ? gridStyle : undefined">
    <div v-for="table in visible" :key="table.id" class="cell">
      <TableCard :table="table" />
    </div>
    <div v-if="!visible.length" class="empty">Aucun échiquier à afficher</div>
  </main>
  <div v-if="offline" id="offline">Connexion perdue…</div>
</template>
