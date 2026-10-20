// @ts-check
// The small extras of the dark and light modes: a font, heavier text, a scrollbar color and a selection color. One style
// element, `data-dk=extras`, written from the settings and kept in the page by `keep.js`. Nothing is written for a setting
// that is off, and the style element is not created when no setting is on. The colors of the page are the job of the
// engines; this file never reads the page. The E-ink and Paper mode has its own font and weight (`calm.js`).
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const color = /** @type {any} */ (dk.color);
  const calm = /** @type {any} */ (dk.calm);
  const keepApi = /** @type {any} */ (dk.keep);
  if (!color || !calm) return;

  // Text that gets the font. Icon fonts keep theirs: an element named like an icon, a vector graphic, code and the other
  // monospace tags, and anything hidden from assistive tools are left out. What is inside code, a graphic or a hidden element
  // inherits the font of that element (`unset`). A selector that asks for the ancestors of every element costs twice as much
  // on a big page as these two rules, in which only the tag names are asked for the ancestors.
  const SKIP = 'i,svg,code,pre,kbd,samp,tt,[aria-hidden="true"],[class*="icon" i],[class*="glyph" i],[class*="material" i],[class*="fa-"],.fa,.fas,.far,.fab';
  const FONT_SELECTOR = `:where(:not(${SKIP}))`;
  const FONT_INSIDE = 'pre *,code *,kbd *,samp *,tt *,svg *,[aria-hidden="true"] *';
  const HEX = /^#[0-9a-f]{6}$/i;

  /** The text color on a selection of this color: black or white, whichever reads better. @param {string} hex */
  function onColor(hex) {
    const c = color.parseColor(hex);
    if (!c) return '#000000';
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 1, g: 1, b: 1, a: 1 };
    return color.contrastRatio(c, black) >= color.contrastRatio(c, white) ? '#000000' : '#ffffff';
  }

  /**
   * The rules for these theme settings, or '' when no extra is on. Scrollbar and selection colors are skipped when
   * `colors` is false: the Filter engines invert the page, and a color chosen for the page would come out inverted.
   * @param {Record<string, any>} s the `theme` object @param {boolean} [colors]
   */
  function build(s, colors = true) {
    const out = [];
    if (s.fontEnabled === true && typeof s.fontFamily === 'string') {
      const stack = calm.fontStack(s.fontFamily);
      if (stack) out.push(`${FONT_SELECTOR}{font-family:${stack}!important}`, `${FONT_INSIDE}{font-family:unset!important}`);
    }
    if (Number.isInteger(s.textStroke) && s.textStroke > 0 && s.textStroke <= 10) {
      out.push(`body{-webkit-text-stroke-width:${Math.round(s.textStroke) / 10}px!important}`);
    }
    if (colors && typeof s.scrollbar === 'string' && HEX.test(s.scrollbar)) {
      out.push(`*{scrollbar-color:${s.scrollbar} transparent!important}`);
    }
    if (colors && typeof s.selection === 'string' && HEX.test(s.selection)) {
      out.push(`::selection{background-color:${s.selection}!important;color:${onColor(s.selection)}!important}`);
    }
    return out.length ? `@media screen{${out.join('')}}` : '';
  }

  /** @type {{ end: () => void, text: string } | null} */
  let active = null;

  /** @param {Record<string, any>} themeSettings @param {{ colors?: boolean }} [options] */
  function start(themeSettings, options = {}) {
    const text = build(themeSettings ?? {}, options.colors !== false);
    if (active && active.text === text) return;
    stop();
    if (text === '') return;
    const style = document.createElement('style');
    style.setAttribute('data-dk', 'extras');
    style.textContent = text;
    const place = () => (document.head ?? document.documentElement).append(style);
    place();
    const keeper = keepApi ? keepApi.create() : null;
    keeper?.track(style, place);
    active = {
      text,
      end() {
        keeper?.stop();
        style.remove();
      },
    };
  }

  function stop() {
    active?.end();
    active = null;
  }

  /**
   * Start or stop for the decision of the gate. The Filter engines invert the page, so the colors are left out under them.
   * @param {boolean} on @param {Record<string, any>} themeSettings @param {string} kind
   */
  function sync(on, themeSettings, kind) {
    if (on) start(themeSettings, { colors: kind !== 'filter' && kind !== 'filterPlus' });
    else stop();
  }

  dk.extras = Object.freeze({ start, stop, sync, build, onColor, isActive: () => active !== null });
})();
