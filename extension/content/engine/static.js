// @ts-check
// The Static engine. A site's stored theme names the elements to color: backgrounds, text, borders and the ones to
// leave alone. The engine writes one style element from those lists. It reads no stylesheet and looks at no element, so
// its cost does not depend on the size of the page.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const color = /** @type {any} */ (dk.color);
  const keepApi = /** @type {any} */ (dk.keep);
  if (!color) return;

  const STATE = 'data-dk-state';

  /** Keep the selectors the browser accepts; one bad selector must not drop the whole rule. @param {unknown} list @returns {string[]} */
  function usable(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((s) => {
      if (typeof s !== 'string' || s.trim() === '') return false;
      try {
        document.createDocumentFragment().querySelector(s);
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * The CSS text for a theme and a static fix.
   * @param {Record<string, any>} themeSettings
   * @param {{ bg?: string[], fg?: string[], border?: string[], skip?: string[] }} data
   */
  function build(themeSettings, data) {
    const theme = color.createTheme(themeSettings);
    const transformer = color.createTransformer(theme);
    // The page's white, black and mid gray, taken through the same curves as the Dynamic engine uses.
    const bg = transformer.transform('#ffffff', 'background') ?? '#16181d';
    const fg = transformer.transform('#000000', 'foreground') ?? '#e6e8eb';
    const border = transformer.transform('#808080', 'border') ?? '#3a3d44';
    const skip = usable(data.skip);
    const guard = skip.length ? `:not(:is(${skip.join(',')}))` : '';
    /** @param {string[]} list @param {string} body */
    const rule = (list, body) => (list.length ? `:is(${list.join(',')})${guard}{${body}}` : '');
    const scheme = theme.dark ? 'dark' : 'light';
    return [
      '@media screen{',
      `:root{color-scheme:${scheme}}`,
      `html,body{background-color:${bg}!important;color:${fg}!important}`,
      rule(usable(data.bg), `background-color:${bg}!important;background-image:none!important`),
      rule(usable(data.fg), `color:${fg}!important`),
      rule(usable(data.border), `border-color:${border}!important`),
      '}',
    ].join('');
  }

  /** @type {{ end: () => void, stats: () => any } | null} */
  let active = null;

  /**
   * @param {Record<string, any>} themeSettings
   * @param {{ bg?: string[], fg?: string[], border?: string[], skip?: string[] }} data
   * @param {{ beforeCommit?: () => void, startedAt?: number }} [options]
   */
  function start(themeSettings, data, options = {}) {
    stop();
    const root = document.documentElement;
    const style = document.createElement('style');
    style.setAttribute('data-dk', 'static');
    style.textContent = build(themeSettings ?? {}, data ?? {});
    root.append(style);
    const keeper = keepApi ? keepApi.create() : null;
    keeper?.track(style, () => root.append(style));
    options.beforeCommit?.();
    root.setAttribute(STATE, 'ready');
    const readyAt = performance.now();
    active = {
      end() {
        keeper?.stop();
        style.remove();
        if (root.getAttribute(STATE) === 'ready') root.removeAttribute(STATE);
      },
      stats: () => ({ engine: 'static', sheets: 0, readyAt, startedAt: options.startedAt ?? null, bytes: style.textContent?.length ?? 0, restored: keeper ? keeper.stats().restored : 0 }),
    };
  }

  function stop() {
    active?.end();
    active = null;
  }

  dk.staticEngine = Object.freeze({ start, stop, build, isActive: () => active !== null, stats: () => (active ? active.stats() : null) });
})();
