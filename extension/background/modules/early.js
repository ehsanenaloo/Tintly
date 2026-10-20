// @ts-check
// The first paint. A page must not show a light frame before the theme is on, because a flash between light and dark
// can hurt people who get migraines. A script that the browser itself injects at document_start runs before the first paint, and it does
// not wait for the settings to be read. It paints a quick dark version of the page (dark boxes, light text) until the page script sets
// `data-dk-go` on the root, when the real theme is ready. A page script cannot reach a registered style, so the quick version is a
// registered script that puts it in a constructed sheet (sheet.js).
import { RETRY_MS, hostPattern, overlaps, parseKey, reconcileScripts } from './register.js';

const ID = 'dk-early';
const RESPECT_ID = 'dk-early-respect';
const MAX_PATTERNS = 500;
const FILES = Object.freeze({ hold: ['content/early/hold.js', 'content/early/sheet.js'], canvas: ['content/early/canvas.js', 'content/early/sheet.js'], respect: 'content/early/respect.css' });

/**
 * The match pattern for a site pattern of the settings. A rule with a port, a path or `*.` is not the same set as the host pattern, and the gate
 * decides those pages, so the pattern stands for the whole host and its subdomains: a hold that is left out only costs the first frame, a hold
 * that is kept on a page that is off is a flash. Returns [] for a key that is not a host name.
 * @param {string} pattern @returns {string[]}
 */
export function matchPatternsFor(pattern) {
  const parsed = parseKey(pattern);
  return parsed.valid ? [hostPattern(parsed.bare)] : [];
}

/**
 * What to register for these settings, or null when nothing should be.
 *
 * Dark mode registers the quick dark version. The E-ink and Paper mode registers nothing: the paper tone depends on the
 * settings and a registered file cannot, and the page is light, so there is no dark frame to prevent. The engine paints the
 * paper canvas at its first task. A registered rule for every element (to hold animations off until the engine is ready)
 * stays in the page for good and made every style update on a busy page several times as slow, so motion is cut by
 * the engine's own style instead. Light mode registers nothing. A site rule that names a different mode is left out.
 *
 * The hold is exact or absent. A host that has a rule the match patterns cannot say (a port, a path, `*.`), or that has a more specific
 * rule below it, gets no hold: the gate decides there. With more than 500 hosts to leave out or to list there is no hold at all.
 * @param {any} settings @param {Record<string, any>} siteRules
 * @returns {{ matches: string[], excludeMatches: string[], js: string[], respect: { excludeMatches: string[] } | null } | null}
 */
export function planFor(settings, siteRules) {
  if (!settings || settings.enabled === false) return null;
  // A schedule is decided in the page.
  if (settings.automation && settings.automation.mode !== 'none') return null;
  // Only the dark mode has a dark first paint; the light, E-ink and original modes keep the page's own first paint.
  const raw = settings.theme?.mode;
  const mode = raw === 'eink' || raw === 'light' || raw === 'original' ? raw : 'dark';
  if (mode !== 'dark') return null;
  const js = settings.holdPaint === false ? FILES.canvas : FILES.hold;
  const entries = Object.entries(siteRules ?? {}).filter(([, r]) => r && typeof r === 'object');
  // A rule with its own mode needs the first paint of that mode, which this file does not give.
  const otherMode = (/** @type {any} */ r) => typeof r?.theme?.mode === 'string' && r.theme.mode !== mode;
  if (settings.listMode === 'onlyListed') {
    /** @type {Set<string>} */
    const hosts = new Set();
    for (const [key, r] of entries) {
      const own = parseKey(key);
      if (r.enabled !== true || otherMode(r) || !own.plain) continue;
      const nested = entries.some(([other, o]) => {
        const p = parseKey(other);
        return other !== key && p.valid && overlaps(own.bare, p.bare) && !(o.enabled === true && !otherMode(o) && p.plain);
      });
      if (!nested) hosts.add(hostPattern(own.bare));
    }
    if (hosts.size === 0 || hosts.size > MAX_PATTERNS) return null;
    return { matches: [...hosts].sort(), excludeMatches: [], js, respect: null };
  }
  /** @type {Set<string>} */
  const left = new Set();
  for (const [key, r] of entries) if (r.enabled === false || otherMode(r)) for (const p of matchPatternsFor(key)) left.add(p);
  if (left.size > MAX_PATTERNS) return null;
  const excludeMatches = [...left].sort();
  // The page script cannot know the settings in its first frames. Where the page would be left alone when it keeps one scheme, a marker
  // style says so, and the script may release such a page at once. A site the person turned on by hand is themed whatever the page says.
  /** @type {Set<string>} */
  const forced = new Set();
  for (const [key, r] of entries) if (r.enabled === true) for (const p of matchPatternsFor(key)) forced.add(p);
  const respectOut = [...new Set([...excludeMatches, ...forced])].sort();
  const respect = settings.respectOnlyLight === false || respectOut.length > MAX_PATTERNS ? null : { excludeMatches: respectOut };
  return { matches: ['http://*/*', 'https://*/*'], excludeMatches, js, respect };
}

/**
 * @param {{ scripting: { registerContentScripts(s: any[]): Promise<void>, updateContentScripts(s: any[]): Promise<void>, unregisterContentScripts(f?: any): Promise<void>, getRegisteredContentScripts(f?: any): Promise<any[]> }, schedule?: (fn: () => void, ms: number) => any, warn?: (e: unknown) => void }} deps
 */
export function createEarly({ scripting, schedule = (fn, ms) => setTimeout(fn, ms), warn = () => {} }) {
  /** The plan this run of the worker has put in place; empty until the first pass worked. */
  let last = '';
  let chain = Promise.resolve();
  let attempts = 0;
  /** @type {any} */
  let timer = null;
  /** @type {{ settings: any, siteRules: Record<string, any> } | null} */
  let newest = null;

  /** The registered scripts for a plan: the page script of the hold, and the marker style for pages that keep one scheme. @param {NonNullable<ReturnType<typeof planFor>>} plan */
  function scriptsFor(plan) {
    const base = { matches: plan.matches, runAt: 'document_start', allFrames: true, persistAcrossSessions: true, world: 'ISOLATED' };
    /** @type {any[]} */
    const list = [{ ...base, id: ID, js: plan.js, excludeMatches: plan.excludeMatches }];
    if (plan.respect) list.push({ ...base, id: RESPECT_ID, css: [FILES.respect], excludeMatches: plan.respect.excludeMatches });
    return list;
  }

  async function apply(/** @type {ReturnType<typeof planFor>} */ plan) {
    const signature = JSON.stringify(plan);
    if (signature === last) return;
    // The browser's own list is compared, so a worker that starts again changes nothing that is already right (no gap, no flash).
    await reconcileScripts(scripting, [ID, RESPECT_ID], plan ? scriptsFor(plan) : []);
    last = signature;
  }

  async function pass() {
    if (!newest) return;
    try {
      await apply(planFor(newest.settings, newest.siteRules));
      attempts = 0;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    } catch (error) {
      // The page script still themes the page, only the first frame is unprotected; the registration is tried again.
      last = '';
      warn(error);
      if (attempts < RETRY_MS.length && timer === null) {
        const wait = RETRY_MS[attempts++];
        timer = schedule(() => {
          timer = null;
          chain = chain.then(pass, pass);
        }, wait);
      }
    }
  }

  return {
    /** Make the registered scripts match the settings. Calls are queued so two changes never overlap. @param {any} settings @param {Record<string, any>} siteRules */
    refresh(settings, siteRules) {
      newest = { settings, siteRules };
      chain = chain.then(pass, pass);
      return chain;
    },
  };
}
