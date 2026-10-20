// @ts-check
// The welcome page after a fresh install and the survey address the browser opens after removal.
import { INSTALLED_AT, ageOf, osOf, thisBrowser, uninstallUrl, welcomeUrl } from '../../shared/site-pages.js';

/**
 * @param {{
 *   runtime: { getManifest(): { version: string }, setUninstallURL?: (url: string) => Promise<void> | void, getPlatformInfo?: () => Promise<{ os: string }> },
 *   local: { get(keys: string): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void> },
 *   tabs: { create(props: { url: string, active: boolean }): Promise<unknown> },
 *   lang: () => string,
 *   now?: () => number,
 *   browser?: { name: string, major: string },
 *   warn?: (error: unknown) => void,
 * }} deps
 */
export function createSitePages({ runtime, local, tabs, lang, now = Date.now, browser = thisBrowser(), warn = () => {} }) {
  const version = () => runtime.getManifest().version;

  /** Only a fresh install opens the page, in a tab behind the current one. @param {string} reason */
  async function installed(reason) {
    if (reason !== 'install') return false;
    const stored = await local.get(INSTALLED_AT);
    if (typeof stored[INSTALLED_AT] === 'number') return false;
    await local.set({ [INSTALLED_AT]: now() });
    await tabs.create({ url: welcomeUrl({ version: version(), lang: lang(), browser: browser.name }), active: false });
    return true;
  }

  /**
   * The browser keeps the address and reads it at the moment of removal. It is set when the extension is installed or
   * updated and when the browser starts, so the age in it is the age at the last of these. A missing or strange install
   * time gives `unknown`.
   */
  async function survey() {
    if (typeof runtime.setUninstallURL !== 'function') return '';
    const [stored, info] = await Promise.all([local.get(INSTALLED_AT).catch(() => ({})), runtime.getPlatformInfo?.().catch(() => null)]);
    const url = uninstallUrl({
      version: version(),
      lang: lang(),
      browser: browser.name,
      major: browser.major,
      os: osOf(info?.os),
      age: ageOf(/** @type {Record<string, unknown>} */ (stored)[INSTALLED_AT], now()),
    });
    await runtime.setUninstallURL(url);
    return url;
  }

  /**
   * The install event: the install time is written first, so the survey address already carries the age. A failure of
   * the first step is reported and does not stop the second. @param {string} reason
   */
  async function onInstall(reason) {
    let opened = false;
    try {
      opened = await installed(reason);
    } catch (error) {
      warn(error);
    }
    const url = await survey();
    return { opened, url };
  }

  return { installed, survey, onInstall };
}
