// @ts-check
// Injection of the optional engine modules on request of a page script. A page script asks by name; the worker maps the
// name to an extension file from a fixed list and injects it into the frame that asked, in the isolated world, so the
// module joins the namespace of the other content scripts of that frame. Nothing else can be injected this way.

/** Name to extension file. The only files that can be injected on request. */
export const MODULES = Object.freeze({
  schedule: 'content/core/schedule.js',
  filter: 'content/engine/filter.js',
  static: 'content/engine/static.js',
  images: 'content/engine/images.js',
  imagebg: 'content/engine/imagebg.js',
  backdrop: 'content/engine/backdrop.js',
  calm: 'content/engine/calm.js',
  extras: 'content/engine/extras.js',
  readability: 'content/engine/readability.js',
  einkpalette: 'content/engine/einkpalette.js',
  cvd: 'content/engine/cvd.js',
  sitetheme: 'content/engine/sitetheme.js',
  shadowroots: 'content/engine/shadowroots.js',
  leftovers: 'content/core/leftovers.js',
});

/**
 * Who goes first when the worker is busy. 0: the parts a page's first look waits for (the decision, the engine, the page's own dark
 * theme, the E-ink palette, the color vision model, the shadow roots). 1: parts of the look that nothing waits for. 2: the picture and reading parts.
 */
const RANK = Object.freeze({
  schedule: 0, leftovers: 0, sitetheme: 0, einkpalette: 0, cvd: 0, filter: 0, static: 0, shadowroots: 0,
  calm: 1, extras: 1,
  images: 2, imagebg: 2, backdrop: 2, readability: 2,
});

export const LIMITS = Object.freeze({
  /** Injections running at once. The browser does one at a time per tab anyway; more only queue inside it. */
  RUNNING: 3,
  /** Of those, at most this many of rank 2, and none while a better one waits. */
  RUNNING_LAST: 1,
  /** Requests of one frame in the window. Every module is asked for once per frame, with room for retries. */
  FRAME_COUNT: 24,
  /** Requests of one tab in the window, all frames together. */
  TAB_COUNT: 600,
  WINDOW_MS: 60_000,
});

/** Counters kept at most; above this the quiet ones are dropped. */
const MAX_KEYS = 500;

/**
 * @param {{ scripting: { executeScript: (injection: any) => Promise<any> }, now?: () => number }} deps
 */
export function createOnDemand({ scripting, now = Date.now }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  /** Requests that wait for a free place, and the ones running; a repeated request for the same document and module shares the answer. */
  /** @type {{ rank: number, run: () => Promise<any> }[]} */
  const waiting = [];
  /** @type {Map<string, Promise<any>>} */
  const same = new Map();
  let running = 0;
  let runningLast = 0;

  function pump() {
    while (running < LIMITS.RUNNING && waiting.length > 0) {
      let at = -1;
      for (let i = 0; i < waiting.length; i++) {
        const w = waiting[i];
        if (w.rank === 2 && runningLast >= LIMITS.RUNNING_LAST) continue;
        if (at < 0 || w.rank < waiting[at].rank) at = i;
      }
      if (at < 0) return;
      const [job] = waiting.splice(at, 1);
      running += 1;
      if (job.rank === 2) runningLast += 1;
      void job.run().finally(() => {
        running -= 1;
        if (job.rank === 2) runningLast -= 1;
        pump();
      });
    }
  }

  /** Run `work` when a place is free, the better ranks first. @template T @param {number} rank @param {() => Promise<T>} work @returns {Promise<T>} */
  function queued(rank, work) {
    return new Promise((resolve) => {
      waiting.push({ rank, run: () => work().then(resolve, () => resolve(/** @type {any} */ ({ ok: false, code: 'failed' }))) });
      pump();
    });
  }

  /** @param {string} key @param {number} max */
  function allow(key, max) {
    const t = now();
    // A page can make many frames. The counters of frames that were quiet for a whole window are dropped.
    if (hits.size > MAX_KEYS) for (const [k, times] of hits) if (times.every((x) => t - x >= LIMITS.WINDOW_MS)) hits.delete(k);
    const list = (hits.get(key) ?? []).filter((x) => t - x < LIMITS.WINDOW_MS);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(t);
    hits.set(key, list);
    return true;
  }

  return {
    /**
     * @param {unknown} name
     * @param {{ tabId: number, frameId: number, documentId?: string }} who
     * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
     */
    async inject(name, who) {
      if (typeof name !== 'string' || !Object.hasOwn(MODULES, name)) return { ok: false, code: 'invalid' };
      // The allowance belongs to a document: a tab that loads page after page must not run out of it (the browser names the document, a page cannot choose it).
      const frameKey = typeof who.documentId === 'string' ? `${who.tabId}:${who.frameId}:${who.documentId}` : `${who.tabId}:${who.frameId}`;
      // A page that asks again because the answer is slow gets the answer of the first request: nothing is injected twice.
      const again = same.get(`${frameKey}:${name}`);
      if (again) return again;
      if (!allow(`${who.tabId}`, LIMITS.TAB_COUNT) || !allow(frameKey, LIMITS.FRAME_COUNT)) return { ok: false, code: 'rate' };
      const job = queued(RANK[/** @type {keyof typeof RANK} */ (name)] ?? 2, () => inject(name, who));
      same.set(`${frameKey}:${name}`, job);
      try {
        return await job;
      } finally {
        same.delete(`${frameKey}:${name}`);
      }
    },
    get tracked() {
      return hits.size;
    },
    forgetTab(/** @type {number} */ tabId) {
      for (const key of [...hits.keys()]) if (key === `${tabId}` || key.startsWith(`${tabId}:`)) hits.delete(key);
    },
  };

  /**
   * @param {string} name
   * @param {{ tabId: number, frameId: number, documentId?: string }} who
   * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
   */
  async function inject(name, who) {
    try {
      const files = [MODULES[/** @type {keyof typeof MODULES} */ (name)]];
      // The document that asked, not the frame: a frame that navigated meanwhile holds another document, which has not asked.
      if (typeof who.documentId === 'string') {
        try {
          await scripting.executeScript({ target: { tabId: who.tabId, documentIds: [who.documentId] }, files, world: 'ISOLATED', injectImmediately: true });
          return { ok: true };
        } catch (error) {
          // A browser without `documentIds` in this call falls back to the frame; any other refusal is final.
          if (!/documentIds|Unexpected property|Invalid value/i.test(String(/** @type {any} */ (error)?.message))) return { ok: false, code: 'failed' };
        }
      }
      await scripting.executeScript({ target: { tabId: who.tabId, frameIds: [who.frameId] }, files, world: 'ISOLATED', injectImmediately: true });
      return { ok: true };
    } catch {
      return { ok: false, code: 'failed' };
    }
  }
}
