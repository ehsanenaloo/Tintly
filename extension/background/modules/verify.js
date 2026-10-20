// @ts-check
// Checks that a frame really uses an address before the worker fetches it for that frame.
// The check runs inside the frame (in the extension's own world), so it looks at what the page loaded and what its
// elements point to, and not at what a message claims. When the browser names the document that asked, the check runs in that
// document and in no other: a frame that has moved on to a new page answers nothing for the old one.

/**
 * Runs in the page. It must not use anything from this module. One pass over the page answers a whole batch.
 * @param {string[]} targets
 * @returns {boolean[]} one answer for each address, in the same order
 */
function pageUsesUrls(targets) {
  try {
    const strip = (/** @type {string} */ u) => String(u).split('#')[0];
    const left = new Set(targets.map(strip));
    const found = new Set();
    // True when every address was found, so the pass can stop.
    const note = (/** @type {string} */ u) => {
      if (left.delete(u)) found.add(u);
      return left.size === 0;
    };
    const answer = () => targets.map((t) => found.has(strip(t)));
    if (left.size === 0) return answer();
    for (const e of performance.getEntriesByType('resource')) if (note(strip(e.name))) return answer();
    const same = (/** @type {string} */ value) => {
      try {
        return note(strip(new URL(value, document.baseURI).href));
      } catch {
        return false;
      }
    };
    const selector = 'link[href], img[src], img[srcset], source[srcset], source[src], video[poster], image, use, input[src]';
    for (const el of document.querySelectorAll(selector)) {
      for (const attr of ['href', 'src', 'poster', 'xlink:href']) {
        const v = el.getAttribute(attr);
        if (v && same(v)) return answer();
      }
      const set = el.getAttribute('srcset');
      if (set) for (const part of set.split(',')) if (same(part.trim().split(/\s+/)[0])) return answer();
    }
    // Chromium lists no resource entry for a CSS picture whose load starts in a style read of the extension's own script, and the
    // engine reads styles before the browser's own pass on many pages. So an address that a style element (the page's or the
    // engine's absolute copy) or a style attribute names in `url()` counts as used, the same as an element attribute. The text read is
    // capped, so a page full of styles costs a bounded scan.
    let budget = 4_000_000;
    const named = (/** @type {string} */ text) => {
      if (text.length > budget) {
        budget = 0;
        return false;
      }
      budget -= text.length;
      if (!text.includes('url(')) return false;
      for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]*))\s*\)/gi)) if (same(m[1] ?? m[2] ?? m[3] ?? '')) return true;
      return false;
    };
    for (const el of document.querySelectorAll('style')) if (named(el.textContent ?? '')) return answer();
    for (const el of document.querySelectorAll('[style*="url("]')) if (named(el.getAttribute('style') ?? '')) return answer();
    return answer();
  } catch {
    return targets.map(() => false);
  }
}

/**
 * Runs in the page, after `pageUsesUrls` said yes, when the browser cannot judge the worker's own fetch (see `net.js`). The page
 * reads the file itself, with CORS and no cookies: the browser checks the address it really connects to at that moment, under the
 * page's own local network rule, and the page gets only what it could read itself. A file without a CORS header cannot be read.
 * Firefox holds this read to the page CSP as well. It must not use anything from this module.
 * @param {string} url @param {string} accept @param {number} max  the most bytes @param {number} ms  the time the read may take
 * @returns {Promise<{ status: number, url: string, type: string, b64: string } | { status: number, url: string } | { code: 'timeout' | 'too-large' } | null>}
 *   null when the page cannot read it
 */
async function pageReads(url, accept, max, ms) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: stop.signal, headers: { Accept: accept } });
    if (!r.ok) {
      void r.body?.cancel().catch(() => {});
      return { status: r.status, url: r.url };
    }
    if (Number(r.headers.get('content-length')) > max) {
      void r.body?.cancel().catch(() => {});
      return { code: 'too-large' };
    }
    /** @type {Uint8Array[]} */
    const parts = [];
    let total = 0;
    const reader = /** @type {ReadableStream<Uint8Array>} */ (r.body).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        void reader.cancel().catch(() => {});
        return { code: 'too-large' };
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    /** @type {string} */
    let b64;
    if (typeof (/** @type {any} */ (bytes)).toBase64 === 'function') b64 = /** @type {any} */ (bytes).toBase64();
    else {
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
      b64 = btoa(text);
    }
    return { status: r.status, url: r.url, type: r.headers.get('content-type') ?? '', b64 };
  } catch (error) {
    return stop.signal.aborted && /** @type {any} */ (error)?.name === 'AbortError' ? { code: 'timeout' } : null;
  } finally {
    clearTimeout(timer);
  }
}

const TTL_MS = 60_000;
const MAX_KNOWN = 500;
// Addresses sent to a frame in one script call.
const MAX_BATCH = 100;

/** Does this error say that the browser does not know the way to name a document (an older browser), and not that the document is gone? @param {unknown} error */
const unsupported = (error) => /documentIds|Unexpected property|not supported|unsupported|Invalid value/i.test(String(/** @type {any} */ (error)?.message ?? error));

/**
 * @param {{ scripting: { executeScript(d: any): Promise<any[]> }, now?: () => number }} deps
 * @returns {((who: { tabId: number, frameId: number, documentId?: string }, url: string) => Promise<boolean>) & { forgetTab(tabId: number): void, read(who: { tabId: number, frameId: number, documentId?: string }, url: string, accept: string, max: number, ms: number): Promise<any> }}
 */
export function createVerifier({ scripting, now = () => Date.now() }) {
  /** @type {Map<string, number>} */
  const known = new Map();
  /** The document last seen in each frame: a new one has its own resources, so the old answers go. @type {Map<string, string>} */
  const documents = new Map();
  /**
   * One lane for each frame and document that has a check running. Addresses asked meanwhile wait here and go out together
   * when the running call returns, so a page that asks for 40 addresses at once is scanned twice, not 40 times.
   * A lane of a document that is gone (it was replaced in its frame, or its tab closed) is `dead`: what it still holds is refused.
   * @type {Map<string, { who: { tabId: number, frameId: number, documentId?: string }, waiting: Map<string, ((used: boolean) => void)[]>, dead: boolean }>}
   */
  const lanes = new Map();
  /** Does this browser run a script in the document that is named? Unknown until a call tells. @type {boolean | null} */
  let byDocument = null;
  /** @param {string} prefix */
  const forget = (prefix) => {
    for (const k of [...known.keys()]) if (k.startsWith(prefix)) known.delete(k);
  };

  /**
   * Runs `func` in the document that asked, and no other. A document that is gone is an error here, which gives null.
   * @param {{ tabId: number, frameId: number, documentId?: string }} who @param {Function} func @param {any[]} args
   * @returns {Promise<any>} the result, or null when it cannot be tied to the document that asked
   */
  async function run(who, func, args) {
    const asked = typeof who.documentId === 'string' ? who.documentId : null;
    const call = (/** @type {any} */ target) =>
      scripting.executeScript({
        target,
        world: 'ISOLATED',
        // Without this the call waits for DOMContentLoaded, and every fetch for a sheet waits with it.
        injectImmediately: true,
        func,
        args,
      });
    try {
      /** @type {any[] | null} */
      let results = null;
      if (asked !== null && byDocument !== false) {
        try {
          results = await call({ tabId: who.tabId, documentIds: [asked] });
          byDocument = true;
        } catch (error) {
          if (!unsupported(error)) return null;
          byDocument = false;
        }
      }
      const bound = results !== null;
      if (!bound) results = await call({ tabId: who.tabId, frameIds: [who.frameId] });
      const r = results?.[0];
      if (asked !== null) {
        // By frame the script may have run in a newer document of that frame: the reply must name the one that asked. A reply that
        // names none cannot be tied to it. By document a name is checked when there is one.
        const named = r?.documentId;
        if (bound ? typeof named === 'string' && named !== asked : named !== asked) return null;
      }
      return r?.result ?? null;
    } catch {
      return null;
    }
  }

  /** One pass over the page for the whole batch. @param {{ tabId: number, frameId: number, documentId?: string }} who @param {string[]} urls */
  async function scan(who, urls) {
    const result = await run(who, pageUsesUrls, [urls]);
    return urls.map((_, i) => Array.isArray(result) && result[i] === true);
  }

  /** @param {string} laneKey */
  async function drain(laneKey) {
    const lane = /** @type {NonNullable<ReturnType<typeof lanes.get>>} */ (lanes.get(laneKey));
    while (lane.waiting.size > 0) {
      const batch = [...lane.waiting.entries()].slice(0, MAX_BATCH);
      for (const [url] of batch) lane.waiting.delete(url);
      const answers = await scan(lane.who, batch.map(([url]) => url));
      batch.forEach(([, askers], i) => askers.forEach((resolve) => resolve(!lane.dead && answers[i])));
    }
    if (lanes.get(laneKey) === lane) lanes.delete(laneKey);
  }

  /** The tab is gone: what its lanes wait for is refused, and a result that comes later counts for nothing. @param {string} prefix */
  function retire(prefix) {
    for (const [key, lane] of [...lanes]) {
      if (!key.startsWith(prefix)) continue;
      lane.dead = true;
      lanes.delete(key);
      for (const askers of lane.waiting.values()) askers.forEach((resolve) => resolve(false));
      lane.waiting.clear();
    }
  }

  /** @param {{ tabId: number, frameId: number, documentId?: string }} who @param {string} url @returns {Promise<boolean>} */
  function ask(who, url) {
    const laneKey = `${who.tabId}|${who.frameId}|${who.documentId ?? ''}`;
    let lane = lanes.get(laneKey);
    const starts = !lane;
    if (!lane) {
      lane = { who, waiting: new Map(), dead: false };
      lanes.set(laneKey, lane);
    }
    return new Promise((resolve) => {
      const askers = /** @type {NonNullable<typeof lane>} */ (lane).waiting.get(url);
      if (askers) askers.push(resolve);
      else /** @type {NonNullable<typeof lane>} */ (lane).waiting.set(url, [resolve]);
      if (starts) void drain(laneKey);
    });
  }

  /**
   * A yes from memory, or the check and then its yes kept for a while.
   * @param {{ tabId: number, frameId: number, documentId?: string }} who @param {string} key @param {() => Promise<boolean>} check
   */
  async function remembered(who, key, check) {
    const frame = `${who.tabId}|${who.frameId}|`;
    if (who.documentId !== undefined && documents.get(frame) !== who.documentId) {
      forget(frame);
      documents.set(frame, who.documentId);
      if (documents.size > MAX_KNOWN) documents.delete(/** @type {string} */ (documents.keys().next().value));
    }
    const full = `${frame}${who.documentId ?? ''}|${key}`;
    const at = known.get(full);
    if (at !== undefined && now() - at < TTL_MS) return true;
    const yes = await check();
    // An answer is kept only if its document is still the one of the frame and the tab is still known.
    if (yes && (who.documentId === undefined || documents.get(frame) === who.documentId)) {
      known.set(full, now());
      if (known.size > MAX_KNOWN) known.delete(/** @type {string} */ (known.keys().next().value));
    }
    return yes;
  }

  const verify = (/** @type {{ tabId: number, frameId: number, documentId?: string }} */ who, /** @type {string} */ url) =>
    remembered(who, url, () => ask(who, url));
  return Object.assign(verify, {
    /**
     * The page reads this address itself (`pageReads`). Asked only when the browser cannot judge the worker's own fetch.
     * The answer is not kept: the bytes go to the byte cache of `net.js`.
     * @param {{ tabId: number, frameId: number, documentId?: string }} who @param {string} url @param {string} accept @param {number} max @param {number} ms
     */
    read: (who, url, accept, max, ms) => run(who, pageReads, [url, accept, max, ms]),
    forgetTab(/** @type {number} */ tabId) {
      forget(`${tabId}|`);
      retire(`${tabId}|`);
      for (const k of [...documents.keys()]) if (k.startsWith(`${tabId}|`)) documents.delete(k);
    },
  });
}
