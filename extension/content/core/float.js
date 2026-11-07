// @ts-check
// The optional button on the page: one click shows the modes. It loads only when the setting is on, only in the top frame of a
// page where Tintly works. It lives in a closed shadow root in the top layer, so the page and the themes do not reach it.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk || /** @type {any} */ (dk).float) return;

  const SIZE = 42;
  const EDGE = 10;
  const SNAP = 28;
  const DRAG_FROM = 6;
  const IDLE_MS = 2500;
  const SCROLL_END_MS = 350;
  const KEY_STEP = 16;
  const PANEL_WIDTH = 186;
  const GAP = 8;
  const DEFAULT_PLACE = { x: 1000, y: 180 };
  const SVG = 'http://www.w3.org/2000/svg';

  /** Icons as path data on a 24 by 24 grid. */
  const ICONS = /** @type {const} */ ({
    dark: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    light: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41',
    paper: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    eink: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM9 7h6M9 11h6M9 15h3',
    original: 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z',
    hide: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.4 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.5-1.1',
  });
  const CHOICES = /** @type {const} */ (['dark', 'light', 'paper', 'eink', 'original']);
  const LABELS = /** @type {const} */ ({ dark: 'floatDark', light: 'floatLight', paper: 'floatPaper', eink: 'floatEink', original: 'floatOriginal' });

  const CSS = `
:host { all: initial; }
.w {
  --bg: #fff; --ink: #1a1c20; --line: color-mix(in srgb, var(--ink) 14%, transparent);
  --shadow: 0 1px 2px rgb(0 0 0 / .18), 0 6px 18px rgb(0 0 0 / .2);
  position: fixed; inset: 0 auto auto 0; display: block; inline-size: ${SIZE}px; block-size: ${SIZE}px;
  font: 500 13px/1.25 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
  transform: translate3d(var(--x, 0), var(--y, 0), 0); touch-action: none; user-select: none;
  transition: transform .26s cubic-bezier(.2, 1.1, .3, 1);
}
.w[data-moving] { transition: none; }
.b {
  display: grid; place-items: center; inline-size: 100%; block-size: 100%; padding: 0; border: 1px solid var(--line); border-radius: 50%;
  background: var(--bg); color: var(--ink); box-shadow: var(--shadow); cursor: pointer; outline: none;
  transition: opacity .28s ease, transform .18s cubic-bezier(.2, 1.3, .4, 1);
}
.w[data-idle]:not([data-open]) .b { opacity: .5; }
.w[data-away]:not([data-open]) .b { opacity: .18; transform: translateX(var(--aside, 0)) scale(.86); }
.b:hover { opacity: 1 !important; transform: scale(1.06); }
.b:active { transform: scale(.94); }
.b:focus-visible, .i:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.w[data-moving] .b { cursor: grabbing; transform: scale(1.08); }
svg { inline-size: 19px; block-size: 19px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.p {
  position: absolute; top: calc(100% + ${GAP}px); right: 0; inline-size: ${PANEL_WIDTH}px; max-block-size: var(--room, none); overflow-y: auto; padding: 5px; box-sizing: border-box;
  border: 1px solid var(--line); border-radius: 15px; background: var(--bg); box-shadow: var(--shadow);
  visibility: hidden; opacity: 0; pointer-events: none; transform: translateY(-10px) scaleY(.82); transform-origin: top;
  transition: transform .14s ease-in, opacity .12s ease-in, visibility 0s .14s;
}
.w[data-up] .p { top: auto; bottom: calc(100% + ${GAP}px); transform: translateY(10px) scaleY(.82); transform-origin: bottom; }
.w[data-start] .p { left: 0; right: auto; }
.w[data-open] .p {
  visibility: visible; opacity: 1; pointer-events: auto; transform: none;
  transition: transform .24s cubic-bezier(.2, 1.25, .35, 1), opacity .14s ease-out, visibility 0s;
}
.i {
  display: flex; align-items: center; gap: 10px; inline-size: 100%; min-block-size: 38px; padding: 0 10px; box-sizing: border-box; border: 0; border-radius: 10px;
  background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; outline: none;
  opacity: 0; transform: translateY(-4px); transition: background-color .12s ease, color .12s ease;
}
.w[data-open] .i { opacity: 1; transform: none; transition: background-color .12s ease, color .12s ease, opacity .18s ease var(--d, 0s), transform .22s ease var(--d, 0s); }
.i:hover { background: var(--line); }
.i[aria-checked="true"] { background: var(--ink); color: var(--bg); font-weight: 600; }
.n { margin: 4px 10px; font-size: 12px; line-height: 1.35; color: color-mix(in srgb, var(--ink) 72%, transparent); }
hr { block-size: 1px; margin: 4px 6px; border: 0; background: var(--line); }
.q { min-block-size: 32px; font-size: 12px; font-weight: 400; color: color-mix(in srgb, var(--ink) 72%, transparent); }
.q svg { inline-size: 16px; block-size: 16px; }
.w[data-look="dark"] { --shadow: 0 1px 2px rgb(0 0 0 / .4), 0 8px 22px rgb(0 0 0 / .5); }
.w[data-look="eink"] { --bg: #fff; --ink: #000; --line: #000; --shadow: none; }
.w[data-look="eink"], .w[data-look="eink"] * { transition: none !important; }
.w[data-look="paper"] { --bg: #f5f0e6; --ink: #2b251e; --shadow: 0 1px 2px rgb(60 45 25 / .22), 0 6px 16px rgb(60 45 25 / .18); }
@media (prefers-reduced-motion: reduce) { .w, .w * { transition: none !important; } }
@media (forced-colors: active) { .b, .p { border: 1px solid ButtonText; } .i[aria-checked="true"] { outline: 2px solid Highlight; } }
@media print { .w { display: none; } }
`;

  /** @type {ReturnType<typeof build> | null} */
  let ui = null;
  /** @type {{ x?: number, y?: number, hide?: boolean } | null} */
  let place = null;
  let wanted = false;
  let choice = 'dark';
  /** @type {any} */
  let theme = {};
  let asking = 0;

  /** The words in the language chosen in the settings, when that is not the language of the browser. @type {Record<string, string> | null} */
  let labels = null;
  let pinned = false;
  const alive = () => !!chrome.runtime?.id;
  /** @param {string} key */
  const text = (key) => labels?.[key] || chrome.i18n.getMessage(key) || key;
  /** @param {Record<string, unknown>} message */
  const send = (message) => (alive() ? chrome.runtime.sendMessage(message).catch(() => null) : Promise.resolve(null));

  /** @param {string} d */
  function icon(d) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  /** @param {number} v @param {number} low @param {number} high */
  const clamp = (v, low, high) => Math.min(high, Math.max(low, v));

  function build() {
    for (const old of document.querySelectorAll('dk-float')) old.remove();
    const host = document.createElement('dk-float');
    host.setAttribute('data-dk', 'float');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;inset:0 auto auto 0!important;inline-size:0!important;block-size:0!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;background:none!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'w';
    // The direction of the page comes through `all: initial`. The menu reads in the language of its own words.
    wrap.dir = labels?.dir || chrome.i18n.getMessage('@@bidi_dir') || 'ltr';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'b';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', text('floatOpen'));
    button.title = text('floatOpen');
    const panel = document.createElement('div');
    panel.className = 'p';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', text('floatOpen'));
    /** @type {Record<string, HTMLButtonElement>} */
    const items = {};
    CHOICES.forEach((name, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'i';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.style.setProperty('--d', `${i * 18}ms`);
      item.tabIndex = -1;
      const label = document.createElement('span');
      label.textContent = text(LABELS[name]);
      item.append(icon(ICONS[name]), label);
      item.addEventListener('click', () => void pick(name));
      items[name] = item;
      panel.append(item);
    });
    const line = document.createElement('hr');
    const quiet = document.createElement('button');
    quiet.type = 'button';
    quiet.className = 'i q';
    quiet.setAttribute('role', 'menuitem');
    quiet.style.setProperty('--d', '90ms');
    quiet.tabIndex = -1;
    const quietLabel = document.createElement('span');
    quietLabel.textContent = text('floatHide');
    quiet.append(icon(ICONS.hide), quietLabel);
    quiet.addEventListener('click', () => void hideHere());
    if (pinned) {
      const note = document.createElement('p');
      note.className = 'n';
      note.textContent = text('floatPinned');
      panel.append(note);
    }
    panel.append(line, quiet);
    wrap.append(button, panel);
    shadow.append(style, wrap);
    // A click on the button is not a click on the page: a menu of the page stays as it is, and no shortcut of the page runs.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerup', 'keydown', 'keyup', 'keypress']) {
      shadow.addEventListener(type, (e) => e.stopPropagation());
    }
    // The root can have no sibling, so before the body exists the button goes inside the root.
    if (document.body) document.body.after(host);
    else document.documentElement.append(host);
    try {
      host.showPopover();
    } catch {
      host.style.setProperty('z-index', '2147483647', 'important');
    }
    return { host, wrap, button, panel, items, quiet, height: panel.offsetHeight };
  }

  /** The stored place in pixels of this window. */
  function pixels() {
    const x = place?.x ?? DEFAULT_PLACE.x;
    const y = place?.y ?? DEFAULT_PLACE.y;
    const width = document.documentElement.clientWidth || innerWidth;
    return { x: EDGE + (x / 1000) * Math.max(0, width - SIZE - EDGE * 2), y: EDGE + (y / 1000) * Math.max(0, innerHeight - SIZE - EDGE * 2) };
  }

  /** @param {number} x @param {number} y */
  function moveTo(x, y) {
    if (!ui) return;
    const width = document.documentElement.clientWidth || innerWidth;
    const left = clamp(x, EDGE, Math.max(EDGE, width - SIZE - EDGE));
    const top = clamp(y, EDGE, Math.max(EDGE, innerHeight - SIZE - EDGE));
    ui.wrap.style.setProperty('--x', `${left}px`);
    ui.wrap.style.setProperty('--y', `${top}px`);
    const right = left + SIZE / 2 > width / 2;
    ui.wrap.style.setProperty('--aside', right ? '10px' : '-10px');
    ui.wrap.toggleAttribute('data-start', !right || left + SIZE - PANEL_WIDTH < EDGE);
    const below = innerHeight - top - SIZE - GAP - EDGE;
    const above = top - GAP - EDGE;
    const up = below < ui.height && above > below;
    ui.wrap.toggleAttribute('data-up', up);
    ui.wrap.style.setProperty('--room', `${Math.max(0, up ? above : below)}px`);
    return { left, top };
  }

  /** @param {number} x @param {number} y */
  function settle(x, y) {
    const width = document.documentElement.clientWidth || innerWidth;
    const near = (/** @type {number} */ v, /** @type {number} */ end) => (v - EDGE < SNAP ? EDGE : end - v < SNAP ? end : v);
    const at = moveTo(near(x, width - SIZE - EDGE), near(y, innerHeight - SIZE - EDGE));
    if (!at) return;
    const spanX = Math.max(1, width - SIZE - EDGE * 2);
    const spanY = Math.max(1, innerHeight - SIZE - EDGE * 2);
    const next = { x: Math.round(((at.left - EDGE) / spanX) * 1000), y: Math.round(((at.top - EDGE) / spanY) * 1000) };
    place = { ...place, ...next };
    void send({ type: 'dk.float.place', ...next });
  }

  /** @param {boolean} on @param {boolean} [focus] */
  function setOpen(on, focus = false) {
    if (!ui) return;
    ui.wrap.toggleAttribute('data-open', on);
    ui.button.setAttribute('aria-expanded', String(on));
    if (on) {
      addEventListener('pointerdown', onOutside, true);
      if (focus) ui.items[choice]?.focus();
    } else {
      removeEventListener('pointerdown', onOutside, true);
      if (focus) ui.button.focus();
    }
    if (!on) rest();
  }

  /** @param {Event} e */
  function onOutside(e) {
    if (ui && !e.composedPath().includes(ui.host)) setOpen(false);
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;
  function rest() {
    clearTimeout(idleTimer);
    ui?.wrap.removeAttribute('data-idle');
    idleTimer = setTimeout(() => ui?.wrap.setAttribute('data-idle', ''), IDLE_MS);
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let scrollTimer;
  function onScroll() {
    if (!ui) return;
    if (ui.wrap.hasAttribute('data-open')) setOpen(false);
    ui.wrap.setAttribute('data-away', '');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => ui?.wrap.removeAttribute('data-away'), SCROLL_END_MS);
  }

  function onResize() {
    const at = pixels();
    moveTo(at.x, at.y);
  }

  /** @param {string} name */
  async function pick(name) {
    choice = name;
    paint();
    await send({ type: 'dk.float.mode', choice: name });
  }

  async function hideHere() {
    place = { ...place, hide: true };
    await send({ type: 'dk.float.place', hide: true });
    remove();
  }

  function paint() {
    if (!ui) return;
    const dark = choice === 'dark';
    ui.wrap.dataset.look = choice;
    if (dark || choice === 'light' || choice === 'original') {
      ui.wrap.style.setProperty('--bg', (dark ? theme.darkBackground : theme.lightBackground) ?? (dark ? '#16181d' : '#fff'));
      ui.wrap.style.setProperty('--ink', (dark ? theme.darkText : theme.lightText) ?? (dark ? '#e6e8eb' : '#1a1c20'));
    } else {
      ui.wrap.style.removeProperty('--bg');
      ui.wrap.style.removeProperty('--ink');
    }
    for (const name of CHOICES) ui.items[name].setAttribute('aria-checked', String(name === choice));
    ui.button.replaceChildren(icon(ICONS[/** @type {keyof typeof ICONS} */ (choice)]));
  }

  /** @param {KeyboardEvent} e */
  function onButtonKey(e) {
    if (!ui) return;
    const open = ui.wrap.hasAttribute('data-open');
    if (e.key === 'Escape' && open) {
      setOpen(false, true);
      return;
    }
    if (open) return;
    const step = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = pixels();
    settle(at.x + step[0], at.y + step[1]);
  }

  /** @param {KeyboardEvent} e */
  function onPanelKey(e) {
    if (!ui) return;
    if (e.key === 'Escape') {
      setOpen(false, true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...Object.values(ui.items), ui.quiet];
    const at = list.indexOf(/** @type {any} */ (/** @type {ShadowRoot} */ (ui.panel.getRootNode()).activeElement));
    list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
  }

  function wire() {
    if (!ui) return;
    const { wrap, button, panel } = ui;
    /** @type {{ id: number, x: number, y: number, left: number, top: number, moved: boolean } | null} */
    let press = null;
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const at = pixels();
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, left: at.x, top: at.y, moved: false };
      button.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    button.addEventListener('pointermove', (e) => {
      if (press?.id !== e.pointerId) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
      if (!press.moved) {
        press.moved = true;
        setOpen(false);
        wrap.setAttribute('data-moving', '');
      }
      moveTo(press.left + dx, press.top + dy);
    });
    button.addEventListener('pointerup', (e) => {
      const was = press;
      press = null;
      if (was?.id !== e.pointerId) return;
      if (!was.moved) {
        setOpen(!wrap.hasAttribute('data-open'));
        return;
      }
      wrap.removeAttribute('data-moving');
      settle(was.left + e.clientX - was.x, was.top + e.clientY - was.y);
      rest();
    });
    button.addEventListener('pointercancel', () => {
      press = null;
      wrap.removeAttribute('data-moving');
      onResize();
    });
    // Enter and Space arrive as a click with no pointer.
    button.addEventListener('click', (e) => {
      if (e.detail === 0) setOpen(!wrap.hasAttribute('data-open'), true);
    });
    button.addEventListener('keydown', onButtonKey);
    panel.addEventListener('keydown', onPanelKey);
    button.addEventListener('pointerenter', rest);
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize, { passive: true });
  }

  function remove() {
    clearTimeout(idleTimer);
    clearTimeout(scrollTimer);
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onResize);
    removeEventListener('pointerdown', onOutside, true);
    ui?.host.remove();
    ui = null;
  }

  async function appear() {
    const mine = ++asking;
    if (place === null) {
      const reply = /** @type {any} */ (await send({ type: 'dk.float.get' }));
      if (mine !== asking) return;
      place = reply?.place ?? {};
      labels = reply?.labels ?? null;
      pinned = reply?.pinned === true;
    }
    if (!wanted || place?.hide === true) {
      remove();
      return;
    }
    if (!ui) {
      ui = build();
      wire();
      onResize();
      rest();
    }
    paint();
  }

  /** The popup can show the button again for this site. @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
  function onStored(changes, area) {
    if (area !== 'local' || !changes.ui || !wanted) return;
    place = null;
    void appear();
  }
  chrome.storage.onChanged.addListener(onStored);

  /** @type {any} */ (dk).float = Object.freeze({
    /** Follow a decision of the gate. A site that is off gets nothing. @param {any} d */
    sync(d) {
      if (d.status === 'off' || d.status === 'site-off' || /** @type {any} */ (document).prerendering === true) {
        this.hide();
        return;
      }
      wanted = true;
      const paper = d.theme?.einkPreset === 'eink' ? 'eink' : 'paper';
      choice = d.mode === 'eink' ? paper : d.mode === 'light' || d.mode === 'original' ? d.mode : 'dark';
      theme = d.theme ?? {};
      void appear();
    },
    hide() {
      wanted = false;
      asking += 1;
      remove();
    },
    stop() {
      wanted = false;
      asking += 1;
      remove();
      try {
        chrome.storage.onChanged.removeListener(onStored);
      } catch {
        // The context may be gone.
      }
    },
  });
})();
