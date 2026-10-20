// @ts-check
// The only network access of the extension: fetch a stylesheet or an image that the page the user is on already uses,
// so the engine can read what the browser will not show it. Every rule here comes from the threat model T-03.

export const LIMITS = Object.freeze({
  TEXT_BYTES: 2 * 1024 * 1024,
  IMAGE_BYTES: 1024 * 1024,
  // A picture is made small in the worker only when its header says it has at most this many pixels, and within this time.
  SAMPLE_PIXELS: 16_000_000,
  SAMPLE_MS: 4000,
  TIMEOUT_MS: 10_000,
  // A page waits for its own stylesheet as long as the server needs, and the engine holds the page for it. The worker's wait
  // is shorter than the 30 s after which the browser ends a worker that waits for a reply.
  TEXT_TIMEOUT_MS: 25_000,
  URL_CHARS: 2048,
  CACHE_ENTRIES: 50,
  CACHE_BYTES: 20 * 1024 * 1024,
  CACHE_TTL_MS: 5 * 60 * 1000,
  // A sheet the server says is gone (404, 410) is not asked for again for a short time.
  MISSING_ENTRIES: 50,
  MISSING_TTL_MS: 10_000,
  RATE_COUNT: 60,
  RATE_WINDOW_MS: 10_000,
  // Fetches in progress at one time, all tabs together. The last few are kept for tabs that have none running, so a busy tab cannot
  // make the others wait for its slow server. A tab may hold all the rest: its frames together ask for more than one frame does.
  INFLIGHT: 16,
  INFLIGHT_RESERVE: 4,
});

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
]);

/* ------------------------------------------------------------------ */
/* Where a request may go                                              */
/* ------------------------------------------------------------------ */

/**
 * The kind of network an address is in. `loopback` is this machine, `link` a link-local network (one hop, no router),
 * `private` any other network that is not the public internet, `public` the rest.
 * @typedef {'public' | 'private' | 'loopback' | 'link'} Reach
 */

/** @param {number[]} p four numbers @returns {Reach} */
function ipv4Reach(p) {
  const [a, b] = p;
  // 0.0.0.0/8 reaches this machine on the systems that route it at all.
  if (a === 127 || a === 0) return 'loopback';
  if (a === 169 && b === 254) return 'link';
  if (
    a === 10 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
    return 'private';
  return 'public';
}

/** @param {string} host without brackets @returns {Reach} */
function ipv6Reach(host) {
  // Expand "::" and read the first and the last hextets.
  const sides = host.split('::');
  if (sides.length > 2) return 'private';
  const head = sides[0] === '' ? [] : sides[0].split(':');
  const tail = sides.length === 2 ? (sides[1] === '' ? [] : sides[1].split(':')) : [];
  const fill = sides.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (sides.length === 1 && head.length !== 8)) return 'private';
  const words = [...head, ...new Array(fill).fill('0'), ...tail].map((w) => parseInt(w || '0', 16));
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return 'private';
  // The unspecified address and the loopback address.
  if (words.slice(0, 7).every((w) => w === 0) && words[7] <= 1) return 'loopback';
  if ((words[0] & 0xffc0) === 0xfe80) return 'link';
  if ((words[0] & 0xfe00) === 0xfc00) return 'private'; // unique local
  if ((words[0] & 0xff00) === 0xff00) return 'private'; // multicast
  if ((words[0] & 0xffc0) === 0xfec0) return 'private'; // site local (old)
  if (words[0] === 0x100 && words.slice(1, 4).every((w) => w === 0)) return 'private'; // discard prefix
  if (words[0] === 0x2001 && words[1] === 0) return 'private'; // Teredo
  const v4 = (/** @type {number} */ hi, /** @type {number} */ lo) => ipv4Reach([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  // IPv4 mapped (::ffff:a.b.c.d), IPv4 compatible (::a.b.c.d) and IPv4 translated (::ffff:0:a.b.c.d): judge the IPv4 part.
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) return v4(words[6], words[7]);
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0) return v4(words[6], words[7]);
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address; the local-use NAT64 prefix is not public.
  if (words[0] === 0x64 && words[1] === 0xff9b) return words.slice(2, 6).every((w) => w === 0) ? v4(words[6], words[7]) : 'private';
  if (words[0] === 0x2002) return v4(words[1], words[2]);
  return 'public';
}

/**
 * The network a host name points into. A name that only resolves to a private address through DNS cannot be seen from here (known limit).
 * @param {string} hostname as given by `new URL(...).hostname`
 * @returns {Reach}
 */
export function hostReach(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === '') return 'private';
  if (host.startsWith('[') && host.endsWith(']')) return ipv6Reach(host.slice(1, -1));
  if (host.includes(':')) return ipv6Reach(host);
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    return parts.some((n) => n > 255) ? 'private' : ipv4Reach(parts);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  // Names that no public registry delegates: RFC 6761/8375 (home.arpa, .test, .invalid) and the common private suffixes of company
  // networks. Development tools often point `.test` at this machine; it counts as private, not loopback, because the name says nothing
  // certain.
  if (host === 'home.arpa' || host.endsWith('.home.arpa')) return 'private';
  if (/\.(local|internal|localdomain|lan|home|corp|intranet|intra|private|test|invalid)$/.test(host)) return 'private';
  // A name with no dot is an intranet name.
  return host.includes('.') ? 'public' : 'private';
}

/**
 * True for a host name that points into a private or local network, or cannot be told apart from one.
 * @param {string} hostname as given by `new URL(...).hostname`
 */
export const isPrivateHost = (hostname) => hostReach(hostname) !== 'public';

/**
 * May a page in the network `page` read an address in the network `target`? The public internet is open to every page. Loopback is
 * open only to a page on loopback and link-local only to a page on link-local, because those reach this machine or the next hop,
 * which a page elsewhere has no business with. Any other private network is open to any page that is not public.
 * @param {Reach} target @param {Reach} page
 */
export function reachAllowed(target, page) {
  if (target === 'public') return true;
  if (target === 'loopback' || target === 'link') return page === target;
  return page !== 'public';
}

/**
 * Whether a request for `target` may be made on behalf of a page at `pageUrl`.
 * Only http and https, no credentials in the address, no private network unless the page itself is on one (`reachAllowed`).
 * @param {unknown} target @param {unknown} pageUrl
 * @returns {{ ok: true, url: URL } | { ok: false, code: 'invalid' | 'scheme' | 'credentials' | 'private' | 'page' }}
 */
export function checkTarget(target, pageUrl) {
  if (typeof target !== 'string' || target.length === 0 || target.length > LIMITS.URL_CHARS) return { ok: false, code: 'invalid' };
  let url;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'scheme' };
  if (url.username || url.password) return { ok: false, code: 'credentials' };
  const reach = hostReach(url.hostname);
  if (reach !== 'public') {
    let page;
    try {
      page = new URL(String(pageUrl));
    } catch {
      return { ok: false, code: 'page' };
    }
    if ((page.protocol !== 'http:' && page.protocol !== 'https:') || !reachAllowed(reach, hostReach(page.hostname))) return { ok: false, code: 'private' };
  }
  return { ok: true, url };
}

/* ------------------------------------------------------------------ */
/* The fetcher                                                         */
/* ------------------------------------------------------------------ */

const B64 = new Uint8Array(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c) => c.charCodeAt(0)));
const ascii = new TextDecoder();

/**
 * Standard base64 of some bytes. The engine's own encoder is used when it has one; otherwise a table loop writes the
 * characters into a byte array and decodes that once (1 MB in about 7 ms; a string built from `fromCharCode` takes 20 to 200 times as long).
 * @param {Uint8Array} bytes @param {boolean} [native]  tests turn the engine's encoder off
 */
export function encodeBase64(bytes, native = typeof (/** @type {any} */ (bytes)).toBase64 === 'function') {
  if (native) return /** @type {any} */ (bytes).toBase64();
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64[v >> 18];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = B64[(v >> 6) & 63];
    out[o++] = B64[v & 63];
  }
  if (i < n) {
    const two = n - i === 2;
    const v = (bytes[i] << 16) | (two ? bytes[i + 1] << 8 : 0);
    out[o++] = B64[v >> 18];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = two ? B64[(v >> 6) & 63] : 61;
    out[o++] = 61;
  }
  return ascii.decode(out);
}

/** The bytes of a base64 text. @param {string} text */
function decodeBase64(text) {
  const native = /** @type {any} */ (Uint8Array).fromBase64;
  if (typeof native === 'function') return /** @type {Uint8Array} */ (native(text));
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Did the server answer with a redirect? With `redirect: 'manual'` a browser gives an opaque reply (type `opaqueredirect`, status 0);
 * the other signals cover an environment that shows the status or that followed anyway.
 * @param {{ type?: string, status?: number, redirected?: boolean }} response
 */
const isRedirect = (response) =>
  response.type === 'opaqueredirect' || response.redirected === true || (typeof response.status === 'number' && response.status >= 300 && response.status < 400);

/** @param {string} header */
const mimeOf = (header) => header.split(';')[0].trim().toLowerCase();

/**
 * Read a body but stop at `max` bytes.
 * @param {Response} response @param {number} max
 * @returns {Promise<Uint8Array | null>} null when the body is larger than `max`
 */
async function readLimited(response, max) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The size in pixels that the header of a picture gives, or null when the format is not known here.
 * @param {Uint8Array} b @returns {[number, number] | null}
 */
export function pixelSize(b) {
  const be32 = (/** @type {number} */ i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (/** @type {number} */ i) => b[i] | (b[i + 1] << 8);
  const le24 = (/** @type {number} */ i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const le32 = (/** @type {number} */ i) => (le24(i) | (b[i + 3] << 24)) >>> 0;
  const tag = (/** @type {number} */ i, /** @type {string} */ s) => b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 30) return null;
  if (tag(1, 'PNG') && tag(12, 'IHDR')) return [be32(16), be32(20)];
  if (tag(0, 'GIF8')) return [le16(6), le16(8)];
  if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8 ')) return [le16(26) & 0x3fff, le16(28) & 0x3fff];
    if (tag(12, 'VP8L')) return [1 + (le32(21) & 0x3fff), 1 + ((le32(21) >>> 14) & 0x3fff)];
    if (tag(12, 'VP8X')) return [1 + le24(24), 1 + le24(27)];
    return null;
  }
  if (tag(0, 'BM')) return [Math.abs(le32(18) | 0), Math.abs(le32(22) | 0)];
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return [b[6] || 256, b[7] || 256];
  if (b[0] === 0xff && b[1] === 0xd8) {
    // The size is in the first frame header (SOF0 to SOF15 without DHT, JPG and DAC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 ? 2 : 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}

/**
 * A picture as a 32 by 32 copy of RGBA, in base64, or null when it cannot be made here (a vector picture, a format whose size is
 * not known, a picture over the pixel cap, no canvas in this context, a failed decode or a decode that takes over `SAMPLE_MS`).
 * The page makes its copy the same way, so a verdict does not depend on where the copy was made.
 * @param {Uint8Array} bytes @param {string} mime @param {number} [ms]  the longest wait for the decoder
 * @returns {Promise<string | null>}
 */
export async function sampleImage(bytes, mime, ms = LIMITS.SAMPLE_MS) {
  if (mime === 'image/svg+xml' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  const size = pixelSize(bytes);
  if (!size || size[0] < 1 || size[1] < 1 || size[0] * size[1] > LIMITS.SAMPLE_PIXELS) return null;
  /** @type {ImageBitmap | null} */
  let bitmap = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const made = createImageBitmap(new Blob([/** @type {BlobPart} */ (bytes)], { type: mime }), { resizeWidth: 32, resizeHeight: 32 });
    bitmap = await Promise.race([made, new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
    // A decode that comes in late is closed when it arrives.
    if (!bitmap) {
      made.then((late) => late.close(), () => {});
      return null;
    }
    const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    return encodeBase64(new Uint8Array(ctx.getImageData(0, 0, 32, 32).data.buffer));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    bitmap?.close();
  }
}

/**
 * Decode a style sheet by the signals a browser uses: a byte order mark, the `charset` of the header, a leading `@charset`,
 * then the encoding of the linking document (`fallback`, from `documentCharset`), then UTF-8. A label the decoder does not know
 * is skipped.
 * @param {Uint8Array} bytes @param {string} contentType @param {string} [fallback]
 */
export function decodeText(bytes, contentType, fallback = '') {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const header = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  const rule = /^@charset "([^"]{1,64})";/.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 1024)))?.[1];
  for (const label of [header, rule, fallback]) {
    if (!label) continue;
    try {
      const decoder = new TextDecoder(label);
      // Text that reads as ASCII cannot be UTF-16, so an `@charset` naming it is ignored.
      if (label !== header && decoder.encoding.startsWith('utf-16')) continue;
      return decoder.decode(bytes);
    } catch {
      // An unknown label: try the next signal.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The encoding a page gives as its own, as a name the decoder knows. Empty for UTF-8, UTF-16 (a sheet that reads as ASCII is not
 * UTF-16), an unknown name and anything that is not a string.
 * @param {unknown} raw
 */
export function documentCharset(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  try {
    const name = new TextDecoder(raw).encoding;
    return name === 'utf-8' || name.startsWith('utf-16') ? '' : name;
  } catch {
    return '';
  }
}

/**
 * The part of the proxy's stores an asker may use: the origin of the top page and the origin of the asking frame, the key a browser
 * gives its own HTTP cache (stricter: an origin, not a site, because the worker has no list of public suffixes). An asker with no web
 * address, or a frame whose origin the browser did not tell (`rights` is empty: it may be a third party), gets a part of its tab alone.
 * @param {{ tabId: number, pageUrl: string, top?: string, rights?: string }} who
 */
export function partitionOf(who) {
  const origin = (/** @type {unknown} */ address) => {
    try {
      const u = new URL(String(address));
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
    } catch {
      return '';
    }
  };
  const frame = who.rights === '' ? '' : origin(who.pageUrl);
  if (frame === '') return `tab:${who.tabId}`;
  return `${origin(who.top) || frame}|${frame}`;
}

/**
 * Does this browser hold a fetch to `targetAddressSpace: 'public'`? Chromium refuses such a fetch before it is sent when the address
 * it connects to is not public. A browser that does not know the option (Firefox, an older Chromium) ignores it, so it is not used.
 */
export function publicSpaceKnown() {
  try {
    return /** @type {any} */ (new Request('data:,', /** @type {any} */ ({ targetAddressSpace: 'public' }))).targetAddressSpace === 'public';
  } catch {
    return false;
  }
}

/**
 * @typedef {{ tabId: number, frameId: number, pageUrl: string, rights?: string, documentId?: string, top?: string }} Requester
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   verifyUsed: ((who: Requester, url: string) => Promise<boolean>) & { read?: (who: Requester, url: string, accept: string, max: number, ms: number) => Promise<any> },
 *   sampler?: (bytes: Uint8Array, mime: string) => Promise<string | null>,
 *   publicSpace?: boolean,
 * }} deps
 *   `verifyUsed` answers whether the frame really uses that address (as a link, an image or a resource it loaded). Its `read` has
 *   the page read the address itself, with CORS (`pageReads`); without it such an address is refused.
 *   `publicSpace`: the browser holds a fetch to the public address space (`publicSpaceKnown`).
 *   `sampler` makes the small copy of a picture for a page that asks for one (`sampleImage`; tests give their own).
 */
export function createNet({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), verifyUsed, sampler = sampleImage, publicSpace = publicSpaceKnown() }) {
  const readInPage = verifyUsed.read ?? (async () => null);
  // The worker's own requests are not held to the browser's local network rule. Where the browser knows the option, the
  // fetch of a public name names the address space it may reach: `public` for a public page, then `local` for a page on a private
  // network. The browser checks the address it really connects to and refuses another one before anything is sent. Where it cannot
  // judge (behind an HTTP proxy every value fails; Firefox and an older Chromium do not know the option), the page reads the file
  // itself with CORS (`readInPage`): the browser checks that connection, and the page gets nothing it could not read itself. So
  // there is no time between a check and the fetch, and nothing a page can do turns a check off.
  // Every store below is kept apart by the asker's partition (`partitionOf`), so a page cannot time what was fetched for another site.
  /** @type {Map<string, { at: number, bytes: number, payload: any }>} */
  const cache = new Map();
  let cacheBytes = 0;
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  /** @param {number} tabId @param {'text' | 'image'} kind */
  function overRate(tabId, kind) {
    const t = now();
    // Sheets and pictures have a budget each, so a page full of pictures cannot starve its sheets.
    const key = `${tabId}:${kind}`;
    const list = (hits.get(key) ?? []).filter((x) => t - x < LIMITS.RATE_WINDOW_MS);
    if (list.length >= LIMITS.RATE_COUNT) {
      hits.set(key, list);
      return true;
    }
    list.push(t);
    hits.set(key, list);
    return false;
  }

  /** @param {string} key @param {any} payload @param {number} bytes */
  function remember(key, payload, bytes) {
    const old = cache.get(key);
    if (old) {
      cache.delete(key);
      cacheBytes -= old.bytes;
    }
    cache.set(key, { at: now(), bytes, payload });
    cacheBytes += bytes;
    for (const [k, v] of cache) {
      if (cache.size <= LIMITS.CACHE_ENTRIES && cacheBytes <= LIMITS.CACHE_BYTES) break;
      cache.delete(k);
      cacheBytes -= v.bytes;
    }
  }

  /** Addresses the server said are gone, with the final address of the answer. @type {Map<string, { at: number, url: string }>} */
  const missing = new Map();
  /** @param {string} base @param {string} url */
  function markMissing(base, url) {
    missing.delete(base);
    missing.set(base, { at: now(), url });
    for (const k of missing.keys()) {
      if (missing.size <= LIMITS.MISSING_ENTRIES) break;
      missing.delete(k);
    }
  }

  /** Fetches in progress, by partition, kind and address: a second asker waits for the first. @type {Map<string, Promise<any>>} */
  const inflight = new Map();
  /** Fetches in progress that each tab started. @type {Map<number, number>} */
  const held = new Map();
  /** May this tab start one more fetch? @param {number} tabId */
  function slotFree(tabId) {
    const own = held.get(tabId) ?? 0;
    if (inflight.size >= LIMITS.INFLIGHT) return false;
    return own === 0 || inflight.size < LIMITS.INFLIGHT - LIMITS.INFLIGHT_RESERVE;
  }
  /** @param {number} tabId @param {1 | -1} step */
  function hold(tabId, step) {
    const n = (held.get(tabId) ?? 0) + step;
    if (n > 0) held.set(tabId, n);
    else held.delete(tabId);
  }
  const RATE = Object.freeze({ ok: false, code: 'rate' });
  // A refusal that depends on who asked, or on luck, is not handed to another asker.
  const NOT_SHARED = new Set(['timeout', 'network', 'redirect', 'unused']);

  /** An answer made for another asker is only given on if its final address is open to this one. @param {any} payload @param {string} rights */
  const reach = (payload, rights) => (payload.ok && !checkTarget(payload.url, rights).ok ? { ok: false, code: 'redirect' } : payload);

  /**
   * @param {'text' | 'image'} kind @param {string} href @param {string} key @param {string} rights @param {string} fallback
   * @param {boolean} small  an image is answered with its 32 by 32 copy when one can be made, else with the file
   * @param {string} base  the key of the `missing` map
   * @param {Requester} who  the asker whose page reads the address when the browser cannot judge the worker's fetch
   * @returns {Promise<any>} never rejects
   */
  async function load(kind, href, key, rights, fallback, small, base, who) {
    const limit = kind === 'text' ? LIMITS.TEXT_TIMEOUT_MS : LIMITS.TIMEOUT_MS;
    let controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    // Each fetch gets its own controller and time limit.
    const arm = () => {
      clearTimeout(timer);
      controller.abort();
      controller = new AbortController();
      const own = controller;
      timer = setTimeout(() => own.abort(), limit);
    };
    arm();
    const accept = kind === 'text' ? 'text/css,*/*;q=0.1' : 'image/*,*/*;q=0.1';
    // A name that says it is private was judged by `reachAllowed` already; the checks below are for public names.
    const named = hostReach(new URL(href).hostname) === 'public';
    /** @type {Reach} */
    let pageNet = 'public';
    try {
      pageNet = hostReach(new URL(rights).hostname);
    } catch {}
    // The address spaces the page may reach, as the browser names them; null: no option (a page on this machine may reach all).
    /** @type {(string | null)[]} */
    const spaces = !named || pageNet === 'loopback' ? [null] : !publicSpace ? [] : pageNet === 'public' ? ['public'] : ['public', 'local'];
    /** @param {string} address @param {string | null} space */
    const request = (address, space) =>
      fetchImpl(address, {
        ...(space ? { targetAddressSpace: space } : {}),
        credentials: 'omit',
        // The HTTP cache of the worker is one for every site: an entry that one site's page made would answer another site's page
        // faster, which that page can time. The byte cache here is kept per partition instead.
        cache: 'no-store',
        // A redirect is never followed: the browser would send the next request before the address could be checked, and an
        // extension cannot read where a redirect points (the reply is opaque). A moved file is refused (T-03).
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: { Accept: accept },
      });
    let space = spaces[0] ?? null;
    try {
      /** @type {Response | null} */
      let response = null;
      // The address the answer came from, when the page read it (the page follows a redirect; the browser checks each hop).
      let from = '';
      for (const s of spaces) {
        space = s;
        try {
          if (s !== spaces[0]) arm();
          response = await request(href, s);
          break;
        } catch (error) {
          if (error && /** @type {any} */ (error).name === 'AbortError') throw error;
          // The browser refused that space, or a proxy, or no network.
          if (s === null) throw error;
        }
      }
      if (!response) {
        clearTimeout(timer);
        const got = await readInPage(who, href, accept, kind === 'text' ? LIMITS.TEXT_BYTES : LIMITS.IMAGE_BYTES, limit);
        if (!got) return { ok: false, code: 'unused' };
        if (got.code === 'timeout' || got.code === 'too-large') return { ok: false, code: got.code };
        if (typeof got.url !== 'string' || typeof got.status !== 'number' || got.status < 200 || got.status > 599) return { ok: false, code: 'unused' };
        from = got.url;
        try {
          const bytes = typeof got.b64 === 'string' ? decodeBase64(got.b64) : null;
          response = new Response(/** @type {BodyInit | null} */ (/** @type {unknown} */ (bytes)), { status: got.status, headers: { 'content-type': String(got.type ?? '') } });
        } catch {
          return { ok: false, code: 'unused' };
        }
      }
      if (isRedirect(response)) {
        // The one move that is known without reading it: the same address over https (port 80 to 443). No other host is asked.
        const secure = href.startsWith('http:') && new URL(href).port === '' ? `https:${href.slice(5)}` : '';
        if (secure === '' || !checkTarget(secure, rights).ok) return { ok: false, code: 'redirect' };
        await response.body?.cancel().catch(() => {});
        try {
          response = await request(secure, space);
        } catch (error) {
          if (error && /** @type {any} */ (error).name === 'AbortError') throw error;
          return { ok: false, code: 'redirect' };
        }
        if (isRedirect(response)) return { ok: false, code: 'redirect' };
      }
      const final = checkTarget(from || response.url || href, rights);
      if (!final.ok) return { ok: false, code: 'redirect' };
      if (!response.ok) {
        if (response.status === 404 || response.status === 410) markMissing(base, final.url.href);
        return { ok: false, code: 'status' };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const mime = mimeOf(contentType);
      if (kind === 'text' ? mime !== 'text/css' : !IMAGE_TYPES.has(mime)) return { ok: false, code: 'type' };
      const max = kind === 'text' ? LIMITS.TEXT_BYTES : LIMITS.IMAGE_BYTES;
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > max) return { ok: false, code: 'too-large' };
      const bytes = await readLimited(response, max);
      if (!bytes) return { ok: false, code: 'too-large' };
      const sample = small ? await sampler(bytes, mime) : null;
      const payload =
        kind === 'text'
          ? { ok: true, text: decodeText(bytes, contentType, fallback), url: final.url.href }
          : sample !== null
            ? { ok: true, mime, sample, url: final.url.href }
            : { ok: true, mime, base64: encodeBase64(bytes), url: final.url.href };
      // What the cache holds: the characters of a sheet, the base64 text of a picture (a third more than its bytes) or its small copy.
      remember(key, payload, payload.text !== undefined ? bytes.length : (payload.sample ?? payload.base64).length);
      return payload;
    } catch (error) {
      return { ok: false, code: error && /** @type {any} */ (error).name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
      // A refused reply is still open; this ends it. After a full read it does nothing.
      controller.abort();
    }
  }

  /**
   * @param {'text' | 'image'} kind @param {unknown} raw @param {Requester} who
   * @param {boolean} [trusted]  the address comes from the browser itself (the icon of a tab), so no frame needs to use it
   * @param {unknown} [charset]  the encoding of the asking document, the last signal for a sheet
   * @param {boolean} [small]  the page wants the 32 by 32 copy of an image (kept apart in the cache and in the shared fetches)
   * @returns {Promise<any>}
   */
  async function get(kind, raw, who, trusted = false, charset, small = false) {
    // `rights` is the address that may grant access to a private network; an empty text grants none.
    const rights = who.rights ?? who.pageUrl;
    const target = checkTarget(raw, rights);
    if (!target.ok) return { ok: false, code: target.code };
    const href = target.url.href;
    if (overRate(who.tabId, kind)) return RATE;
    if (!trusted && !(await verifyUsed(who, href))) return { ok: false, code: 'unused' };

    const base = `${partitionOf(who)} ${kind}:${href}`;
    const fallback = kind === 'text' ? documentCharset(charset) : '';
    const key = fallback ? `${base}#${fallback}` : small ? `${base}#small` : base;
    const gone = missing.get(base);
    if (gone) {
      if (now() - gone.at < LIMITS.MISSING_TTL_MS) return { ok: false, code: checkTarget(gone.url, rights).ok ? 'status' : 'redirect' };
      missing.delete(base);
    }
    const known = cache.get(key);
    if (known && now() - known.at < LIMITS.CACHE_TTL_MS) {
      // Move it to the end, so the oldest entry is the one dropped first.
      cache.delete(key);
      cache.set(key, known);
      return reach(known.payload, rights);
    }
    if (known) {
      cache.delete(key);
      cacheBytes -= known.bytes;
    }

    const attempt = () => {
      const running = inflight.get(key);
      if (running) return { task: running, joined: true };
      if (!slotFree(who.tabId)) return null;
      hold(who.tabId, 1);
      const task = load(kind, href, key, rights, fallback, small, base, who).finally(() => {
        inflight.delete(key);
        hold(who.tabId, -1);
      });
      inflight.set(key, task);
      return { task, joined: false };
    };
    let run = attempt();
    if (!run) return RATE;
    let result = await run.task;
    if (run.joined && !result.ok && NOT_SHARED.has(result.code)) {
      run = attempt();
      if (!run) return RATE;
      result = await run.task;
    }
    return run.joined ? reach(result, rights) : result;
  }

  return {
    /** @param {unknown} url @param {Requester} who @param {unknown} [charset] */
    text: (url, who, charset) => get('text', url, who, false, charset),
    /** @param {unknown} url @param {Requester} who @param {boolean} [small]  answer with the 32 by 32 copy when one can be made */
    image: (url, who, small = false) => get('image', url, who, false, undefined, small === true),
    /** The icon of a tab, as the browser reports it. @param {unknown} url @param {Requester} who */
    favicon: (url, who) => get('image', url, who, true),
    forgetTab(/** @type {number} */ tabId) {
      hits.delete(`${tabId}:text`);
      hits.delete(`${tabId}:image`);
      /** @type {any} */ (verifyUsed).forgetTab?.(tabId);
    },
    get cacheBytes() {
      return cacheBytes;
    },
    get cacheSize() {
      return cache.size;
    },
  };
}
