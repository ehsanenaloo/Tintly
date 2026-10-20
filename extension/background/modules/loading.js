// @ts-check
// What the worker does when a tab starts loading a page. A page the registration does not cover has no script of ours, so
// nothing in the page can tell the icon and the popup why the extension is quiet there; the worker does. When the
// registration was refused, the worker puts the files into the loading page itself.

/**
 * The status of a page that gets no script, from the settings alone: `off` for the master switch, `site-off` for the rule of the
 * site. `idle` is the schedule keeping Tintly off, which the page would also call `off`. Null for a page the scripts cover (the page tells
 * its own status) and for an address that has no site.
 * @param {any} settings @param {any} siteRules @param {unknown} address
 * @param {(settings: any, siteRules: any, address: unknown) => boolean} siteEnabled
 * @param {boolean} [idle]
 * @returns {'off' | 'site-off' | null}
 */
export function quietStatus(settings, siteRules, address, siteEnabled, idle = false) {
  if (typeof address !== 'string' || !/^https?:/i.test(address)) return null;
  if ((settings && settings.enabled === false) || idle) return 'off';
  return siteEnabled(settings ?? {}, siteRules ?? {}, address) ? null : 'site-off';
}

/** The origin and path: a page may change its query or fragment (`replaceState`) before it reports. @param {unknown} address */
const page = (address) => {
  try {
    const u = new URL(String(address));
    return u.origin + u.pathname;
  } catch {
    return '';
  }
};

/** Tabs remembered at most; the oldest is dropped. */
const MAX_TABS = 200;

/**
 * Who said what last about each tab, shared by the router (the reports of the pages) and the loading code (the start of a navigation)
 * in the one worker. The start of a load does not clear a status that the new page has already reported: a page says its status once,
 * and the worker may handle the start of the load after the report (a worker that was asleep). Pages are told apart by address, since
 * the start of a load names no document. A report is from the new page when it comes from the address being loaded, or when it came
 * after the start of the load from another address than the page before (a redirect, a route the page set itself).
 * @type {Map<number, { at: number, from: string, address: string, before: string, fresh: boolean }>}
 */
const tabs = new Map();

/** @param {number} tabId */
function entry(tabId) {
  let e = tabs.get(tabId);
  if (e) tabs.delete(tabId);
  else e = { at: 0, from: '', address: '', before: '', fresh: false };
  tabs.set(tabId, e);
  if (tabs.size > MAX_TABS) {
    const oldest = tabs.keys().next();
    if (!oldest.done) tabs.delete(oldest.value);
  }
  return e;
}

export const tabReports = {
  /**
   * A page reports a status. False when the report is older than the newest report of the tab (the message was slow).
   * @param {number} tabId @param {number | undefined} at the page clock when it was sent @param {string} from the address of the page
   */
  accept(tabId, at, from) {
    const e = entry(tabId);
    const sent = typeof at === 'number' ? at : Date.now();
    if (e.at > sent) return false;
    e.at = sent;
    e.from = page(from);
    e.fresh = true;
    return true;
  },
  /** The tab began to load `address`. @param {number} tabId @param {string} address */
  navigated(tabId, address) {
    const e = entry(tabId);
    e.before = e.from;
    e.address = page(address);
    e.fresh = false;
  },
  /** Has the page at `address` already reported its status? @param {number} tabId @param {string} address */
  reportedBy(tabId, address) {
    const e = tabs.get(tabId);
    if (!e || e.from === '') return false;
    return e.from === page(address) || (e.fresh && e.from !== e.before);
  },
  /** @param {number} tabId */
  forget(tabId) {
    tabs.delete(tabId);
  },
};

/**
 * @param {{
 *   register: { settled(): Promise<void>, readonly plan: any, readonly failed: boolean, covers(address: unknown): boolean, injectLoading(tabId: number, address: string): Promise<boolean> },
 *   read: () => Promise<{ settings: any, siteRules: any, idle?: boolean } | null>,
 *   siteEnabled: (settings: any, siteRules: any, address: unknown) => boolean,
 *   setStatus: (tabId: number, status: string) => Promise<void>,
 *   clearStatus: (tabId: number) => Promise<void>,
 *   icon: { apply(tabId: number, status: string): Promise<void> | void },
 *   stale?: () => Promise<boolean>,
 *   refresh?: () => Promise<void>,
 * }} deps `stale` says that the clock has moved past what the registration was made for (a late alarm, a changed clock); then `refresh` brings it up to date
 */
export function createLoading({ register, read, siteEnabled, setStatus, clearStatus, icon, stale = async () => false, refresh = async () => {} }) {
  /** @param {number} tabId @param {string} status */
  async function show(tabId, status) {
    await setStatus(tabId, status);
    await icon.apply(tabId, status);
  }

  return {
    /**
     * A tab began to load `address`.
     * @param {number} tabId @param {unknown} address
     */
    async started(tabId, address) {
      if (typeof address !== 'string' || !/^https?:/i.test(address)) return;
      tabReports.navigated(tabId, address);
      await register.settled();
      if (await stale().catch(() => false)) {
        await refresh().catch(() => {});
        await register.settled();
      }
      const failed = register.failed;
      // Before the first pass has worked nothing is known; a page that is covered tells its own status.
      if (!failed && register.plan !== undefined && register.covers(address)) {
        // The status of the page before is stale now; a document that never reports (a text file, a picture) must not inherit it.
        // The new page may have reported already while the worker waited above: its status stays, since the page does not say it twice.
        if (!tabReports.reportedBy(tabId, address)) await clearStatus(tabId);
        return;
      }
      if (!failed && register.plan === undefined) return;
      const stored = await read();
      if (!stored) return;
      const status = quietStatus(stored.settings, stored.siteRules, address, siteEnabled, stored.idle === true);
      if (status !== null) return show(tabId, status);
      // The page should be themed but the registration was refused: put the files into it, and say so when that fails too.
      if (failed && !(await register.injectLoading(tabId, address))) await show(tabId, 'start-failed');
    },
  };
}
