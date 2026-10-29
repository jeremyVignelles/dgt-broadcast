/** Height of one player strip relative to the smaller side of a cell (kept in sync with display.css). */
export const STRIP_RATIO = 0.09;

const TOLERANCE = 0.9;

function boardSize(cellWidth, cellHeight) {
  const strip = STRIP_RATIO * Math.min(cellWidth, cellHeight);
  return Math.max(0, Math.min(cellWidth, cellHeight - 2 * strip));
}

/**
 * Chooses the grid that gives the largest boards. Layouts within 10% of the best
 * size are considered equivalent, then the one wasting the fewest cells and being the
 * most balanced wins (4 boards => 2x2 rather than 4x1).
 */
export function bestGrid(count, width, height) {
  if (count <= 0 || width <= 0 || height <= 0) return { columns: 1, rows: 1 };
  const layouts = [];
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    layouts.push({
      columns,
      rows,
      empty: columns * rows - count,
      size: boardSize(width / columns, height / rows),
    });
  }
  const max = Math.max(...layouts.map((l) => l.size));
  const candidates = layouts.filter((l) => l.size >= max * TOLERANCE);
  candidates.sort(
    (a, b) =>
      a.empty - b.empty ||
      Math.abs(a.columns - a.rows) - Math.abs(b.columns - b.rows) ||
      b.size - a.size,
  );
  return { columns: candidates[0].columns, rows: candidates[0].rows };
}
