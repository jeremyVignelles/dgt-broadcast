<script setup lang="ts">
import { computed } from "vue";
import type { LogicalTable } from "../../../../../src/domain/types.ts";
import { formatClock, sideToMove } from "../../../board.js";
import ChessBoard from "../components/ChessBoard.vue";

const props = defineProps<{ table: LogicalTable }>();

const STATUS: Record<string, { level: string; text?: string }> = {
  connected: { level: "ok" },
  degraded: { level: "warn", text: "Connexion instable" },
  reconnecting: { level: "warn", text: "Reconnexion…" },
  disconnected: { level: "off", text: "Déconnecté" },
  associated: { level: "off", text: "En attente" },
  discovered: { level: "off", text: "En attente" },
  enrolling: { level: "off", text: "Appairage…" },
};

const game = computed(() => props.table.game);
const status = computed(() => STATUS[game.value.status] ?? STATUS.disconnected!);
const turn = computed(() => {
  const { clock, positionStatus, fen } = game.value;
  if (clock) {
    return clock.connected && clock.running && clock.activeSide
      ? clock.activeSide === "left"
        ? "white"
        : "black"
      : undefined;
  }
  return positionStatus === "unresolved" ? undefined : sideToMove(fen);
});
const isActive = (side: "white" | "black") => status.value.level === "ok" && turn.value === side;
</script>

<template>
  <div class="table" :class="status.level">
    <div class="strip">
      <span class="num">{{ table.label }}</span>
      <span v-if="status.text" class="link-status" :title="status.text" :aria-label="status.text">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1M3 3l18 18"
          />
        </svg>
      </span>
      <span class="name">{{ game.black?.name ?? "Noir" }}</span>
      <span v-if="game.black?.elo" class="elo">{{ game.black.elo }}</span>
      <span class="clock" :class="{ active: isActive('black') }">{{
        formatClock(game.blackClock)
      }}</span>
    </div>
    <div class="board">
      <ChessBoard :fen="game.fen" :last-move="game.lastMove" />
    </div>
    <div class="strip">
      <span class="name">{{ game.white?.name ?? "Blanc" }}</span>
      <span v-if="game.white?.elo" class="elo">{{ game.white.elo }}</span>
      <span v-if="game.result" class="badge">{{ game.result }}</span>
      <span class="clock" :class="{ active: isActive('white') }">{{
        formatClock(game.whiteClock)
      }}</span>
    </div>
  </div>
</template>
