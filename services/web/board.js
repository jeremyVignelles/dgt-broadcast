const GLYPHS = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟\uFE0E",
};

/** Returns 64 squares (a8 first) as { piece, white } or null for empty squares. */
export function parseFen(fen) {
  const squares = [];
  for (const row of String(fen ?? "")
    .split(" ")[0]
    .split("/")) {
    for (const char of row) {
      if (/[1-8]/.test(char)) {
        for (let i = 0; i < Number(char); i++) squares.push(null);
      } else if (GLYPHS[char.toLowerCase()]) {
        squares.push({ glyph: GLYPHS[char.toLowerCase()], white: char === char.toUpperCase() });
      } else {
        squares.push(null);
      }
    }
  }
  while (squares.length < 64) squares.push(null);
  return squares.slice(0, 64);
}

export function squareName(index) {
  return String.fromCharCode(97 + (index % 8)) + (8 - Math.floor(index / 8));
}

/** Extracts the squares of a move such as "e2e4", "e2-e4" or "Nf3" (only coordinates are kept). */
export function lastMoveSquares(move) {
  return String(move ?? "").match(/[a-h][1-8]/g) ?? [];
}

export function sideToMove(fen) {
  return String(fen ?? "").split(" ")[1] === "b" ? "black" : "white";
}

export function formatClock(seconds) {
  if (seconds === null || seconds === undefined) return "--:--";
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
