import { encodePng } from './png.mjs';

const dist = (x, y, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
};

/** A tile of `size` pixels with a hexagon outline: `ground` and `line` are [r, g, b, a]. */
export function hexTile(size, ground, line) {
  const c = size / 2;
  const r = size * 0.38;
  const pts = Array.from({ length: 6 }, (_, k) => [c + r * Math.cos((k * Math.PI) / 3 + Math.PI / 6), c + r * Math.sin((k * Math.PI) / 3 + Math.PI / 6)]);
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = pts.some((p, k) => dist(x + 0.5, y + 0.5, p, pts[(k + 1) % 6]) < 0.9);
      px.set(on ? line : ground, (y * size + x) * 4);
    }
  }
  return { w: size, h: size, px };
}

/** Light line art (stars, rings, crosses) on a solid ground: a repeating wallpaper tile. */
export function lineArtTile(size, ground, line) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ring = Math.abs(Math.hypot(x - size * 0.3, y - size * 0.3) - size * 0.14) < 0.9;
      const cross = (Math.abs(x - size * 0.72) < 0.8 && Math.abs(y - size * 0.7) < size * 0.14) || (Math.abs(y - size * 0.7) < 0.8 && Math.abs(x - size * 0.72) < size * 0.14);
      const diag = Math.abs(x - y - size * 0.35) < 0.8 && x > size * 0.5 && y < size * 0.5;
      px.set(ring || cross || diag ? line : ground, (y * size + x) * 4);
    }
  }
  return { w: size, h: size, px };
}

export const png = (tile) => encodePng(tile.w, tile.h, tile.px);
