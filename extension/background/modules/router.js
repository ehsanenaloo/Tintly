// @ts-check
// The message router. Every message is checked three times: who sent it, whether that sender may send this type,
// and whether the payload has exactly the expected shape. Anything else gets a fixed code and changes nothing.
import { L } from '../../shared/limits.js';
import { candidates, parsePage, patternFor, siteEnabled } from '../../shared/match.js';
import { tabReports } from './loading.js';

/** @typedef {{ ok: false, code: string } | { ok: true, [key: string]: any }} Reply */
/**
 * @typedef {{ tabId: number, frameId: number, pageUrl: string, rights?: string, documentId?: string, top?: string }} Requester
 * @typedef {{ from: 'page' | 'content', fields: Record<string, (v: unknown) => boolean>, optional?: string[], topFrame?: boolean, run: (m: any, who: any) => Promise<Reply> | Reply }} Handler
 */

const STATUSES = new Set(['on', 'off', 'site-off', 'dark-detected', 'page-scheme', 'site-theme', 'site-theme-repaired', 'fallback', 'pending', 'safe-mode', 'start-failed']);

const isString = (/** @type {number} */ max) => (/** @type {unknown} */ v) => typeof v === 'string' && v.length <= max;
const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBool = (/** @type {unknown} */ v) => typeof v === 'boolean';
const isTabId = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
const IMPORT_CHARS = 1024 * 1024 + 4096;

/**
 * @param {{
 *   runtimeId: string,
 *   extensionOrigin: string,
 *   state: ReturnType<typeof import('./state.js').createState>,
 *   net: ReturnType<typeof import('./net.js').createNet>,
 *   icon: { apply: (tabId: number, status: string) => Promise<void> | void },
 *   data: { forHost: (host: string, pathname: string, userFixes: any) => Promise<any> },
 *   ondemand?: { inject: (name: unknown, who: { tabId: number, frameId: number }) => Promise<Reply> },
 *   register?: { sync: () => Promise<void>, readonly failed: boolean, readonly plan: { matches: string[], excludeMatches: string[] } | null | undefined },
 *   tabs?: { get: (tabId: number) => Promise<{ url?: string, favIconUrl?: string }> },
 * }} deps
 */
export function createRouter({ runtimeId, extensionOrigin, state, net, icon, data, tabs, ondemand, register }) {
  /**
   * Who sent this. Extension pages are known by their address, content scripts by the tab and frame that the browser
   * attaches. A web page cannot make either of these up.
   * @param {any} sender
   * @returns {{ kind: 'page' } | { kind: 'content', who: Requester & { host: string, pathname: string } } | null}
   */
  function classify(sender) {
    if (!sender || typeof sender !== 'object' || sender.id !== runtimeId) return null;
    if (typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin)) return { kind: 'page' };
    if (!sender.tab || !Number.isInteger(sender.tab.id) || !Number.isInteger(sender.frameId)) return null;
    const own = typeof sender.url === 'string' && /^https?:/i.test(sender.url) ? sender.url : null;
    // A frame without an address of its own (about:blank, srcdoc, blob:, data:) belongs to the page that made it. Any
    // other kind of address (another extension's page, a browser page) is not a web page and gets no service.
    const inherits = typeof sender.url === 'string' && /^(about:(blank|srcdoc)|blob:|data:)/i.test(sender.url);
    if (!own && !inherits) return null;
    const top = typeof sender.tab.url === 'string' && /^https?:/i.test(sender.tab.url) ? sender.tab.url : null;
    // The origin the browser gives a frame without an address is the one of the frame that made it, which can be a third party
    // inside the top page. Only a frame of the top page's own origin takes the top page's address, path included.
    const made = !own && typeof sender.origin === 'string' && /^https?:\/\/[^/]+$/i.test(sender.origin) ? sender.origin : null;
    const sameAsTop = made !== null && top !== null && (() => {
      try {
        return new URL(top).origin === made;
      } catch {
        return false;
      }
    })();
    const pageUrl = own ?? (made !== null && !sameAsTop ? `${made}/` : top);
    if (!pageUrl) return null;
    let host = '';
    let pathname = '/';
    try {
      const u = new URL(pageUrl);
      host = u.host;
      pathname = u.pathname;
    } catch {
      return null;
    }
    // Network rights (a page on a private network may fetch from it) follow a verified owner only. A frame without an address
    // whose origin the browser did not tell (older browsers) or reports as opaque (a sandbox) gets the top page's fixes but no
    // rights to private addresses: it could belong to a third party.
    const rights = own !== null || made !== null ? pageUrl : '';
    // The top page names the part of the proxy's stores the frame uses (net.js `partitionOf`).
    const where = top !== null ? { top } : {};
    return { kind: 'content', who: { tabId: sender.tab.id, frameId: sender.frameId, pageUrl, host, pathname, rights, ...where, ...(typeof sender.documentId === 'string' ? { documentId: sender.documentId } : {}) } };
  }

  /**
   * What fixes the mode of a page so that the popup's choice changes nothing there: the mode of a site rule, of a fix, or a
   * schedule that switches between two modes. Same order as the gate (`decide` in content/core/boot.js). `clear` is the rule or the
   * fix without that mode, ready to be stored again. Null when nothing pins the mode.
   * @param {string} url @param {any} s the stored state
   */
  async function pinFor(url, s) {
    const page = parsePage(url);
    if (!page) return null;
    const modeOf = (/** @type {any} */ theme) => (isObject(theme) && typeof theme.mode === 'string' ? theme : null);
    const without = (/** @type {any} */ theme) => {
      const { mode: _mode, ...rest } = theme;
      return rest;
    };
    const keys = candidates(page.host, page.pathname);
    const ruleKey = isObject(s.siteRules) ? keys.find((k) => Object.hasOwn(s.siteRules, k)) : undefined;
    const rule = ruleKey === undefined ? null : s.siteRules[ruleKey];
    const ruleTheme = isObject(rule) ? modeOf(rule.theme) : null;
    if (ruleTheme && ruleKey !== undefined) {
      const rest = without(ruleTheme);
      const { theme: _theme, ...others } = rule;
      const clear = Object.keys(rest).length ? { ...others, theme: rest } : others;
      return { kind: 'rule', mode: ruleTheme.mode, preset: ruleTheme.einkPreset ?? null, key: ruleKey, clear: Object.keys(clear).length ? clear : null };
    }
    const found = await data.forHost(page.host, page.pathname, s.userFixes);
    const fix = found.user ?? found.builtin;
    const fixTheme = isObject(fix) && isObject(fix.dynamic) ? modeOf(fix.dynamic.theme) : null;
    if (fixTheme) {
      const userKey = found.user !== null && isObject(s.userFixes) ? keys.find((k) => Object.hasOwn(s.userFixes, k)) : undefined;
      const rest = without(fixTheme);
      const { theme: _theme, ...dynamic } = fix.dynamic;
      return { kind: 'fix', mode: fixTheme.mode, preset: fixTheme.einkPreset ?? null, key: userKey ?? patternFor(url), clear: { ...fix, dynamic: Object.keys(rest).length ? { ...dynamic, theme: rest } : dynamic } };
    }
    const auto = s.settings?.automation;
    if (isObject(auto) && auto.behavior === 'scheme' && auto.mode !== 'none') return { kind: 'schedule' };
    return null;
  }

  /**
   * The setting `theme.useSiteDark` for the page's site as the popup needs it: `off` when a site rule or a fix turns the site's own
   * dark theme off (the rule beats the fix), `offRule` and `onRule` the rule to store for each choice (`onRule` is null when the
   * rule would be empty).
   * @param {string} url @param {any} s the stored state
   */
  async function siteDarkFor(url, s) {
    const page = parsePage(url);
    if (!page) return null;
    const flag = (/** @type {any} */ theme) => (isObject(theme) && typeof theme.useSiteDark === 'boolean' ? theme.useSiteDark : null);
    const keys = candidates(page.host, page.pathname);
    const ruleKey = isObject(s.siteRules) ? keys.find((k) => Object.hasOwn(s.siteRules, k)) : undefined;
    const rule = ruleKey === undefined || !isObject(s.siteRules[ruleKey]) ? {} : s.siteRules[ruleKey];
    const found = await data.forHost(page.host, page.pathname, s.userFixes);
    const fix = found.user ?? found.builtin;
    const fixFlag = isObject(fix) && isObject(fix.dynamic) ? flag(fix.dynamic.theme) : null;
    const { theme: ruleTheme, ...others } = rule;
    const rest = isObject(ruleTheme) ? Object.fromEntries(Object.entries(ruleTheme).filter(([k]) => k !== 'useSiteDark')) : {};
    const withFlag = (/** @type {boolean} */ value) => ({ ...others, theme: { ...rest, useSiteDark: value } });
    const bare = { ...others, ...(Object.keys(rest).length ? { theme: rest } : {}) };
    const onRule = fixFlag === false ? withFlag(true) : Object.keys(bare).length ? bare : null;
    return { off: (flag(ruleTheme) ?? fixFlag) === false, key: ruleKey ?? patternFor(url), offRule: withFlag(false), onRule };
  }

  /** @type {Record<string, Handler>} */
  const handlers = {
    'dk.state.get': {
      from: 'page',
      fields: { url: isString(4096), tabId: isTabId, fixes: isBool },
      optional: ['url', 'tabId', 'fixes'],
      async run(m) {
        const read = await state.read();
        if (!read.ok) return read;
        const s = read.state;
        const tab = m.tabId === undefined ? null : await state.getTabStatus(m.tabId);
        const site = m.url === undefined ? null : { enabled: siteEnabled(s.settings, s.siteRules, m.url), pattern: patternFor(m.url) };
        const pin = m.url === undefined ? null : await pinFor(m.url, s);
        const siteDark = m.url === undefined ? null : await siteDarkFor(m.url, s);
        return { ok: true, settings: s.settings, siteRules: s.siteRules, presets: s.presets, darkSites: s.darkSites, ui: s.ui, site, tab, pin, siteDark, ...(m.fixes === true ? { userFixes: s.userFixes } : {}) };
      },
    },
    'dk.settings.patch': { from: 'page', fields: { patch: isObject }, run: (m) => state.patchSettings(m.patch) },
    'dk.site.set': {
      from: 'page',
      fields: { pattern: isString(300), rule: (v) => v === null || isObject(v), ifAbsent: isBool },
      optional: ['ifAbsent'],
      run: (m) => state.setSite(m.pattern, m.rule, m.ifAbsent === true),
    },
    // Change some fields of a site rule, merged with the rule as it is now (another window may have changed other fields).
    'dk.site.patch': {
      from: 'page',
      fields: { pattern: isString(300), patch: isObject, remove: (v) => Array.isArray(v) && v.length <= 100 && v.every(isString(80)) },
      optional: ['remove'],
      run: (m) => state.patchSite(m.pattern, m.patch, m.remove ?? []),
    },
    // The site switch of a page: the rule that decides for this address gets the value, and the reply says the state of the page.
    'dk.site.switch': { from: 'page', fields: { url: isString(4096), enabled: isBool }, run: (m) => state.toggleSite(m.url, m.enabled) },
    'dk.preset.save': { from: 'page', fields: { preset: isObject }, run: (m) => state.savePreset(m.preset) },
    'dk.preset.delete': { from: 'page', fields: { id: isString(40) }, run: (m) => state.deletePreset(m.id) },
    'dk.import': {
      from: 'page',
      fields: { text: isString(IMPORT_CHARS), confirmed: isBool },
      optional: ['confirmed'],
      run: (m) => state.importText(m.text, m.confirmed === true),
    },
    'dk.fix.set': {
      from: 'page',
      fields: { pattern: isString(300), fix: (v) => v === null || isObject(v), ifAbsent: isBool },
      optional: ['ifAbsent'],
      run: (m) => state.setFix(m.pattern, m.fix, m.ifAbsent === true),
    },
    // Turn on custom CSS that arrived by import or sync, after the settings page showed it. `css` is the text that was shown.
    'dk.css.enable': {
      from: 'page',
      fields: { scope: (v) => v === 'settings' || v === 'siteRules' || v === 'userFixes', pattern: isString(300), css: isString(L.CSS_CHARS) },
      optional: ['pattern'],
      run: (m) => state.enableCss(m.scope, m.pattern, m.css),
    },
    'dk.ui.set': { from: 'page', fields: { ui: isObject }, run: (m) => state.setUi(m.ui) },
    'dk.reset': { from: 'page', fields: { confirmed: isBool }, run: (m) => (m.confirmed === true ? state.reset() : { ok: false, code: 'unconfirmed' }) },
    'dk.export': { from: 'page', fields: {}, run: () => state.exportText() },
    // Bring the registration of the content scripts to the stored settings now. The worker does it on every change; the call is for a page that must know it is done.
    'dk.register.sync': {
      from: 'page',
      fields: {},
      async run() {
        if (!register) return { ok: false, code: 'unavailable' };
        await register.sync();
        return { ok: true, failed: register.failed, plan: register.plan ?? null };
      },
    },
    'dk.tab.preview': { from: 'page', fields: {}, optional: [], run: () => ({ ok: false, code: 'unsupported' }) },

    'dk.fix.forHost': {
      from: 'content',
      // The browser reports the address a frame had when it loaded; a page that changed its route says the new path.
      fields: { path: (v) => typeof v === 'string' && v.length <= 2048 && v.startsWith('/') },
      optional: ['path'],
      async run(m, who) {
        const read = await state.read();
        if (!read.ok) return read;
        const found = await data.forHost(who.host, m.path ?? who.pathname, read.state.userFixes);
        const mark = await state.getHostMark(who.host);
        return { ok: true, builtin: found.builtin ?? null, user: found.user ?? null, dark: found.dark === true, paths: found.paths === true, mark };
      },
    },
    'dk.favicon': {
      from: 'page',
      fields: { tabId: isTabId },
      async run(m) {
        if (!tabs) return { ok: false, code: 'unavailable' };
        let tab;
        try {
          tab = await tabs.get(m.tabId);
        } catch {
          return { ok: false, code: 'tab' };
        }
        const href = tab.favIconUrl;
        if (typeof href !== 'string' || href === '' || typeof tab.url !== 'string') return { ok: false, code: 'none' };
        if (/^data:image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]{1,40000}$/.test(href)) return { ok: true, dataUrl: href };
        const r = await net.favicon(href, { tabId: m.tabId, frameId: 0, pageUrl: tab.url });
        return r.ok ? { ok: true, dataUrl: `data:${r.mime};base64,${r.base64}` } : r;
      },
    },
    // A page script asks for an optional engine module by name. Only names from the fixed list of ondemand.js work.
    'dk.inject': {
      from: 'content',
      fields: { module: isString(20) },
      run: (m, who) => (ondemand ? ondemand.inject(m.module, who) : { ok: false, code: 'unavailable' }),
    },
    'dk.net.text': { from: 'content', fields: { url: isString(2048), charset: isString(64) }, optional: ['charset'], run: (m, who) => net.text(m.url, who, m.charset) },
    'dk.net.image': { from: 'content', fields: { url: isString(2048), sample: isBool }, optional: ['sample'], run: (m, who) => net.image(m.url, who, m.sample === true) },
    'dk.page.status': {
      from: 'content',
      topFrame: true,
      fields: { status: (v) => typeof v === 'string' && STATUSES.has(v), at: (v) => Number.isFinite(v) },
      optional: ['at'],
      async run(m, who) {
        // A report from a page that was left (the message was slow) must not replace the status of the page that came after it.
        if (!tabReports.accept(who.tabId, typeof m.at === 'number' ? m.at : undefined, who.pageUrl)) return { ok: true };
        await state.setTabStatus(who.tabId, m.status);
        await icon.apply(who.tabId, m.status);
        return { ok: true };
      },
    },
  };

  /**
   * Is the sender the page of its tab? A page loaded ahead of time (prerendered) keeps a frame id other than 0 after it is shown, so
   * the frame type decides where the browser gives it (Chrome); elsewhere (Firefox) the page is frame 0. A prerendered page is not
   * the tab's page yet: it speaks when it is shown.
   * @param {any} sender @param {number} frameId
   */
  function mainFrame(sender, frameId) {
    if (sender.documentLifecycle === 'prerender') return false;
    return typeof sender.frameType === 'string' ? sender.frameType === 'outermost_frame' : frameId === 0;
  }

  /**
   * @param {unknown} message
   * @param {any} sender
   * @returns {Promise<Reply>}
   */
  async function handle(message, sender) {
    const who = classify(sender);
    if (!who) return { ok: false, code: 'denied' };
    if (!isObject(message) || typeof (/** @type {any} */ (message).type) !== 'string') return { ok: false, code: 'invalid' };
    const m = /** @type {Record<string, unknown>} */ (message);
    const handler = Object.hasOwn(handlers, /** @type {string} */ (m.type)) ? handlers[/** @type {string} */ (m.type)] : null;
    if (!handler) return { ok: false, code: 'unknown' };
    if (handler.from !== who.kind) return { ok: false, code: 'denied' };
    if (handler.topFrame && who.kind === 'content' && !mainFrame(sender, who.who.frameId)) return { ok: false, code: 'denied' };

    for (const key of Object.keys(m)) {
      if (key !== 'type' && !Object.hasOwn(handler.fields, key)) return { ok: false, code: 'invalid' };
    }
    for (const [key, check] of Object.entries(handler.fields)) {
      if (!Object.hasOwn(m, key)) {
        if (handler.optional?.includes(key)) continue;
        return { ok: false, code: 'invalid' };
      }
      if (!check(m[key])) return { ok: false, code: 'invalid' };
    }
    try {
      return await handler.run(m, who.kind === 'content' ? who.who : null);
    } catch {
      return { ok: false, code: 'error' };
    }
  }

  return { handle, classify };
}
