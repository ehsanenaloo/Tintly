// @ts-check
// The gate. Reads the stored decision and starts or stops the engine. prefetch.js starts the read while the other files parse.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk || dk.bootStarted) return;
  dk.bootStarted = true;

  const ns = /** @type {Record<string, any>} */ (dk);
  const dynamic = /** @type {any} */ (dk.dynamic);
  const match = /** @type {any} */ (dk.match);
  const need = /** @type {(name: string) => Promise<boolean>} */ (ns.need);
  const optional = /** @type {any} */ (ns.optional);
  if (!dynamic || !match || !need || !optional) return releaseHeld();
  const type = document.contentType;
  // A bare SVG file in a tab has a white canvas too.
  const svgDoc = type === 'image/svg+xml' && document.documentElement instanceof SVGElement && window === window.top;
  if (!svgDoc) {
    if (!(document.documentElement instanceof HTMLElement)) return releaseHeld();
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml') return releaseHeld();
  }

  // A gate that ends before it decides frees a page that the first-paint hold may have taken (the hold itself skips other kinds of document).
  function releaseHeld() {
    if (/** @type {any} */ (globalThis).__dkHold) leave();
  }

  const KEYS = ['settings', 'siteRules', 'userFixes', 'darkSites'];
  const SOURCE = ['siteRules', 'userFixes', 'darkSites'];
  const META_KEY = 'gb.meta';
  /** Marks data that came from the slice of the host, not from the whole sections. */
  const SLICE = '__slice';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let sourceTimer;
  let last = '';
  // Counts decisions: an older call that wakes after a wait stops.
  let applyNo = 0;
  // The page is in its first load until a decision reaches it. Every call reads this; only the call that lands ends it, so a call dropped for a newer one leaves the first load to that one.
  let firstLoad = ns.initialReadyState === 'loading';
  // The key of a decision whose staged build failed: it is built in place the second time.
  let directFor = '';
  /** @type {string | null} */
  let lastCss = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flipTimer;
  // The look the page shows now and when it changed; changes are spaced out (see `apply`).
  /** @type {string | null} */
  let shown = null;
  let shownAt = 0;
  const MIN_FLIP_MS = 340;
  /** How long the wait for a part runs before the status turns to `pending`. A page that is decided at once never says it. */
  const PENDING_MS = 1000;
  const SETTLE_MAX_MS = 500;
  /** @type {Record<string, any> | null} */
  let builtinFix = null;
  let builtinDark = false;
  let askedBuiltin = false;
  // The address and number of the newest ask, and whether the shipped data of this host has rules with a path.
  let askedRoute = '';
  let askSeq = 0;
  let builtinPaths = false;
  let darkVerdict = false;
  let probeArmed = false;
  let probing = false;
  let watching = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let clockTimer;
  // This build was retired by a newer one or because its extension is gone.
  let retired = false;
  /** The data of the last read. @type {Record<string, any> | null} */
  let kept = null;
  // Each change of the stored data counts one up. A read is kept only when no change came while it ran, so `kept` is current exactly when `keptRev === dataRev`.
  let dataRev = 0;
  let keptRev = 0;
  const dataChanged = () => {
    dataRev += 1;
  };
  /** Does the last decision depend on the path (a rule, a fix or a dark-list entry with a path)? Only then does a route change decide again. */
  let pathRules = false;
  let lastReported = '';
  let retries = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  // When the schedule next changes, and the address of the last decision.
  /** @type {number | null} */
  let nextAt = null;
  let routeKey = location.host + location.pathname;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let routePoll;
  // The author asked for no theme: meta `tintly` with content `off`, or `data-tintly="off"` on the root.
  let authorSeen = false;
  // The scheme a page keeps (`only light`, `only dark`), seen by the gate or the engine. `keep` is what the last decision knows.
  /** @type {string | null} */
  let schemeSeen = null;
  /** @type {string | null} */
  let engineScheme = null;
  /** @type {{ respect: boolean, forced: boolean, mode: string } | null} */
  let keep = null;

  /** @param {unknown} v */
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** Does the person use a schedule? Only the schedule module can judge it. @param {Record<string, any>} settings */
  const scheduleSet = (settings) => isObject(settings.automation) && typeof settings.automation.mode === 'string' && settings.automation.mode !== '' && settings.automation.mode !== 'none';
  /** A decision that leaves the page exactly as the page wrote it: off by the master switch or a rule, or waiting for the schedule. @param {{ status: string }} d */
  const untouched = (d) => d.status === 'off' || d.status === 'pending' || (d.status === 'site-off' && !authorSeen);

  /**
   * The address the site rules are matched on. A frame with no address of its own (`about:blank`, `srcdoc`, `blob:`, `data:`) uses the nearest ancestor that has one.
   * @returns {{ host: string, pathname: string }}
   */
  function siteAddress() {
    const web = (/** @type {string} */ protocol) => protocol === 'http:' || protocol === 'https:';
    if (web(location.protocol) || window === window.top) return { host: location.host, pathname: location.pathname };
    try {
      // A parent of the same origin can be read; any other throws.
      for (let w = window.parent; ; w = w.parent) {
        if (web(w.location.protocol)) return { host: w.location.host, pathname: w.location.pathname };
        if (w === w.parent) break;
      }
    } catch {
      // Use the origins the browser lists.
    }
    try {
      const origins = /** @type {any} */ (location).ancestorOrigins;
      if (origins) {
        for (let i = 0; i < origins.length; i++) {
          const u = new URL(origins[i]);
          if (web(u.protocol)) return { host: u.host, pathname: '/' };
        }
      }
    } catch {
      // No list: the frame keeps its empty address.
    }
    return { host: location.host, pathname: location.pathname };
  }

  /** Did the page author ask for no theme? */
  function authorOff() {
    try {
      if (document.documentElement.getAttribute('data-tintly') === 'off') return true;
      return document.head?.querySelector('meta[name="tintly" i][content="off" i]') != null;
    } catch {
      return false;
    }
  }

  const declaredScheme = () => /** @type {string | null} */ (/** @type {any} */ (ns.scheme)?.declared() ?? null);

  /** Would a page that keeps this scheme be left alone now? @param {string} kind */
  function keeps(kind) {
    return keep !== null && keep.respect && !keep.forced && (kind === 'dark' || keep.mode === 'dark');
  }

  /** Stop the engines other than `keep`. @param {string} [keep] */
  function stopEngines(keep) {
    if (keep !== 'dynamic') dynamic.stop();
    if (keep !== 'filter') ns.filter?.stop();
    if (keep !== 'static') ns.staticEngine?.stop();
  }

  /** Release the page in this task. The engine may be in its first pass, so it stops at the end of the task. */
  function releaseNow() {
    go();
    queueMicrotask(() => {
      stopEngines();
      go();
      void apply();
    });
  }

  /** The engine found a scheme in the sheets. Returns true when the page is left alone. @param {string} kind */
  function engineSawScheme(kind) {
    engineScheme = kind;
    if (!keeps(kind)) return false;
    releaseNow();
    return true;
  }

  const bucketKey = (/** @type {string} */ host) => `gb:${ns.bucketOf(host)}`;

  /**
   * The data of the decision from the slice that the worker keeps for this host, or null when the copy is missing or was made for another revision of the data
   * (then the whole sections are read). `asked` is the key the read was made for.
   * @param {Record<string, any>} raw @param {string} asked
   */
  function shaped(raw, asked) {
    const key = bucketKey(siteAddress().host);
    const meta = raw[META_KEY];
    if (asked !== key || !isObject(meta) || meta.v !== 1 || meta.rev !== (typeof raw.updatedAt === 'number' ? raw.updatedAt : null)) return null;
    const part = isObject(raw[key]) ? raw[key] : {};
    const names = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : []);
    return { settings: raw.settings, siteRules: isObject(part.r) ? part.r : {}, userFixes: isObject(part.f) ? part.f : {}, darkSites: { add: names(part.a), remove: names(part.d) }, [SLICE]: key };
  }

  /** Read what the decision needs: the slice for this host, or the sections when the copy cannot be used. */
  async function readStored() {
    const key = bucketKey(siteAddress().host);
    const raw = await chrome.storage.local.get(['settings', 'updatedAt', META_KEY, key]);
    return shaped(raw, key) ?? chrome.storage.local.get(KEYS);
  }

  /** @param {Record<string, any>} stored */
  function decide(stored) {
    const site = siteAddress();
    const settings = isObject(stored.settings) ? stored.settings : {};
    const rule = match.find(isObject(stored.siteRules) ? stored.siteRules : null, site.host, site.pathname);
    const switched = match.findEnabled(isObject(stored.siteRules) ? stored.siteRules : null, site.host, site.pathname);
    const siteOn = switched ? switched.enabled : settings.listMode !== 'onlyListed';
    const userFix = match.find(isObject(stored.userFixes) ? stored.userFixes : null, site.host, site.pathname);
    const fix = isObject(userFix) ? userFix : builtinFix;
    const dyn = isObject(fix) && isObject(fix.dynamic) ? fix.dynamic : {};
    const engine =
      isObject(rule) && typeof rule.engine === 'string'
        ? rule.engine
        : isObject(fix) && typeof fix.engine === 'string'
          ? fix.engine
          : settings.engine ?? 'auto';
    const forcedColors = typeof matchMedia === 'function' && matchMedia('(forced-colors: active)').matches;
    const systemDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const automation = isObject(settings.automation) ? settings.automation : {};
    // A schedule is set but its module has not come (or never will): the hours cannot be judged.
    const scheduleUnknown = !ns.schedule && scheduleSet(settings);
    const auto = ns.schedule ? ns.schedule.evaluate(isObject(settings.automation) ? settings.automation : undefined, new Date(), systemDark) : { active: null, behavior: automation.behavior === 'scheme' ? 'scheme' : 'onOff', next: null };
    // "Turn on and off" is off outside the active hours; "switch scheme" stays on. Hours that cannot be judged count as off hours: the page stays as the page wrote it until the module comes.
    const scheduledOff = auto.active === false && auto.behavior === 'onOff';
    const scheduleWait = scheduleUnknown && auto.behavior === 'onOff';
    const forced = switched?.enabled === true;
    authorSeen = authorOff();
    const authorOpt = authorSeen && !forced;
    const darkSites = isObject(stored.darkSites) ? stored.darkSites : {};
    const toMap = (/** @type {unknown} */ list) => Object.fromEntries((Array.isArray(list) ? list : []).map((p) => [p, true]));
    // A fix can say the page is not dark although the list says so. The person's own list wins.
    const notDark = isObject(fix) && fix.notDark === true;
    const userDark = !!match.find(toMap(darkSites.add), site.host, site.pathname);
    const listedDark = ((builtinDark && !notDark) || userDark) && !match.find(toMap(darkSites.remove), site.host, site.pathname);
    const detecting = settings.detectDark !== false && !forced;
    const baseMode = isObject(settings.theme) ? settings.theme.mode : undefined;
    const scheduled = auto.active !== null && auto.behavior === 'scheme' ? (auto.active ? automation.activeMode ?? 'dark' : automation.idleMode ?? 'light') : null;
    // The last of schedule, fix and site rule that names a mode wins.
    const modeOf = (/** @type {any} */ t) => (isObject(t) && typeof t.mode === 'string' ? t.mode : undefined);
    const mode = modeOf(isObject(rule) ? rule.theme : null) ?? modeOf(dyn.theme) ?? scheduled ?? baseMode ?? 'dark';
    const wantsDark = mode === 'dark';
    schemeSeen = declaredScheme();
    const respect = settings.respectOnlyLight !== false;
    keep = { respect, forced, mode };
    const pageKind = schemeSeen ?? engineScheme;
    // A page that keeps one scheme is left alone unless the site was turned on by hand; `only light` matters in the dark mode only.
    // The page's own colors (`original`) do not fight a page that keeps its scheme.
    const pageOpt = respect && !forced && pageKind !== null && mode !== 'original' && (pageKind === 'dark' || mode === 'dark');
    const ownTheme = {
      ...(isObject(settings.theme) ? settings.theme : {}),
      ...(scheduled !== null ? { mode: scheduled } : {}),
      ...(isObject(dyn.theme) ? dyn.theme : {}),
      ...(isObject(rule) && isObject(rule.theme) ? rule.theme : {}),
    };
    const cvd = /** @type {any} */ (ns.color)?.cvdWanted?.(ownTheme) === true;
    // The correction needs our colors, so a page that is dark by itself is themed too; the check for a dark page rests.
    const skipDark = detecting && wantsDark && !cvd && (listedDark || (darkVerdict && !notDark));
    // The page's own colors with no correction and no underline: there is nothing to do.
    const idle = mode === 'original' && !cvd && ownTheme.linkUnderline !== true;
    const on = !idle && settings.enabled !== false && siteOn && !forcedColors && !scheduledOff && !scheduleWait && !skipDark && !authorOpt && !pageOpt;
    const staticData = isObject(fix) && isObject(fix.static) ? fix.static : null;
    const hasStatic = !!staticData && ['bg', 'fg', 'border'].some((k) => Array.isArray(staticData[k]) && staticData[k].length > 0);
    const chosen = engine === 'filter' || engine === 'filterPlus' ? engine : engine === 'static' && hasStatic && mode !== 'original' ? 'static' : 'dynamic';
    // On `auto`, a page with a sheet the Dynamic engine cannot read goes to the Filter+ engine.
    const canFall = engine === 'auto' && chosen === 'dynamic' && wantsDark;
    const kind = canFall && unreachableFallback ? 'filterPlus' : chosen;
    const { css: globalCss, ...theme } = /** @type {Record<string, any>} */ (ownTheme);
    const ruleCss = isObject(rule) && rule.cssHeld !== true ? rule.css : '';
    const fixCss = isObject(userFix) && userFix.cssHeld === true ? '' : dyn.css;
    const css = [settings.cssHeld === true ? '' : globalCss, ruleCss, fixCss].filter((c) => typeof c === 'string' && c.trim() !== '').join('\n');
    const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
    const invert = kind === 'dynamic' ? list(dyn.invert) : [];
    const ignoreInline = list(dyn.ignoreInline);
    const ignoreCssUrl = list(dyn.ignoreCssUrl);
    const ignoreImage = list(dyn.ignoreImage);
    const status = settings.enabled === false || forcedColors || scheduledOff ? 'off' : !siteOn || authorOpt ? 'site-off' : scheduleWait ? 'pending' : pageOpt ? 'page-scheme' : skipDark ? 'dark-detected' : canFall && unreachableFallback ? 'fallback' : 'on';
    const hasPath = (/** @type {unknown[]} */ keys) => keys.some((k) => typeof k === 'string' && k.includes('/'));
    const route =
      hasPath(Object.keys(isObject(stored.siteRules) ? stored.siteRules : {})) ||
      hasPath(Object.keys(isObject(stored.userFixes) ? stored.userFixes : {})) ||
      hasPath(Array.isArray(darkSites.add) ? darkSites.add : []) ||
      hasPath(Array.isArray(darkSites.remove) ? darkSites.remove : []) ||
      builtinPaths;
    // A page that turns dark by itself would keep its own colors and miss the correction, so the hint stays off with it.
    const hint = (on || skipDark) && kind === 'dynamic' && wantsDark && theme.useSiteDark !== false && !cvd;
    const einkOn = on && mode === 'eink';
    const motion = einkOn && /** @type {any} */ (ns.color).einkSettings(theme).reducedMotionHint === true;
    return { on, kind, canFall, theme, hint, motion, eink: einkOn, cvd: on && cvd, mode, hold: settings.holdPaint !== false, status, ignoreInline, ignoreCssUrl, css, invert, next: auto.next, ignoreImage, route, staticData: kind === 'static' ? staticData : null, probe: on && detecting && wantsDark && !cvd && !listedDark && !notDark, recheck: skipDark && darkVerdict && !listedDark && !notDark };
  }

  /** A sheet could not be read and the page stayed light: this page uses the Filter+ engine. */
  let unreachableFallback = false;

  /** @type {any} */
  let cssKeeper = null;

  /** The custom CSS element: the user's CSS last, then the rule that puts back the elements the fix inverts. */
  function setCss(/** @type {string} */ text) {
    if (text === lastCss) return;
    lastCss = text;
    let el = /** @type {HTMLStyleElement | null} */ (document.querySelector('style[data-dk="css"]'));
    if (text === '') {
      cssKeeper?.stop();
      cssKeeper = null;
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.setAttribute('data-dk', 'css');
      (document.head ?? document.documentElement).append(el);
    }
    el.textContent = text;
    if (!cssKeeper && ns.keep) {
      const own = el;
      cssKeeper = ns.keep.create();
      cssKeeper.track(own, () => (document.head ?? document.documentElement).append(own));
    }
  }

  /** The driver of the detect module, asked for when the decision wants it (`watching`). @type {{ arm: () => void, watchRoot: () => void, recheck: () => void, stop: () => void } | null} */
  let prober = null;
  let rechecking = false;

  async function armProbe() {
    if (probeArmed || probing) return;
    probing = true;
    const loaded = ns.detect ? true : await need('detect');
    probing = false;
    if (!loaded || retired || !watching) return;
    probeArmed = true;
    const driver = ns.detect.createDriver({
      watching: () => watching,
      dark: () => darkVerdict,
      setDark: (/** @type {boolean} */ v) => {
        darkVerdict = v;
      },
      rechecking: () => rechecking,
      apply: () => void apply(),
    });
    prober = driver;
    driver.arm();
  }

  /** Stop the driver of the dark-page check and free what it holds; the next decision that wants it makes a new one. */
  function dropProbe() {
    try {
      prober?.stop();
    } catch {
      // The context may be gone.
    }
    prober = null;
    probeArmed = false;
  }

  /** The worker fetches an image of another origin so it can be read. */
  async function fetchImage(/** @type {string} */ url) {
    try {
      // The worker answers with a 32 by 32 copy (`sample`) when it can make one, else with the file (`base64`); images.js checks the types.
      const reply = await chrome.runtime.sendMessage({ type: 'dk.net.image', url, sample: true });
      return reply && reply.ok === true ? { mime: String(reply.mime), base64: reply.base64, sample: reply.sample } : null;
    } catch {
      return null;
    }
  }

  /** Ask the worker for the shipped fix and dark-list entry of this site; a hit changes the themed page. */
  function askBuiltin() {
    askedBuiltin = true;
    const seq = ++askSeq;
    const route = location.host + location.pathname;
    askedRoute = route;
    const retry = () => {
      if (seq === askSeq) askedBuiltin = false;
    };
    try {
      chrome.runtime
        .sendMessage({ type: 'dk.fix.forHost', path: siteAddress().pathname })
        .then((reply) => {
          if (seq !== askSeq) return;
          if (!reply || reply.ok !== true) return retry();
          const paths = reply.paths === true;
          // The page moved on and the answer depends on the path: ask again.
          if (paths && route !== location.host + location.pathname) return askBuiltin();
          const fix = isObject(reply.builtin) ? reply.builtin : null;
          const dark = reply.dark === true;
          const changed = paths !== builtinPaths || dark !== builtinDark || JSON.stringify(fix) !== JSON.stringify(builtinFix);
          builtinFix = fix;
          builtinDark = dark;
          builtinPaths = paths;
          if (changed) void apply();
        })
        .catch(retry);
    } catch {
      retry();
    }
  }

  const told = { scheme: false, motion: false };
  /** Tell the hook whether the dark scheme or the reduced motion query answers yes (the word is an event name). @param {'scheme' | 'motion'} kind @param {boolean} on */
  function tell(kind, on) {
    if (on === told[kind]) return;
    told[kind] = on;
    try {
      document.dispatchEvent(new Event(`dk:${kind}-${on ? (kind === 'scheme' ? 'dark' : 'reduce') : 'off'}`));
    } catch {
      // The document is gone.
    }
  }

  /** Come back when the schedule changes (within a second), and once an hour in case the clock moved. A hidden tab decides when it is shown, so a boundary does not theme every open tab at once. @param {number | null} next */
  function wake(next) {
    clearTimeout(clockTimer);
    if (next !== null) clockTimer = setTimeout(applyOrDefer, Math.min(Math.max(next - Date.now() + 50, 1000), 3_600_000));
  }

  /** Leave the page as the page wrote it: the hold sheet goes and no attribute of ours stays on the root. For every path where the page is not themed. */
  function leave() {
    try {
      if (typeof ns.scheme.clear === 'function') ns.scheme.clear();
      else ns.scheme.release();
    } catch {
      // The root is gone.
    }
  }

  /** Release the first paint: the root attribute is set once and the hold sheet leaves the document (scheme.js). */
  function go() {
    try {
      ns.scheme.release();
    } catch {
      // The root is gone.
    }
  }

  // The frame watch of scheme.js releases a page that keeps one scheme before the settings are read, when the marker says so.
  if (typeof ns.schemeEarly === 'string') engineScheme = ns.schemeEarly;
  ns.schemeSink = (/** @type {string} */ kind) => {
    if (keep !== null) return engineSawScheme(kind);
    engineScheme = kind;
    if (!ns.scheme?.respecting()) return false;
    go();
    return true;
  };

  /** Parts the newest decision cannot do without that have not come, by name and the decision they belong to (`*`: all of them). Until they come the look is not final. */
  const lacking = new Map();
  /** The same for parts the loader has given up on. */
  const gaveUp = new Map();
  /** The status the newest decision or the engine asked for, before the overlay; null before the first decision. @type {string | null} */
  let wantedStatus = null;
  const open = (/** @type {Map<string, string>} */ map) => [...map.values()].some((scope) => scope === '*' || scope === last);

  /** A page that is themed shows `pending` while a part of its decision is missing and `start-failed` when that part can never come. A page that waits for a part before it can be decided at all (`pending`) says the same. */
  function overlay(/** @type {string} */ status) {
    if (status === 'pending') return open(gaveUp) ? 'start-failed' : status;
    if (status !== 'on' && status !== 'fallback') return status;
    return open(gaveUp) ? 'start-failed' : open(lacking) ? 'pending' : status;
  }

  /** Tell the worker what this page is doing, for the toolbar icon. Only the top frame speaks, and a page loaded ahead of time (prerendered) speaks only once it is shown in the tab. */
  function report(/** @type {string} */ asked) {
    wantedStatus = asked;
    const status = overlay(asked);
    if (window !== window.top || status === lastReported || /** @type {any} */ (document).prerendering === true) return;
    lastReported = status;
    try {
      void chrome.runtime.sendMessage({ type: 'dk.page.status', status, at: Date.now() }).catch(() => {});
    } catch {
      // The worker is not available; the icon keeps its last look.
    }
  }

  // Before the first decision there is nothing to say yet.
  const refreshStatus = () => {
    if (wantedStatus !== null) report(wantedStatus);
  };
  /** @type {Set<string>} */
  const waitingFor = new Set();

  /**
   * A part that the decision needs did not come. The loader keeps asking in the background: when the part arrives the decision is made
   * again and the look swaps to the right one; when the part cannot be had the status says so. Until then the status is `pending`.
   * @param {string} name @param {string} scope the decision it belongs to: the key of the engine decision, or `*`
   */
  function lack(name, scope) {
    lacking.set(name, scope);
    refreshStatus();
    const tag = `${name}|${scope}`;
    if (waitingFor.has(tag)) return;
    waitingFor.add(tag);
    optional.whenLoaded(name, async () => {
      waitingFor.delete(tag);
      if (retired || lacking.get(name) !== scope) return;
      last = '';
      await apply();
      if (lacking.get(name) === scope) lacking.delete(name);
      refreshStatus();
    });
    optional.whenGivenUp(name, () => {
      if (retired || lacking.get(name) !== scope) return;
      lacking.delete(name);
      gaveUp.set(name, scope);
      refreshStatus();
    });
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let checkTimer;
  /** The engine waits for the part that judges the page's own dark theme: after a second without an answer the status says so. @param {boolean} waiting @param {string} scope */
  function siteWait(waiting, scope) {
    clearTimeout(checkTimer);
    if (waiting) {
      checkTimer = setTimeout(() => {
        if (last !== scope || retired) return;
        lacking.set('site-check', scope);
        refreshStatus();
      }, PENDING_MS);
    } else if (lacking.delete('site-check')) refreshStatus();
  }

  /** A change of the data or of the system arrived while no one can see this tab: the page decides again when it is shown, once, from the newest data. */
  let deferredApply = false;

  /** A page that was open before this build started (an install, an update, a wider registration) and is hidden waits for its first decision; see `begin`. @type {ReturnType<typeof setTimeout> | undefined} */
  let firstTimer;
  let firstWaiting = false;
  /** The longest wait of that first decision. Each frame picks its own wait in this span, so the tabs do not all start the engine in the same second. */
  const FIRST_SPREAD_MS = 8000;
  /**
   * A document whose clock began this long before the gate started was there before the build: an install, an update or a wider
   * registration put the files into it. A frame the page makes after its load (about:blank, srcdoc) is complete at once too, but its
   * clock begins with it, and it decides at once like the page around it.
   */
  const LATE_INJECTION_MS = 2000;

  /** Decide again now, or when the tab is shown if it is hidden and has been themed before or still waits for its first decision (a tab that is deciding for the first time takes the change in that decision). */
  function applyOrDefer() {
    if ((shown !== null || firstWaiting) && document.visibilityState === 'hidden') {
      deferredApply = true;
      return;
    }
    void apply();
  }

  /** The cleaning of what a build left whose world is gone (namespace.js). Every decision waits for it, so it never removes this build's work. */
  const cleaning = ns.leftover === true ? need('leftovers').then((ok) => ok && ns.leftovers.sweep()) : null;

  async function apply() {
    if (retired) return;
    deferredApply = false;
    clearTimeout(firstTimer);
    firstWaiting = false;
    const loading = firstLoad;
    const mine = (applyNo += 1);
    try {
      if (cleaning) {
        await cleaning;
        if (mine !== applyNo) return;
      }
      // The first call uses the read of prefetch.js.
      const first = /** @type {Promise<Record<string, any>> | undefined} */ (ns.stored);
      ns.stored = undefined;
      // A change before the listener existed, or since, makes the first read old.
      const stale = ns.changedSince === true || dataRev !== 0;
      ns.changedSince = false;
      // The stored data is read again only when it changed: a client-side route change decides again from the data already held.
      const rev = dataRev;
      /** @type {Record<string, any> | null} */
      let stored = !stale && first ? shaped(await first, /** @type {string} */ (ns.storedKey)) : null;
      if (!stored && kept && keptRev === dataRev) stored = kept;
      else {
        stored ??= await readStored();
        // A read that a change overtook may miss that change: the next decision reads again.
        if (rev === dataRev) {
          kept = stored;
          keptRev = rev;
        }
      }
      const needsSchedule = !ns.schedule && scheduleSet(isObject(stored.settings) ? stored.settings : {});
      if (needsSchedule && !(await need('schedule'))) lack('schedule', '*');
      if (mine !== applyNo) return;
      const decision = decide(stored);
      // A part that this decision does not use is no longer awaited.
      const uses = { filter: decision.on && (svgDoc || decision.kind === 'filter' || decision.kind === 'filterPlus'), static: decision.on && decision.kind === 'static', einkpalette: decision.eink, cvd: decision.cvd, schedule: !ns.schedule && needsSchedule };
      for (const map of [lacking, gaveUp]) for (const [name, used] of Object.entries(uses)) if (!used) map.delete(name);
      routeKey = location.host + location.pathname;
      pathRules = decision.route;
      if (builtinPaths && askedRoute !== routeKey) askBuiltin();
      nextAt = decision.next;
      if (svgDoc) {
        if (decision.on && !(await need('filter'))) lack('filter', '*');
        if (decision.on && decision.mode === 'eink' && !(await need('einkpalette'))) lack('einkpalette', '*');
        if (mine !== applyNo) return;
        firstLoad = false;
        ns.filter?.svgDocument(decision.on, decision.mode, decision.theme);
        wake(decision.next);
        report(decision.status);
        return;
      }
      if (!decision.on && untouched(decision)) stopWatches();
      else watchPage(decision.route);
      // Never more than three flashes in a second (WCAG 2.3.1): a second flip waits until 340 ms after the last.
      const look = decision.on ? decision.mode : 'off';
      if (shown !== null && look !== shown && (look === 'off' || shown === 'off' || look !== shown)) {
        const wait = shownAt + MIN_FLIP_MS - Date.now();
        if (wait > 0) {
          clearTimeout(flipTimer);
          flipTimer = setTimeout(() => void apply(), wait);
          return;
        }
      }
      if (look !== shown) {
        shown = look;
        shownAt = Date.now();
      }
      tell('scheme', decision.hint);
      tell('motion', decision.motion);
      const { css, invert, next, probe, recheck, ignoreImage, route, hint, motion, eink, cvd, mode, ...engineDecision } = decision;
      const original = mode === 'original';
      watching = probe;
      rechecking = recheck;
      // A page that is off needs no root watcher and no waiting listener of the dark-page check.
      if (!probe && !recheck && prober) dropProbe();
      if (recheck) prober?.watchRoot();
      wake(next);
      const invertCss = invert.length ? `@media screen{${invert.join(',')}{filter:invert(1) hue-rotate(180deg)!important}}` : '';
      setCss(decision.on ? [css, invertCss].filter(Boolean).join('\n') : '');
      // The Dynamic engine sorts images on a dark page; in E-ink mode calm.js calms the pictures and the module marks CSS backgrounds.
      const einkImages = eink ? ns.color.einkSettings(decision.theme).einkImages : 'off';
      const ig = JSON.stringify(ignoreImage);
      const imageKey = decision.on && decision.kind === 'dynamic' && mode !== 'eink' && !original ? `${mode}:${ig}` : eink && decision.kind === 'dynamic' ? `eink:${einkImages}:${ig}` : '';
      // An engine swap runs the changes of the modules at its commit, so one restyle shows the whole new look.
      const dynKey = JSON.stringify(engineDecision);
      /** @type {((() => void)[] & { done?: boolean }) | null} */
      const defer = decision.on && decision.kind === 'dynamic' && dynKey !== last && directFor !== dynKey && (dynamic.isActive() || ns.filter?.isActive() || ns.staticEngine?.isActive()) ? [] : null;
      // A change that arrives after the flush (a module that loads late) runs at once.
      const flush = () => {
        if (defer) defer.done = true;
        defer?.splice(0).forEach((f) => f());
      };
      const settled = optional.sync({
        defer,
        on: decision.on,
        eink,
        original,
        cvd,
        kind: decision.kind,
        theme: decision.theme,
        images: imageKey === '' ? null : { key: imageKey, options: { ignore: ignoreImage, fetchImage, light: mode === 'light', eink, einkMark: eink && einkImages !== 'off' } },
      });
      // The E-ink rules and extras come before the engine, for at most SETTLE_MAX_MS.
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, SETTLE_MAX_MS))]);
      // The engines need the palette; without it the mode shows as the light mode.
      const noPalette = eink && !ns.color.hasEink() && !(await need('einkpalette'));
      if (noPalette) lack('einkpalette', '*');
      // Without the model the colors are themed with no correction, and the next decision tries again.
      const noVision = cvd && !ns.color?.hasCvd?.() && !(await need('cvd'));
      if (noVision) lack('cvd', '*');
      if (mine !== applyNo) return;
      const key = JSON.stringify(engineDecision);
      if (directFor !== '' && directFor !== key) directFor = '';
      if (key === last) return;
      last = key;
      // At the first load the page gets a dark canvas at once and may stay held until it is themed.
      if (decision.on && decision.kind === 'dynamic') {
        firstLoad = false;
        const swap = dynamic.isActive() || !!ns.filter?.isActive() || !!ns.staticEngine?.isActive();
        const stage = swap && directFor !== key;
        dynamic.start(decision.theme, {
          early: loading,
          hold: loading && decision.hold,
          stage,
          atCommit: flush,
          onPageScheme: engineSawScheme,
          // The page's own dark theme is kept: the popup says so while this decision stands.
          onSiteTheme: (/** @type {boolean} */ repaired) => {
            if (last === key && decision.status === 'on') report(repaired ? 'site-theme-repaired' : 'site-theme');
          },
          // A sheet cannot be read and the page stays light: the Filter+ engine takes over.
          onUnreachable: decision.canFall
            ? () => {
                if (mine !== applyNo || unreachableFallback) return;
                unreachableFallback = true;
                last = '';
                void apply();
              }
            : undefined,
          // A staged engine gave up after faults: the same decision is built in place, once.
          onFault: () => {
            if (mine !== applyNo) return;
            last = '';
            if (stage) {
              directFor = key;
              void apply();
            }
          },
          beforeCommit: () => stopEngines('dynamic'),
          startedAt: /** @type {number | undefined} */ (ns.startedAt),
          ignoreInline: decision.ignoreInline,
          ignoreCssUrl: decision.ignoreCssUrl,
          motion,
          onRelease: go,
          onReady: () => optional.engineReady(),
          // The part that judges the page's own dark theme is awaited, or did not come: the status says so, and a late arrival decides again.
          onSiteWait: (/** @type {boolean} */ waiting) => siteWait(waiting, key),
          onSiteModule: () => {
            if (last === key) lack('sitetheme', key);
          },
        });
        if (!stage) flush();
        if (!loading || swap) go();
        if (!swap) stopEngines('dynamic');
      } else if (decision.on && decision.kind === 'static') {
        const ready = await need('static');
        if (last !== key) return;
        firstLoad = false;
        stopEngines('static');
        if (ready) ns.staticEngine.start(decision.theme, decision.staticData, { startedAt: /** @type {number | undefined} */ (ns.startedAt) });
        else {
          last = '';
          lack('static', '*');
        }
        go();
      } else if (decision.on) {
        const ready = await need('filter');
        if (last !== key) return;
        firstLoad = false;
        stopEngines('filter');
        if (ready) ns.filter.start(decision.theme, decision.kind);
        else {
          last = '';
          lack('filter', '*');
        }
        go();
      } else {
        firstLoad = false;
        stopEngines();
        // Off by the master switch or a site rule, or waiting for the schedule: the page is as the page wrote it. A page that was released for another reason (it keeps its own scheme, it is dark already) keeps the one mark of its release, written once.
        if (untouched(decision)) leave();
        else go();
      }
      // A module that failed to load is tried again by the next decision.
      if (noPalette || noVision) last = '';
      retries = 0;
      if (decision.on && !askedBuiltin) askBuiltin();
      if (watching) armProbe();
      report(decision.status);
    } catch {
      // A decision that a newer one replaced leaves the page to it.
      if (mine !== applyNo) return;
      // The page is released here, so no later decision holds it again.
      firstLoad = false;
      dynamic.stop();
      ns.filter?.stop();
      ns.cvd?.media(null);
      leave();
      // The same decision later starts the engine again, and a failed read of the settings is tried again after a wait.
      last = '';
      if (!retired && retries < 4) {
        retries += 1;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void apply(), 500 * 2 ** retries);
      }
    }
  }

  /** The route changed (pushState sends no event; the navigation API does). Decide again. */
  function routeChanged() {
    if (!pathRules || location.host + location.pathname === routeKey) return;
    unreachableFallback = false;
    void apply();
  }

  /** @type {MutationObserver | null} */
  let authorWatch = null;
  let headWatched = false;

  /** A page that is off by the master switch or a rule needs no observer and no timer: a change of the data decides again. */
  function stopWatches() {
    clearInterval(routePoll);
    routePoll = undefined;
    authorWatch?.disconnect();
    authorWatch = null;
    headWatched = false;
  }

  /** Follow the page's route and the author's request for no theme. */
  function watchPage(/** @type {boolean} */ pathRules) {
    // Without the navigation API a route change is found by polling; only rules with a path need it.
    if (pathRules && routePoll === undefined && !(/** @type {any} */ (window).navigation)) routePoll = setInterval(routeChanged, 1000);
    if (authorWatch) return;
    const recheck = () => {
      const kind = declaredScheme();
      if (kind !== schemeSeen) {
        schemeSeen = kind;
        if (kind !== null && keeps(kind)) releaseNow();
        else void apply();
      } else if (authorOff() !== authorSeen) void apply();
    };
    const rootValue = () => {
      try {
        return document.documentElement.style.getPropertyValue('color-scheme');
      } catch {
        return '';
      }
    };
    let rootScheme = rootValue();
    authorWatch = new MutationObserver((records) => {
      if (!alive()) return retire();
      if (document.head && !headWatched && document.readyState === 'loading') {
        headWatched = true;
        authorWatch?.observe(document.head, { childList: true });
      }
      // A page that writes the root's style often (an animation, a CSS variable) is looked at again only when its color-scheme changed.
      const value = rootValue();
      const styleOnly = records.every((r) => r.type === 'attributes' && r.attributeName === 'style');
      if (styleOnly && value === rootScheme) return;
      rootScheme = value;
      recheck();
    });
    const loading = document.readyState === 'loading';
    authorWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tintly', 'style'], childList: loading });
    if (!loading) {
      recheck();
      return;
    }
    if (document.head) {
      headWatched = true;
      authorWatch.observe(document.head, { childList: true });
    }
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        recheck();
        authorWatch?.disconnect();
        authorWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tintly', 'style'] });
      },
      { once: true },
    );
  }

  // Every listener of this build on the page goes with one call when it is retired.
  const listening = new AbortController();
  const signal = listening.signal;

  // Copied rich text takes the computed colors, so the page's own colors show for one task while it copies.
  const onCopy = () => {
    const resume = dynamic.suspend();
    const others = [...document.querySelectorAll('style[data-dk]')].filter((el) => el instanceof HTMLStyleElement && !el.disabled);
    for (const el of others) /** @type {HTMLStyleElement} */ (el).disabled = true;
    setTimeout(() => {
      resume();
      for (const el of others) /** @type {HTMLStyleElement} */ (el).disabled = false;
    }, 0);
  };
  if (!svgDoc) {
    document.addEventListener('copy', onCopy, { capture: true, signal });
    document.addEventListener('cut', onCopy, { capture: true, signal });
  }
  addEventListener('popstate', routeChanged, { signal });
  addEventListener('hashchange', routeChanged, { signal });
  /** @type {any} */ (window).navigation?.addEventListener?.('currententrychange', routeChanged, { signal });

  // The runtime object as it was when this build started: its id is gone when the extension was updated, reloaded or removed.
  const runtime = chrome.runtime;
  const alive = () => {
    try {
      return !!runtime.id;
    } catch {
      return false;
    }
  };
  const onStorage = (/** @type {Record<string, any>} */ changes, /** @type {string} */ area) => {
    if (area !== 'local') return;
    const sliced = kept !== null && typeof kept[SLICE] === 'string';
    const mine = sliced ? /** @type {string} */ (kept?.[SLICE]) : '';
    const source = SOURCE.some((k) => k in changes);
    const copy = META_KEY in changes || (mine !== '' && mine in changes);
    if (!source && !copy && !('settings' in changes)) return;
    unreachableFallback = false;
    if (sliced) {
      if (source) {
        // The worker makes its copy again; the slice is read when that is done (at the latest after a pause, then from the sections if the copy is still behind).
        clearTimeout(sourceTimer);
        sourceTimer = setTimeout(() => {
          dataChanged();
          applyOrDefer();
        }, 1500);
        return;
      }
      if (sourceTimer !== undefined && copy) {
        clearTimeout(sourceTimer);
        sourceTimer = undefined;
        dataChanged();
        return applyOrDefer();
      }
      if (mine in changes) {
        dataChanged();
        return applyOrDefer();
      }
      // A change of the settings alone: the slice stays, the settings come with the event.
      if ('settings' in changes && kept) {
        const current = keptRev === dataRev;
        dataChanged();
        // Only data that was current stays current with the new settings; older data is read again.
        if (current) {
          kept = { ...kept, settings: changes.settings.newValue };
          keptRev = dataRev;
        }
        return applyOrDefer();
      }
      return;
    }
    if (!KEYS.some((k) => k in changes) && !copy) return;
    dataChanged();
    applyOrDefer();
  };
  chrome.storage.onChanged.addListener(onStorage);
  ns.dropNote?.();
  const schemeQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const forcedQuery = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null;
  const onScheme = () => {
    if (!alive()) return retire();
    applyOrDefer();
    prober?.recheck();
  };
  const onForced = () => (alive() ? applyOrDefer() : retire());
  schemeQuery?.addEventListener('change', onScheme, { signal });
  forcedQuery?.addEventListener('change', onForced, { signal });
  // A tab shown again is decided anew only if the schedule passed its time (hidden timers are slow) or the route moved.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!alive()) return retire();
    if (firstWaiting || deferredApply || (nextAt !== null && Date.now() >= nextAt)) void apply();
    else routeChanged();
  };
  document.addEventListener('visibilitychange', onVisible, { signal });
  /** Say the status again: the worker forgot it (the tab went to another page and came back) or never took it (the page was loaded ahead of time). */
  const resendStatus = () => {
    lastReported = '';
    refreshStatus();
  };
  // A page back from the back-forward cache missed the changes made while it was stored, and the tab's status was cleared when the tab left it.
  const onPageShow = (/** @type {PageTransitionEvent} */ event) => {
    if (!event.persisted) return;
    if (!alive()) return retire();
    resendStatus();
    dataChanged();
    applyOrDefer();
  };
  addEventListener('pageshow', onPageShow, { signal });
  // A prerendered page becomes the tab's page.
  const onActivated = () => (alive() ? resendStatus() : retire());
  if (/** @type {any} */ (document).prerendering === true) document.addEventListener('prerenderingchange', onActivated, { once: true, signal });

  /**
   * The first decision. A page that was open before this build came (an install, an update, a wider registration) and that nobody sees
   * decides when it is shown, or after a wait picked in FIRST_SPREAD_MS, whichever comes first: a browser with many open tabs does not
   * start the engine in all of them in the same second. A page that is loading decides at once, so its first paint is never light, and
   * so does a page that showed the look of the build this one replaced (namespace.js), so it does not sit light until it is shown.
   */
  function begin() {
    const late = typeof ns.startedAt === 'number' && ns.startedAt > LATE_INJECTION_MS;
    if (firstLoad || !late || ns.replaced === true || document.visibilityState !== 'hidden') return void apply();
    firstWaiting = true;
    firstTimer = setTimeout(() => void apply(), Math.floor(Math.random() * FIRST_SPREAD_MS));
  }

  /** Stop everything this build started: engines, modules, observers, timers and listeners. Called by a newer build in the same frame and by this build when its extension is gone. */
  function retire() {
    if (retired) return;
    retired = true;
    applyNo += 1;
    clearTimeout(clockTimer);
    clearTimeout(flipTimer);
    clearTimeout(retryTimer);
    clearTimeout(firstTimer);
    clearTimeout(checkTimer);
    stopWatches();
    const each = (/** @type {() => void} */ f) => {
      try {
        f();
      } catch {
        // The context may be gone; the rest still runs.
      }
    };
    each(() => clearTimeout(sourceTimer));
    each(() => chrome.storage.onChanged.removeListener(onStorage));
    each(() => listening.abort());
    // The loader's tries in the background end with the build.
    each(() => optional.stop?.());
    each(dropProbe);
    each(() => ns.dropShadowNotes?.());
    each(() => dynamic.stop());
    each(() => ns.filter?.stop());
    each(() => ns.staticEngine?.stop());
    for (const name of ['images', 'backdrop', 'calm', 'extras', 'readability']) each(() => ns[name]?.stop?.());
    each(() => cssKeeper?.stop());
    each(() => document.querySelector('style[data-dk="css"]')?.remove());
    tell('scheme', false);
    tell('motion', false);
    each(leave);
  }
  ns.retire = retire;
  ns.alive = alive;
  begin();
})();
