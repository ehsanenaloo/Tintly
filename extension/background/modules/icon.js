// @ts-check
// The toolbar icon and badge for the state of a tab.

const NORMAL = Object.freeze({ 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
const OFF = Object.freeze({ 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' });

/** What each status looks like. `badge` is the text on the icon. */
export const LOOKS = Object.freeze({
  on: { icon: NORMAL, badge: '', color: '#2f6fed' },
  off: { icon: OFF, badge: '', color: '#6b7280' },
  'site-off': { icon: OFF, badge: '', color: '#6b7280' },
  'dark-detected': { icon: NORMAL, badge: '', color: '#2f6fed' },
  'page-scheme': { icon: NORMAL, badge: '', color: '#2f6fed' },
  'site-theme': { icon: NORMAL, badge: '', color: '#2f6fed' },
  'site-theme-repaired': { icon: NORMAL, badge: '', color: '#2f6fed' },
  fallback: { icon: NORMAL, badge: 'F', color: '#b26a00' },
  pending: { icon: NORMAL, badge: '', color: '#2f6fed' },
  'start-failed': { icon: NORMAL, badge: '!', color: '#b00020' },
  'safe-mode': { icon: NORMAL, badge: '!', color: '#b00020' },
});

/**
 * @param {{ action: { setIcon(d: any): Promise<void>, setBadgeText(d: any): Promise<void>, setBadgeBackgroundColor(d: any): Promise<void> } }} deps
 */
export function createIcon({ action }) {
  return {
    /** @param {number} tabId @param {string} status */
    async apply(tabId, status) {
      const look = LOOKS[/** @type {keyof typeof LOOKS} */ (status)];
      if (!look) return;
      try {
        await action.setIcon({ tabId, path: look.icon });
        await action.setBadgeText({ tabId, text: look.badge });
        if (look.badge) await action.setBadgeBackgroundColor({ tabId, color: look.color });
      } catch {
        // The tab was closed before the icon could be set.
      }
    },
    /** The icon for tabs that have no state of their own: on or off for the whole extension. @param {boolean} enabled */
    async setDefault(enabled) {
      try {
        await action.setIcon({ path: enabled ? NORMAL : OFF });
      } catch {
        // Nothing to do.
      }
    },
  };
}
