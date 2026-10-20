// @ts-check
// The content scripts of the engine are registered from the worker, only for the pages where the extension can be on.
// A page that no rule can turn on gets no script of ours: no hook in the page world, no isolated world, no gate. The match
// set is always a superset of the pages the gate would theme, never a subset: a rule that the match patterns cannot say
// exactly (a path, a port, a schedule) leaves the host in the set and the gate decides. A site that is switched on while
// its tab is open gets the files injected into that tab.

/** The hook that reports style sheet and shadow root events to the isolated scripts. It runs in the page world. */
export const HOOK_FILES = Object.freeze(['content/main-world/hook.js']);

/** The engine files that every themed page loads, in load order. The other files are asked for by the gate (`ondemand.js`). */
export const ENGINE_FILES = Object.freeze([
  'content/core/namespace.js',
  'content/core/prefetch.js',
  'content/core/match.js',
  'content/core/scheme.js',
  'content/core/loader.js',
  'content/engine/color.js',
  'content/engine/slicer.js',
  'content/engine/rewrite.js',
  'content/engine/sitedark.js',
  'content/engine/sheettext.js',
  'content/engine/shadow.js',
  'content/engine/keep.js',
  'content/engine/detect.js',
  'content/engine/dynamic.js',
  'content/core/boot.js',
]);

export const IDS = Object.freeze({ hook: 'dk-hook', engine: 'dk-engine' });
const ALL = '<all_urls>';
const MAX_PATTERNS = 500;
/** Waits before the next try after a refusal, in milliseconds. After the last one the next change or worker start tries again. */
export const RETRY_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 16000]);
/** How long the plan must stay narrower before the engine is let go in the open tabs. A person who switches a site off and on again quickly keeps the gate, which spaces the changes of the look (WCAG 2.3.1). */
export const RETIRE_MS = 2000;

/** @typedef {{ matches: string[], excludeMatches: string[] }} Plan */

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A site pattern of the settings (`host`, `host/path`, `*.host`, `host:port`) in the parts a match pattern can use.
 * `plain` is a bare host: a rule that covers the host, its subdomains and every port and path, which one match pattern says exactly.
 * @param {string} key
 */
export function parseKey(key) {
  const slash = key.indexOf('/');
  const hostPart = (slash < 0 ? key : key.slice(0, slash)).toLowerCase();
  const withoutPort = hostPart.replace(/:\d+$/, '');
  const wildcard = withoutPort.startsWith('*.');
  const bare = wildcard ? withoutPort.slice(2) : withoutPort;
  // An IPv6 literal in the canonical form of the settings (`[::1]`) is a host of its own: the match pattern names it exactly.
  const valid = (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(bare) && !bare.includes('..')) || (!wildcard && /^\[[0-9a-f:]{2,39}\]$/.test(bare));
  return { bare, valid, plain: valid && !wildcard && withoutPort === hostPart && slash < 0 };
}

/**
 * The match pattern for the region of a rule. The gate applies a key to the host and, for a key of two labels or more, to the hosts below it
 * ("the last label alone is never a parent"), so a key of one label (`localhost`, `com`) stands for that exact host only.
 * @param {string} bare
 */
export const hostPattern = (/** @type {string} */ bare) => (bare.includes('.') ? `*://*.${bare}/*` : `*://${bare}/*`);

/** Does the region of the key `own` hold the host `other`? Both are bare host names. @param {string} own @param {string} other */
export const overlaps = (own, other) => other === own || (own.includes('.') && other.endsWith(`.${own}`));

/**
 * Where the scripts are registered for these settings, or null for nowhere. Every page the gate could theme is inside it.
 *
 * - The extension is off: nowhere.
 * - Only listed sites: the hosts of the rules that are on (a path or a port is left to the gate). A key that is not a plain host name
 *   puts every site in the set.
 * - Otherwise: every page except the hosts of the rules that are off. A rule is left out only when it is a bare host and no other rule
 *   names that host or a host below it, because a more specific rule can turn a part of the host on again, and a match pattern cannot
 *   take a part out of an excluded host.
 * An automation (hours, sun, system scheme) is decided in the page, so it does not narrow the set, except when the worker has alarms for
 * the hours or the sun times and says that Tintly is off for a while (`idle`): then nowhere.
 * @param {any} settings @param {any} siteRules @param {boolean} [idle]
 * @returns {Plan | null}
 */
export function planFor(settings, siteRules, idle = false) {
  if (idle) return null;
  if (isObject(settings) && settings.enabled === false) return null;
  const rules = isObject(siteRules) ? Object.entries(siteRules).filter(([, rule]) => isObject(rule)) : [];
  if (isObject(settings) && settings.listMode === 'onlyListed') {
    /** @type {Set<string>} */
    const set = new Set();
    for (const [key, rule] of rules) {
      if (rule.enabled !== true) continue;
      const parsed = parseKey(key);
      if (!parsed.valid) return { matches: [ALL], excludeMatches: [] };
      set.add(hostPattern(parsed.bare));
    }
    if (set.size === 0) return null;
    if (set.size > MAX_PATTERNS) return { matches: [ALL], excludeMatches: [] };
    return { matches: [...set].sort(), excludeMatches: [] };
  }
  /** @type {Set<string>} */
  const excluded = new Set();
  for (const [key, rule] of rules) {
    const own = parseKey(key);
    if (rule.enabled !== false || !own.plain) continue;
    const covered = rules.some(([other, otherRule]) => {
      if (other === key) return false;
      const p = parseKey(other);
      if (!p.valid || !overlaps(own.bare, p.bare)) return false;
      return !(otherRule.enabled === false && p.plain);
    });
    if (!covered) excluded.add(hostPattern(own.bare));
  }
  return { matches: [ALL], excludeMatches: [...excluded].sort().slice(0, MAX_PATTERNS) };
}

const isAddress = (/** @type {string} */ pattern) => pattern.startsWith('*://[');
/** Does the plan name an IPv6 host? @param {Plan} plan */
const hasAddress = (plan) => plan.matches.some(isAddress) || plan.excludeMatches.some(isAddress);
/** The plan without IPv6 hosts: they stand for every site in the set, and no exclusion of them is made. The gate decides. @param {Plan} plan @returns {Plan} */
export const withoutAddresses = (plan) => ({
  matches: plan.matches.some(isAddress) ? [ALL] : plan.matches,
  excludeMatches: plan.excludeMatches.filter((p) => !isAddress(p)),
});

/** Does a match pattern of the forms `planFor` makes cover this address? @param {string} pattern @param {URL} url */
function patternCovers(pattern, url) {
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  if (pattern === ALL) return web || url.protocol === 'file:' || url.protocol === 'ftp:';
  if (pattern.startsWith('*://*.')) {
    const bare = pattern.slice('*://*.'.length, -2);
    return web && (url.hostname === bare || url.hostname.endsWith(`.${bare}`));
  }
  return web && url.hostname === pattern.slice('*://'.length, -2);
}

/**
 * Is this address inside the plan?
 * @param {Plan | null} plan @param {unknown} address
 */
export function covers(plan, address) {
  if (!plan || typeof address !== 'string') return false;
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (plan.excludeMatches.some((p) => patternCovers(p, url))) return false;
  return plan.matches.some((p) => patternCovers(p, url));
}

/** Where a frame is, and when its document began. It runs in the page world, which every frame has, so a frame that has none of our files gets no isolated world for it. */
function frameAddress() {
  return { href: location.href, origin: location.origin, born: performance.timeOrigin };
}

/** Is the engine of this build alive in the frame? It runs in the isolated world, only in frames the plan covers. */
function engineReady() {
  try {
    const dk = /** @type {any} */ (globalThis).__dk;
    return !!dk && dk.bootStarted === true && dk.build === chrome.runtime.getManifest().version && (typeof dk.alive !== 'function' || dk.alive() === true);
  } catch {
    return false;
  }
}

/** Stop the engine in the frame and empty its namespace, as a newer build does, so the files of a later injection start clean. */
function retireEngine() {
  try {
    const dk = /** @type {any} */ (globalThis).__dk;
    if (dk && typeof dk.retire === 'function') dk.retire();
    if (dk) for (const key of Reflect.ownKeys(dk)) delete dk[key];
  } catch {
    // The context is gone; nothing runs there any more.
  }
}

/**
 * The address a registered script would match a frame by: its own web address, or for a frame without one (about:blank, srcdoc, blob:)
 * the origin it inherits, which `matchOriginAsFallback` uses. Null for an opaque origin (a sandbox, data:): no plan covers it.
 * @param {unknown} found what `frameAddress` returned
 */
export function frameSite(found) {
  if (!found || typeof found !== 'object') return null;
  const { href, origin } = /** @type {{ href?: unknown, origin?: unknown }} */ (found);
  if (typeof href === 'string' && /^https?:/i.test(href)) return href;
  if (typeof origin === 'string' && /^https?:\/\/[^/]+$/i.test(origin)) return `${origin}/`;
  return null;
}

/**
 * Does the new plan leave out a page that the old one covered? Conservative: a false answer is a proof, a true one may be a probe for nothing.
 * @param {Plan | null} before @param {Plan | null} plan
 */
export function narrows(before, plan) {
  if (before === null) return false;
  if (plan === null) return true;
  if (before.matches.some((m) => !plan.matches.includes(m))) return true;
  return plan.excludeMatches.some((m) => !before.excludeMatches.includes(m));
}

/** @param {Plan} plan */
function scriptsFor(plan) {
  // An update keeps a field it does not get, so the exclusions are always sent, also when there are none.
  const shared = { matches: plan.matches, excludeMatches: plan.excludeMatches, runAt: 'document_start', allFrames: true, persistAcrossSessions: true };
  return [
    { id: IDS.hook, js: [...HOOK_FILES], world: 'MAIN', ...shared },
    { id: IDS.engine, js: [...ENGINE_FILES], world: 'ISOLATED', ...shared },
  ];
}

const sameList = (/** @type {unknown} */ a, /** @type {unknown} */ b) => {
  const x = Array.isArray(a) ? [...a].sort() : [];
  const y = Array.isArray(b) ? [...b].sort() : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const sameOrder = (/** @type {unknown} */ a, /** @type {unknown} */ b) => {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Does the registered script have what is wanted? A field the browser leaves out counts as its default. @param {any} have @param {any} want */
function same(have, want) {
  return (
    sameOrder(have.js, want.js) &&
    sameOrder(have.css, want.css) &&
    sameList(have.matches, want.matches) &&
    sameList(have.excludeMatches, want.excludeMatches) &&
    (have.world ?? 'ISOLATED') === want.world &&
    (have.runAt ?? 'document_idle') === want.runAt &&
    (have.allFrames ?? false) === want.allFrames
  );
}

/**
 * Bring the registered scripts with these ids to the wanted list: unregister the ids that are no longer wanted, register the missing
 * ones and update the others in place (never unregister then register, so a page that loads in between still gets its script). A
 * script that is already as wanted costs no call. Resolves to the scripts that were registered before.
 * @param {{ registerContentScripts(s: any[]): Promise<void>, updateContentScripts(s: any[]): Promise<void>, unregisterContentScripts(f?: any): Promise<void>, getRegisteredContentScripts(f?: any): Promise<any[]> }} scripting
 * @param {string[]} ids every id this caller owns @param {any[]} wanted
 * @returns {Promise<Map<string, any>>}
 */
export async function reconcileScripts(scripting, ids, wanted) {
  const existing = await scripting.getRegisteredContentScripts({ ids });
  const byId = new Map(existing.map((s) => [s.id, s]));
  const keep = new Set(wanted.map((s) => s.id));
  const stale = [...byId.keys()].filter((id) => !keep.has(id));
  if (stale.length > 0) await scripting.unregisterContentScripts({ ids: stale });
  const toAdd = [];
  const toChange = [];
  for (const script of wanted) {
    const have = byId.get(script.id);
    if (!have) toAdd.push(script);
    else if (!same(have, script)) toChange.push(script);
  }
  // Chrome 119 and Firefox 128 can match the frames that inherit their origin (about:blank, srcdoc, blob); older ones refuse the field.
  const withFallback = async (/** @type {any[]} */ list, /** @type {'registerContentScripts' | 'updateContentScripts'} */ call) => {
    if (list.length === 0) return;
    try {
      await scripting[call](list.map((s) => ({ ...s, matchOriginAsFallback: true })));
    } catch (error) {
      if (!/matchOriginAsFallback|Unexpected property|Invalid value/i.test(String(/** @type {any} */ (error)?.message))) throw error;
      await scripting[call](list);
    }
  };
  await withFallback(toAdd, 'registerContentScripts');
  await withFallback(toChange, 'updateContentScripts');
  return byId;
}

/** The plan a registered engine script stands for. @param {any} script @returns {Plan | null} */
function planOf(script) {
  return script ? { matches: [...(script.matches ?? [])], excludeMatches: [...(script.excludeMatches ?? [])] } : null;
}

/**
 * @typedef {object} Deps
 * @property {{ registerContentScripts(s: any[]): Promise<void>, updateContentScripts(s: any[]): Promise<void>, unregisterContentScripts(f?: any): Promise<void>, getRegisteredContentScripts(f?: any): Promise<any[]>, executeScript(i: any): Promise<any[]> }} scripting
 * @property {{ query(q: any): Promise<{ id?: number, url?: string, active?: boolean }[]> }} tabs
 * @property {() => Promise<{ settings: any, siteRules: any, idle?: boolean } | null>} read the stored settings, or null when they cannot be read; `idle` says that the schedule keeps Tintly off for a while (alarms are set)
 * @property {(fn: () => void, ms: number) => any} [schedule]
 * @property {(error: unknown) => void} [warn]
 */

/** @param {Deps} deps */
export function createRegister({ scripting, tabs, read, schedule = (fn, ms) => setTimeout(fn, ms), warn = () => {} }) {
  /** @type {Plan | null | undefined} undefined: not applied yet in this run of the worker */
  let applied;
  let appliedSig = '';
  let appliedIdle = false;
  let failed = false;
  let attempts = 0;
  let chain = Promise.resolve();
  /** @type {any} */
  let timer = null;

  /**
   * Run `call` with a target of these frames of a tab: by document when the browser can, so a frame that moved on to another page in
   * between is not reached, else by frame. Rejects when the browser refuses (a protected page, a tab or a document that is gone).
   * @template T
   * @param {number} tabId @param {{ frameId: number, documentId?: unknown }[]} frames @param {(target: any) => Promise<T>} call
   * @returns {Promise<T>}
   */
  async function inFrames(tabId, frames, call) {
    const frameIds = frames.map((f) => f.frameId);
    const documentIds = frames.map((f) => f.documentId);
    if (!documentIds.every((id) => typeof id === 'string')) return call({ tabId, frameIds });
    try {
      return await call({ tabId, documentIds });
    } catch (error) {
      // A browser without documentIds in this call. A document that is gone is not tried by frame, which may hold another page now.
      if (!/documentIds|Unexpected property/i.test(String(/** @type {any} */ (error)?.message))) throw error;
    }
    return call({ tabId, frameIds });
  }

  /** Run the files in these frames of a tab. Resolves to false when the browser refuses. @param {number} tabId @param {{ frameId: number, documentId?: unknown }[]} frames @returns {Promise<boolean>} */
  async function inject(tabId, frames) {
    if (frames.length === 0) return false;
    try {
      await inFrames(tabId, frames, async (target) => {
        await scripting.executeScript({ target, files: [...HOOK_FILES], world: 'MAIN', injectImmediately: true });
        await scripting.executeScript({ target, files: [...ENGINE_FILES], world: 'ISOLATED', injectImmediately: true });
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The frames of a tab with the address each one is matched by. Rejects for a protected page or a discarded tab.
   * @param {number} tabId @returns {Promise<{ frameId: number, documentId?: string, site: string | null, href: string, born: number }[]>}
   */
  async function framesOf(tabId) {
    const found = await scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', injectImmediately: true, func: frameAddress });
    return found
      .filter((/** @type {any} */ r) => typeof r.frameId === 'number')
      .map((/** @type {any} */ r) => ({
        frameId: r.frameId,
        ...(typeof r.documentId === 'string' ? { documentId: r.documentId } : {}),
        site: frameSite(r.result),
        href: typeof r.result?.href === 'string' ? r.result.href : '',
        born: typeof r.result?.born === 'number' ? r.result.born : 0,
      }));
  }

  /**
   * Put the files into the frames of an open tab that the plan covers and that do not have them yet. A frame of a site the plan
   * leaves out gets nothing, also inside a page that is on.
   * @param {number} tabId @param {Plan} plan
   */
  async function injectInto(tabId, plan) {
    let covered;
    let probe;
    try {
      covered = (await framesOf(tabId)).filter((f) => f.site !== null && covers(plan, f.site));
      if (covered.length === 0) return;
      probe = await inFrames(tabId, covered, (target) => scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true, func: engineReady }));
    } catch {
      // A protected page, a discarded tab, or a frame that went away in between.
      return;
    }
    const ready = new Set(probe.filter((/** @type {any} */ r) => r.result === true).map((/** @type {any} */ r) => r.frameId));
    await inject(tabId, covered.filter((f) => !ready.has(f.frameId)));
  }

  /** Run `work` for the open web tabs whose address passes `wanted`: the tab the person looks at first, and a few at a time, because many tabs at once would take the whole machine for a moment. @param {(url: string) => boolean} wanted @param {(tabId: number) => Promise<void>} work */
  async function eachTab(wanted, work) {
    const open = await tabs.query({ url: ['http://*/*', 'https://*/*'] });
    const list = open.filter((tab) => typeof tab.id === 'number' && typeof tab.url === 'string' && wanted(tab.url));
    list.sort((a, b) => Number(b.active === true) - Number(a.active === true));
    let next = 0;
    const lane = async () => {
      while (next < list.length) {
        const tab = list[next++];
        await work(/** @type {number} */ (tab.id));
      }
    };
    await Promise.all([lane(), lane(), lane()]);
  }

  /** @param {Plan} plan @param {(url: string) => boolean} wanted */
  const injectWhere = (plan, wanted) => eachTab(wanted, (tabId) => injectInto(tabId, plan));

  /**
   * The plans in force while a retire waits, from the one before the first narrowing, each with the time it took effect.
   * @typedef {{ plan: Plan | null, since: number }[]} Timeline
   */

  /**
   * Did a document born at `born` get the files under one of these plans? It did when a plan in force at some time since its birth
   * covered it: the registration when it loaded, or an injection into the open tab later.
   * @param {Timeline} timeline @param {number} born @param {string} href
   */
  const hadFiles = (timeline, born, href) => timeline.some((entry, i) => (i + 1 === timeline.length || timeline[i + 1].since > born) && covers(entry.plan, href));

  /**
   * A page the new plan leaves out will never be themed again without a new injection (which the plan brings if the page comes back),
   * so the engine in its frames stops: timers, observers, listeners and the memory go. Only a document that one of the plans of the
   * wait could have given the files to, and that the new plan does not cover, is touched, so a frame that never had the files gets no
   * isolated world; a frame with no address of its own (about:blank, srcdoc) stays idle until it is left.
   * @param {number} tabId @param {Timeline} timeline @param {Plan | null} plan
   */
  async function retireIn(tabId, timeline, plan) {
    let gone;
    try {
      gone = (await framesOf(tabId)).filter((f) => /^https?:/i.test(f.href) && !covers(plan, f.href) && hadFiles(timeline, f.born, f.href));
    } catch {
      return;
    }
    if (gone.length === 0) return;
    try {
      await inFrames(tabId, gone, (target) => scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true, func: retireEngine }));
    } catch {
      // A tab that went away.
    }
  }

  /** @type {any} */
  let retireTimer = null;
  /** @type {Timeline} */
  let timeline = [];

  /**
   * Note a new plan. A narrowing starts or restarts the wait of RETIRE_MS; any change while it waits is noted, so the documents
   * loaded in between are judged by the plan they met.
   * @param {Plan | null} before @param {Plan | null} plan @param {number} since when the new plan took effect, ms since 1970
   */
  function noteRetire(before, plan, since) {
    const narrower = narrows(before, plan);
    if (retireTimer === null && !narrower) return;
    if (retireTimer === null) timeline = [{ plan: before, since: -Infinity }];
    timeline.push({ plan, since });
    if (!narrower) return;
    if (retireTimer !== null) clearTimeout(retireTimer);
    retireTimer = schedule(() => {
      retireTimer = null;
      const seen = timeline;
      timeline = [];
      chain = chain.then(async () => {
        const now = applied;
        if (now === undefined || !seen.some((entry) => narrows(entry.plan, now))) return;
        await eachTab(() => true, (tabId) => retireIn(tabId, seen, now)).catch(warn);
      });
    }, RETIRE_MS);
  }

  /** @param {Plan | null} plan */
  async function apply(plan) {
    const sig = JSON.stringify(plan);
    if (applied !== undefined && sig === appliedSig) return;
    const started = Date.now();
    const byId = await reconcileScripts(scripting, [IDS.hook, IDS.engine], plan === null ? [] : scriptsFor(plan));
    const before = planOf(byId.get(IDS.engine));
    applied = plan;
    appliedSig = sig;
    // Tabs that the new plan covers and the old one did not.
    if (plan !== null) await injectWhere(plan, (url) => covers(plan, url) && !covers(before, url));
    // Tabs where the engine runs and the plan no longer covers a frame: it stops, when the plan has stayed so for a while.
    noteRetire(before, plan, started);
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** One pass over the newest settings. */
  async function pass() {
    const stored = await read();
    if (stored === null) return;
    try {
      const idle = stored.idle === true;
      const wanted = planFor(stored.settings, stored.siteRules, idle);
      try {
        await apply(wanted);
      } catch (error) {
        // A browser that does not take an IPv6 host in a match pattern must not lose the whole registration: the pages of those hosts
        // are covered by the wider set, and the gate decides there as it does for any rule the patterns cannot say.
        if (!wanted || !hasAddress(wanted)) throw error;
        warn(error);
        await apply(withoutAddresses(wanted));
      }
      appliedIdle = idle;
      failed = false;
      attempts = 0;
      clearTimer();
    } catch (error) {
      failed = true;
      appliedSig = '';
      applied = undefined;
      warn(error);
      if (attempts < RETRY_MS.length && timer === null) {
        const wait = RETRY_MS[attempts++];
        timer = schedule(() => {
          timer = null;
          void sync();
        }, wait);
      }
    }
  }

  /** Make the registration match the settings. Calls queue up; each pass reads the newest settings. @returns {Promise<void>} */
  function sync() {
    chain = chain.then(pass, pass);
    return chain;
  }

  return {
    sync,
    /** Resolves when everything queued so far is done. */
    settled: () => chain,
    /** Is the last pass a failure? Then the worker injects into pages as they load. */
    get failed() {
      return failed;
    },
    get attempts() {
      return attempts;
    },
    /** Did the last good pass leave the engine out because of the schedule? */
    get idle() {
      return appliedIdle;
    },
    /** The plan that is in force, or undefined before the first pass succeeded. */
    get plan() {
      return applied;
    },
    covers: (/** @type {unknown} */ address) => covers(applied ?? null, address),
    /** After install or update: put the files into every open page the plan covers that does not have them. */
    async injectOpenTabs() {
      await chain;
      const plan = applied;
      if (plan) await injectWhere(plan, (url) => covers(plan, url));
    },
    /**
     * A page that is loading while the registration is refused. The files go into the documents of the tab whose top address is the one that
     * began to load, by document, so a page that is still being left does not get them, and only into the frames that the plan of the
     * stored settings covers. The address is asked a few times because the event of the tab can come before the new document exists.
     * @param {number} tabId @param {string} address
     */
    async injectLoading(tabId, address) {
      const stored = await read();
      const plan = stored ? planFor(stored.settings, stored.siteRules, stored.idle === true) : null;
      if (plan === null) return false;
      const same = (/** @type {string} */ href) => href.split('#')[0] === address.split('#')[0];
      for (let attempt = 0; attempt < 4; attempt++) {
        let frames;
        try {
          frames = await framesOf(tabId);
        } catch {
          return false;
        }
        const top = frames.find((f) => f.frameId === 0);
        if (top && same(top.href)) return inject(tabId, frames.filter((f) => f.site !== null && covers(plan, f.site)));
        await new Promise((resolve) => schedule(() => resolve(undefined), 50 * (attempt + 1)));
      }
      return false;
    },
  };
}
