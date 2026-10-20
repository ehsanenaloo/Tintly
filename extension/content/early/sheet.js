// @ts-check
// The first paint. A registered script (not a registered style) puts the quick version in a constructed style sheet before
// the page paints. Unlike a registered style, the gate can switch the sheet off for a read of the page's own cascade with
// `sheet.disabled`, which leaves no trace in the document, and take it out when the page is released.
(() => {
  const css = /** @type {string | undefined} */ (/** @type {any} */ (globalThis).__dkHoldCss);
  try {
    const root = document.documentElement;
    // Only a page of the gate's kind is held: a text, JSON, XML, style sheet or picture document is never released by the gate.
    const type = document.contentType;
    if (type !== 'text/html' && type !== 'application/xhtml+xml') return;
    if (!(root instanceof HTMLElement)) return;
    if (typeof css !== 'string' || /** @type {any} */ (globalThis).__dkHold || !root || root.hasAttribute('data-dk-go')) return;
    /** @type {CSSStyleSheet | null} */
    let sheet = null;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      // A browser that refuses a constructed sheet from a content script gets a style element.
      sheet = null;
      const el = document.createElement('style');
      el.textContent = css;
      root.append(el);
      sheet = el.sheet;
    }
    /** @type {any} */ (globalThis).__dkHold = sheet;
    // A safety net: whatever happens to the gate, the hold ends after a minute.
    const held = sheet;
    setTimeout(() => {
      try {
        if (held) {
          held.disabled = true;
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== held);
        }
        if (held?.ownerNode) held.ownerNode.remove();
      } catch {
        // The page is gone.
      }
    }, 60000);
  } catch {
    // The page is left to the gate; only the first frame is unprotected.
  }
})();
