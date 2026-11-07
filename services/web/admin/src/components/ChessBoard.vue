<script setup lang="ts">
import { computed } from "vue";
import { lastMoveSquares, parseFen, squareName } from "../../../board.js";

const props = defineProps<{
  fen?: string;
  lastMove?: string;
}>();

// The board fills its container: squares are only square if the container is.
const cells = computed(() => {
  const highlighted = new Set(lastMoveSquares(props.lastMove));
  return parseFen(props.fen).map((piece, index) => {
    const name = squareName(index);
    return {
      name,
      piece,
      dark: (Math.floor(index / 8) + index) % 2 === 1,
      last: highlighted.has(name),
    };
  });
});
</script>

<template>
  <div class="chess-board" role="img" aria-label="Position de l'échiquier">
    <div
      v-for="cell in cells"
      :key="cell.name"
      class="chess-square"
      :class="{ dark: cell.dark, light: !cell.dark, last: cell.last }"
    >
      <slot name="square" v-bind="cell">
        <span v-if="cell.piece" class="chess-piece" :class="cell.piece.white ? 'w' : 'b'">{{
          cell.piece.glyph
        }}</span>
      </slot>
    </div>
  </div>
</template>

<style>
.chess-board {
  container-type: size;
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  grid-template-rows: repeat(8, minmax(0, 1fr));
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.chess-square {
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  font-size: calc(min(100cqw, 100cqh) / 8 * 0.82);
  line-height: 1;
}
.chess-square.light {
  background: #ecd9b3;
}
.chess-square.dark {
  background: #a77b52;
}
.chess-square.light.last {
  background: #d4d86a;
}
.chess-square.dark.last {
  background: #a9a23a;
}
.chess-piece.w {
  color: #fff;
  text-shadow:
    0 0 0.04em #000,
    0 0 0.04em #000,
    0 0 0.06em #000;
}
.chess-piece.b {
  color: #111;
}
</style>
