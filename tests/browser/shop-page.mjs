// A large right-to-left shopping page: thousands of rules, hundreds of product pictures and CSS backgrounds, carousels that
// move by script, a deep DOM. Served by `startShop`.
import http from 'node:http';
import zlib from 'node:zlib';

function crc32(buf) {
  let c;
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

/** A small PNG: a soft gradient with a pseudo-random speckle, white or colored ground. */
export function png(seed, size = 96, white = false) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let s = seed * 2654435761;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const n = (s >>> 24) & 31;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      const inner = Math.abs(x - size / 2) + Math.abs(y - size / 2) < size / 3;
      raw[o] = white && !inner ? 255 : (seed * 7 + x * 2 + n) & 255;
      raw[o + 1] = white && !inner ? 255 : (seed * 13 + y * 2 + n) & 255;
      raw[o + 2] = white && !inner ? 255 : (seed * 29 + x + y + n) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (n) => `#${(((n * 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
const light = (n) => `#${(0xe0 + (n % 24)).toString(16)}${(0xe0 + ((n * 7) % 24)).toString(16)}${(0xe0 + ((n * 13) % 24)).toString(16)}`;

/** @param {{ rules?: number, carousels?: number, cards?: number, depth?: number, scripts?: boolean, imageDelay?: number }} o */
export function shopParts({ rules = 5000, carousels = 14, cards = 30, depth = 12, scripts = true } = {}) {
  let css = 'html{direction:rtl}body{margin:0;background:#fff;color:#222;font:14px/1.5 system-ui}.row{position:relative;margin:12px 0;padding:8px;background:#f7f7f7}.car{display:flex;overflow-x:auto;gap:8px;scroll-snap-type:x mandatory}.card{flex:0 0 150px;background:#fff;border:1px solid #e5e5e5;border-radius:6px;padding:6px;scroll-snap-align:start;transition:box-shadow .2s}.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.2)}.card img{width:96px;height:96px;display:block}.bg{width:120px;height:80px;background-size:cover}.price{color:#d00;font-weight:700}.badge{background:linear-gradient(#ffe,#ffd);color:#640}\n';
  for (let i = 0; i < rules; i++) {
    css += `.r${i}{color:${hex(i)};background:${light(i)};border:1px solid ${light(i + 3)}}\n`;
    if (i % 5 === 0) css += `.r${i}:hover{background:${light(i + 9)};box-shadow:0 0 0 1px ${hex(i + 1)}}\n`;
    if (i % 17 === 0) css += `.g${i}{background-image:linear-gradient(${light(i)},${light(i + 4)})}\n`;
    if (i % 29 === 0) css += `.b${i}{background-image:url(/img/bg${i % 40}.png)}\n`;
    if (i % 11 === 0) css += `@media (min-width:${400 + (i % 600)}px){.r${i}{border-color:${hex(i + 5)}}}\n`;
  }
  let body = '<header class="r1"><h1 class="r2">فروشگاه</h1></header>';
  for (let c = 0; c < carousels; c++) {
    body += `<section class="row r${c * 3}"><h2>دسته ${c}</h2><div class="car">`;
    for (let k = 0; k < cards; k++) {
      const n = c * cards + k;
      let inner = `<img src="/img/p${n % 300}.png" width="96" height="96" alt=""><div class="price r${(n * 13) % rules}">${n} تومان</div><div class="bg b${(n % 7) * 29 * 3 + 29 * 0}" style="background-color:${light(n)}"></div>`;
      for (let d = 0; d < depth; d++) inner = `<div class="w${d} r${(n + d) % rules}">${inner}</div>`;
      body += `<article class="card r${(n * 7) % rules}">${inner}</article>`;
    }
    body += '</div></section>';
  }
  const script = scripts
    ? `<script>
    // Carousels that move by script, a badge that blinks, a class toggled on the root: the page keeps changing its own DOM.
    let t = 0;
    setInterval(() => {
      t++;
      document.querySelectorAll('.car').forEach((c, i) => { c.scrollLeft -= 3; c.dataset.pos = String((t + i) % 9); });
      document.querySelectorAll('.card')[t % 50].classList.toggle('hot');
      document.documentElement.classList.toggle('tick', t % 2 === 0);
    }, 100);
  </script>`
    : '';
  return { css, html: `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>Shop</title><link rel="stylesheet" href="/shop.css"></head><body>${body}${script}</body></html>` };
}

/** @param {Parameters<typeof shopParts>[0]} [options] */
export function startShop(options = {}) {
  const { css, html } = shopParts(options);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/shop.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=300' });
      res.end(css);
      return;
    }
    const img = /^\/img\/(p|bg)(\d+)\.png$/.exec(url.pathname);
    if (img) {
      const send = () => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=300' });
        res.end(png(Number(img[2]) + (img[1] === 'bg' ? 1000 : 0), 96, img[1] === 'p' && Number(img[2]) % 3 === 0));
      };
      // With `imageDelay` the pictures arrive late, so the page stays in its loading state.
      if (options.imageDelay) setTimeout(send, options.imageDelay);
      else send();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
