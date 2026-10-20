import { deflateSync } from 'node:zlib';

const table = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (buf) => {
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** Encode RGBA pixels (Uint8ClampedArray or array, 4 values per pixel) as a PNG file. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width * 4; x++) raw[y * (width * 4 + 1) + 1 + x] = rgba[y * width * 4 + x];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A small seeded random generator, so the images are the same on every run. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Synthetic images with a known right answer. Each returns `{ name, expect, w, h, px }`.
 * Photos are noise and gradients with many colors; logos are flat shapes on a clear background; charts are flat
 * graphics on white; banners and screenshots are flat and not white.
 */
export function corpus(size = 32) {
  const out = [];
  const make = (name, expect, fill) => {
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b, a] = fill(x, y);
        const i = (y * size + x) * 4;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = a;
      }
    }
    out.push({ name, expect, w: size, h: size, px });
  };
  const inShape = (x, y, k) => {
    const c = size / 2;
    if (k % 3 === 0) return (x - c) ** 2 + (y - c) ** 2 < (size * 0.32) ** 2;
    if (k % 3 === 1) return Math.abs(x - c) < size * 0.3 && Math.abs(y - c) < size * 0.14;
    return Math.abs(x - c) + Math.abs(y - c) < size * 0.34;
  };
  for (let k = 0; k < 10; k++) {
    const r = rng(100 + k);
    make(`photo-${k}`, 'keep', () => [40 + r() * 120, 40 + r() * 120, 40 + r() * 120, 255]);
  }
  for (let k = 0; k < 10; k++) {
    const r = rng(200 + k);
    make(`bright-photo-${k}`, 'keep', () => [170 + r() * 80, 170 + r() * 80, 170 + r() * 80, 255]);
  }
  for (let k = 0; k < 6; k++) {
    const r = rng(300 + k);
    make(`dark-photo-${k}`, 'keep', () => [r() * 70, r() * 70, r() * 70, 255]);
  }
  for (let k = 0; k < 6; k++) {
    make(`gradient-${k}`, 'keep', (x, y) => {
      const base = k % 2 ? 150 : 40;
      return [base + (x / size) * 100, base + (y / size) * 100, base + ((x + y) / (2 * size)) * 100, 255];
    });
  }
  for (let k = 0; k < 10; k++) {
    const g = 10 + k * 3;
    make(`dark-logo-${k}`, 'invert', (x, y) => (inShape(x, y, k) ? [g, g, g, 255] : [0, 0, 0, 0]));
  }
  for (let k = 0; k < 4; k++) {
    make(`navy-logo-${k}`, 'invert', (x, y) => (inShape(x, y, k) ? [10, 20, 70 + k * 10, 255] : [0, 0, 0, 0]));
  }
  for (let k = 0; k < 6; k++) {
    make(`white-icon-${k}`, 'keep', (x, y) => (inShape(x, y, k) ? [245, 245, 245, 255] : [0, 0, 0, 0]));
  }
  for (let k = 0; k < 6; k++) {
    make(`color-logo-${k}`, 'keep', (x, y) => (inShape(x, y, k) ? [230, 90 + k * 10, 40, 255] : [0, 0, 0, 0]));
  }
  for (let k = 0; k < 8; k++) {
    make(`chart-${k}`, 'dim', (x, y) => {
      if (Math.abs(y - (size - 6)) < 1 || Math.abs(x - 5) < 1) return [30, 30, 30, 255];
      if (x > 8 && Math.abs(y - (size - 8 - ((x * (k + 2)) % 30))) < 2) return [30 + k * 20, 100, 200 - k * 10, 255];
      return [255, 255, 255, 255];
    });
  }
  for (let k = 0; k < 6; k++) {
    make(`banner-${k}`, 'keep', (x) => (x < size / 2 ? [30 + k * 20, 120, 200, 255] : [250 - k * 10, 180, 40, 255]));
  }
  for (let k = 0; k < 4; k++) {
    make(`dark-screenshot-${k}`, 'keep', (x, y) => ((x + y) % 11 === 0 ? [200, 200, 200, 255] : [20 + k, 22, 28, 255]));
  }
  return out;
}

/** A scan-code-like pattern of `modules` squares per side, drawn as black marks on a clear (or white) field, then made small by averaging. */
export function scanCode(modules, { opaque = false, side = 32, seed = 7 } = {}) {
  const rand = rng(seed);
  const cell = Array.from({ length: modules * modules }, () => rand() < 0.5);
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) cell[(y0 + y) * modules + x0 + x] = x === 0 || y === 0 || x === 6 || y === 6 || (x > 1 && x < 5 && y > 1 && y < 5);
  };
  finder(0, 0);
  finder(modules - 7, 0);
  finder(0, modules - 7);
  const px = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      // Share of this small pixel that is covered by black modules.
      let cover = 0;
      const n = 4;
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
        const mx = Math.floor(((x + (sx + 0.5) / n) / side) * modules);
        const my = Math.floor(((y + (sy + 0.5) / n) / side) * modules);
        if (cell[my * modules + mx]) cover += 1;
      }
      cover /= n * n;
      const i = (y * side + x) * 4;
      if (opaque) px.set([255 * (1 - cover), 255 * (1 - cover), 255 * (1 - cover), 255], i);
      else px.set([0, 0, 0, 255 * cover], i);
    }
  }
  return px;
}

/** A glyph: a ring with a bar through it, black on clear. */
export function glyph(side = 32) {
  const px = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const d = Math.hypot(x - side / 2 + 0.5, y - side / 2 + 0.5);
      const on = (d > side * 0.28 && d < side * 0.4) || (Math.abs(y - side / 2) < 2 && x > side * 0.2 && x < side * 0.8);
      px.set([0, 0, 0, on ? 255 : 0], (y * side + x) * 4);
    }
  }
  return px;
}
