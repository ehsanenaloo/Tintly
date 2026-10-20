// @ts-check
// Optional modules are not in the manifest list. The gate asks the worker to inject one (`dk.inject`) when the decision
// needs it and waits for the reply. A module that cannot be loaded is counted and left out; the engine goes on without it.
(() => {
  'use strict';
  const dk = /** @type {Record<string, any> | undefined} */ (globalThis.__dk);
  if (!dk || dk.need) return;

  /** The name in the namespace, where it differs from the file name. */
  const KEY = /** @type {Record<string, string>} */ ({ static: 'staticEngine' });
  /** What must be there first. */
  const DEPS = /** @type {Record<string, string[]>} */ ({ extras: ['calm'] });
  const pending = new Map();
  const stats = { requested: 0, loaded: 0, failed: 0, /** Modules that arrived after their caller had been told no. */ late: 0, /** Modules that no later try could bring. */ abandoned: 0, /** Milliseconds from the request of a module to its arrival, by name. */ ms: /** @type {Record<string, number>} */ ({}) };
  /** How long one request waits for the worker's reply. */
  const INJECT_WAIT_MS = 8000;
  /** Pauses before the tries that follow a failure, while the page is visible. After the last one the module is given up. A test shortens them with `recoverScale` in the namespace. */
  const RECOVER_MS = [1500, 4000, 10000, 25000, 60000];
  /** An answer that a later try cannot change. */
  const FINAL = new Set(['invalid', 'unavailable', 'denied', 'unknown']);
  /** @type {Map<string, number>} */
  const began = new Map();
  /** @type {Map<string, { tries: number, timer: any, gone: boolean, arrive: (() => void)[], abandon: (() => void)[] }>} */
  const recovery = new Map();
  const arrivedNames = new Set();
  let stopped = false;

  /** The build that owns this loader is retired: the tries in the background end, and nothing is asked for again. */
  /** @type {HTMLStyleElement | null} */
  let linkStyle = null;
  /** The link underline (WCAG 1.4.1), in every mode: a link told apart by its color only gets a line too. @param {boolean} on */
  function links(on) {
    if (!on) {
      linkStyle?.remove();
      linkStyle = null;
    } else if (!linkStyle?.isConnected) {
      linkStyle = document.createElement('style');
      linkStyle.setAttribute('data-dk', 'links');
      linkStyle.textContent = '@media screen{a:any-link{text-decoration-line:underline!important;text-underline-offset:.16em!important}}';
      (document.head ?? document.documentElement).append(linkStyle);
    }
  }

  function stop() {
    links(false);
    dk?.cvd?.media(null);
    stopped = true;
    for (const r of recovery.values()) {
      clearTimeout(r.timer);
      r.timer = undefined;
      r.arrive.length = 0;
      r.abandon.length = 0;
    }
    clearTimeout(startTimer);
    readyQueue.length = 0;
  }

  /** @param {string} name */
  function track(name) {
    let r = recovery.get(name);
    if (!r) recovery.set(name, (r = { tries: 0, timer: undefined, gone: false, arrive: [], abandon: [] }));
    return r;
  }

  /** @param {(() => void)[]} list */
  function fire(list) {
    for (const fn of list.splice(0)) {
      queueMicrotask(() => {
        try {
          fn();
        } catch {
          // A listener must not stop the others.
        }
      });
    }
  }

  /** The module is in the namespace. Counted once, whoever sees it first: its caller or a reply that came after the caller had given up. @param {string} name @param {boolean} late */
  function arrived(name, late) {
    if (arrivedNames.has(name)) return;
    arrivedNames.add(name);
    stats.loaded += 1;
    if (late) stats.late += 1;
    if (began.has(name)) stats.ms[name] = Math.round((performance.now() - /** @type {number} */ (began.get(name))) * 10) / 10;
    const r = track(name);
    clearTimeout(r.timer);
    r.timer = undefined;
    r.tries = 0;
    r.gone = false;
    r.abandon.length = 0;
    fire(r.arrive);
  }

  /** @param {() => void} fn */
  function whenVisible(fn) {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return fn();
    document.addEventListener('visibilitychange', () => whenVisible(fn), { once: true });
  }

  /** After a failure: ask again after a pause, a few times, while the page is shown. A module that cannot be had is given up, and the parts that waited for it are told. @param {string} name */
  function recover(name) {
    const key = KEY[name] ?? name;
    const r = track(name);
    if (stopped || r.gone || r.timer !== undefined || dk?.[key]) return;
    try {
      if (!chrome.runtime.id) return;
    } catch {
      return;
    }
    if (r.tries >= RECOVER_MS.length) {
      r.gone = true;
      stats.abandoned += 1;
      fire(r.abandon);
      return;
    }
    r.timer = setTimeout(() => {
      r.timer = undefined;
      whenVisible(() => {
        if (!dk?.[key]) void need(name);
      });
    }, RECOVER_MS[r.tries++] * (typeof dk?.recoverScale === 'number' ? dk.recoverScale : 1));
    // The timer of a page that is going away must not keep a process waiting.
    r.timer?.unref?.();
  }

  /** One request. Resolves to the worker's answer, or to null when it does not come in time. A reply that comes later still counts: the module may be there by then. @param {string} name @returns {Promise<any>} */
  function ask(name) {
    const key = KEY[name] ?? name;
    return new Promise((resolve) => {
      let timedOut = false;
      const timer = /** @type {any} */ (setTimeout(() => ((timedOut = true), resolve(null)), INJECT_WAIT_MS));
      timer?.unref?.();
      const answer = (/** @type {any} */ value) => {
        clearTimeout(timer);
        resolve(value);
        if (timedOut && dk?.[key]) arrived(name, true);
      };
      try {
        Promise.resolve(chrome.runtime.sendMessage({ type: 'dk.inject', module: name })).then(answer, () => answer({ ok: false, code: 'failed' }));
      } catch {
        answer({ ok: false, code: 'failed' });
      }
    });
  }

  /** Is the module there, or can it be loaded? A caller is told no after two waits or a refusal; the loader then goes on asking in the background (`recover`), and `whenLoaded` tells what a late arrival should change. @param {string} name @returns {Promise<boolean>} */
  function need(name) {
    const key = KEY[name] ?? name;
    if (dk?.[key]) return Promise.resolve(true);
    // A module given up on (or a loader that was stopped) is not asked for again: each decision would wait for the worker twice more.
    if (stopped || recovery.get(name)?.gone === true) return Promise.resolve(false);
    const known = pending.get(name);
    if (known) return known;
    stats.requested += 1;
    const job = (async () => {
      if (!began.has(name)) began.set(name, performance.now());
      try {
        for (const dep of DEPS[name] ?? []) if (!(await need(dep))) throw new Error('dependency');
        // A slow worker is waited for a while, then asked again.
        for (let attempt = 0; attempt < 2; attempt++) {
          const reply = await ask(name);
          if (dk?.[key]) {
            arrived(name, false);
            return true;
          }
          // An answer that is not a timeout ends this try; one that no later try can change ends the module.
          if (reply !== null) {
            if (FINAL.has(reply?.code)) track(name).tries = RECOVER_MS.length;
            break;
          }
        }
        throw new Error('refused');
      } catch {
        stats.failed += 1;
        recover(name);
        return false;
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, job);
    return job;
  }

  /** Call `fn` once when the module is there (at once when it is). @param {string} name @param {() => void} fn */
  function whenLoaded(name, fn) {
    if (dk?.[KEY[name] ?? name]) queueMicrotask(fn);
    else track(name).arrive.push(fn);
  }

  /** Call `fn` once when the loader has given the module up (at once when it has). @param {string} name @param {() => void} fn */
  function whenGivenUp(name, fn) {
    const r = track(name);
    if (r.gone) queueMicrotask(fn);
    else r.abandon.push(fn);
  }

  /** Does a theme use the font, the text weight, the scrollbar color or the selection color? @param {Record<string, any>} t */
  const wantsExtras = (t) => t.fontEnabled === true || (Number.isInteger(t.textStroke) && t.textStroke > 0) || (typeof t.scrollbar === 'string' && t.scrollbar !== 'auto') || (typeof t.selection === 'string' && t.selection !== 'auto');

  /** The newest request for each module: an answer to an older one is dropped. */
  const latest = /** @type {Record<string, number>} */ ({});
  let imagesKey = '';
  // A change within 1.5 s of the last picture start waits 0.7 s for the next one.
  let lastStart = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let startTimer;
  /** The newest decision: a late reply of an older one starts nothing. */
  let gen = 0;
  // Work that waits for the engine to be ready: the readability net waits for that itself, so its module is not loaded before.
  let engineIsReady = false;
  /** @type {(() => void)[]} */
  const readyQueue = [];
  /** @type {number} */
  let readingGen = 0;

  /** @param {() => void} fn */
  const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 50));

  /** Run `fn` in an idle moment once the engine is ready. @param {() => void} fn */
  function afterReady(fn) {
    if (engineIsReady) idle(fn);
    else readyQueue.push(fn);
  }

  /** The Dynamic engine is ready (its `onReady`): what waited goes now. */
  function engineReady() {
    engineIsReady = true;
    for (const fn of readyQueue.splice(0)) idle(fn);
  }

  /** A CSS picture, a canvas or an inline picture was seen: the module for them (imagebg) joins the run of the images module. */
  let backgroundsWanted = false;

  let backgroundsAsking = false;

  /** Load the module for CSS pictures and let it join the run of the images module that is on. Cheap to call again. */
  function startBackgrounds() {
    backgroundsWanted = true;
    if (imagesKey === '' || !dk?.images?.isActive?.()) return;
    const session = dk.images.session?.();
    if (dk.imagebg) {
      if (session && !session.bg) dk.imagebg.attach(session);
      return;
    }
    if (backgroundsAsking) return;
    backgroundsAsking = true;
    void drive('imagebg', true, (m) => {
      const run = dk?.images?.session?.();
      if (run) m.attach(run);
      // What the Dynamic engine said before the module was there.
      dk?.dynamic?.replayImageNotes?.();
    }).finally(() => {
      backgroundsAsking = false;
    });
  }

  /** @param {string} name @param {boolean} want @param {(api: any) => void} start @param {(f: () => void) => void} [at] runs the change; a swap runs it at the commit @returns {Promise<boolean>} false when the module could not be loaded */
  async function drive(name, want, start, at = (f) => f()) {
    const key = KEY[name] ?? name;
    const id = (latest[name] = (latest[name] ?? 0) + 1);
    if (!want) {
      at(() => latest[name] === id && dk?.[key]?.stop());
      return true;
    }
    const ok = await need(name);
    if (ok) at(() => latest[name] === id && start(dk?.[key]));
    // A module that arrives later starts the part, if no newer decision came meanwhile.
    else if (latest[name] === id) whenLoaded(name, () => at(() => latest[name] === id && start(dk?.[key])));
    return ok || latest[name] !== id;
  }

  /**
   * Start or stop the optional modules for the gate's decision.
   * @param {{ on: boolean, eink: boolean, original?: boolean, cvd?: boolean, kind: string, theme: Record<string, any>, images: { key: string, options: Record<string, any> } | null, defer?: ((() => void)[] & { done?: boolean }) | null }} d
   * `defer` is a list that the engine swap runs at its commit, so the changes of the modules and of the engine land in one frame; once it has run (`done`), a change goes at once.
   * @returns {Promise<void>} resolves when the E-ink rules and the extras are in place
   */
  function sync(d) {
    const mine = ++gen;
    const at = d.defer
      ? (/** @type {() => void} */ f) => {
          const run = () => mine === gen && f();
          if (d.defer?.done === true) run();
          else d.defer?.push(run);
        }
      : (/** @type {() => void} */ f) => f();
    const key = d.images?.key ?? '';
    // A picture part that is still on its way for an older decision is no longer wanted.
    if (key === '') for (const n of ['images', 'imagebg', 'backdrop']) latest[n] = (latest[n] ?? 0) + 1;
    if (key !== imagesKey) at(() => {
      imagesKey = key;
      latest.images = (latest.images ?? 0) + 1;
      latest.imagebg = (latest.imagebg ?? 0) + 1;
      latest.backdrop = (latest.backdrop ?? 0) + 1;
      clearTimeout(startTimer);
      if (d.images === null) {
        dk?.images?.stop();
        dk?.imagebg?.stop();
        dk?.backdrop?.stop();
      } else {
        const options = d.images.options;
        const go = () => {
          lastStart = Date.now();
          void Promise.all([
            // Its result does not depend on the mode: a running sweep goes on.
            drive('backdrop', true, (b) => b.isActive?.() || b.start()),
            drive('images', true, (i) => {
              i.start(options);
              // CSS pictures that the Dynamic engine or the page showed before this module was there.
              if (backgroundsWanted) startBackgrounds();
            }),
          ]).then((done) => {
            // A failed load is tried again by the next decision.
            if (imagesKey === key && done.includes(false)) (imagesKey = ''), (lastStart = 0);
          });
        };
        if (lastStart + 1500 > Date.now()) startTimer = setTimeout(go, 700);
        else go();
      }
    });
    const filterKind = d.kind === 'filter' || d.kind === 'filterPlus';
    // The E-ink palette is needed by every engine and module that makes the theme.
    const palette = d.eink ? need('einkpalette') : null;
    // The module of the calm rules uses code of the palette module: it starts when both are there.
    if (palette) void need('calm');
    const startCalm = () => drive('calm', d.eink, (c) => c.start(d.theme, { rootFilter: !filterKind }), at);
    const calm = palette ? palette.then((ok) => (ok && mine === gen ? startCalm() : true)) : startCalm();
    const extras = drive('extras', d.on && !d.eink && wantsExtras(d.theme), (x) => x.sync(true, d.theme, d.kind), at);
    const reading = () => {
      // The page's own colors keep their own contrast.
      const want = d.on && !filterKind && !d.original && !!dk?.dynamic;
      const id = ++readingGen;
      // The net of a page that is being themed by the Dynamic engine is asked for when that engine is ready; a module that is there, and every other case, goes at once.
      if (!want || dk?.readability || d.kind !== 'dynamic') void drive('readability', want, (r) => r.sync(true, d.theme, d.kind), at);
      else afterReady(() => id === readingGen && void drive('readability', true, (r) => r.sync(true, d.theme, d.kind), at));
    };
    if (palette) void palette.then(() => mine === gen && reading());
    else reading();
    // E-ink and Paper underline links by their own style (`einkLinks`, calm.js); the switch of the settings page writes that one there.
    at(() => links(d.on && d.theme.linkUnderline === true && d.theme.mode !== 'eink'));
    // The picture layer of the color vision correction; the Filter engines correct pictures in their own filter.
    const pictures = d.on && d.cvd && d.theme.cvdMedia !== false && (d.kind === 'dynamic' || d.kind === 'static') ? d.theme : null;
    if (pictures) void need('cvd').then((ok) => ok && mine === gen && at(() => dk?.cvd.media(pictures)));
    else at(() => dk?.cvd?.media(null));
    return Promise.all([calm, extras, palette]).then(() => {});
  }

  dk.need = need;
  dk.optional = Object.freeze({ sync, engineReady, wantBackgrounds: startBackgrounds, whenLoaded, whenGivenUp, stop, stats: () => ({ ...stats, ms: { ...stats.ms } }) });
})();
