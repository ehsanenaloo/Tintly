// @ts-check
// Pages where the browser itself keeps every extension out: the stores of extensions. No script or style of an extension
// reaches them, so the popup says so.

/** @param {string | undefined} url */
export function browserBlocks(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname;
    return (
      host === 'chromewebstore.google.com' ||
      (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) ||
      (host === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) ||
      host === 'addons.mozilla.org'
    );
  } catch {
    return false;
  }
}
