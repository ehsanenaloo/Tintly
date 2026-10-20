// @ts-check

/** The public repository: where a review goes when the copy has no store page. */
export const REPO_URL = 'https://github.com/ehsanenaloo/Tintly';

/**
 * The address to rate the extension: its review page in its store, or the public repository.
 * A copy loaded from a folder (and a Firefox temporary add-on) has no store page, so it gets the repository.
 * Chrome and Edge: only a store install has `update_url`. Firefox: the add-on id from the manifest.
 * `installType` is the value of `chrome.management.getSelf()`; `development` means an unpacked or temporary copy.
 * @param {{ id: string, manifest: Record<string, any>, userAgent: string, installType?: string }} input
 */
export function storeReviewUrl({ id, manifest, userAgent, installType }) {
  if (typeof id !== 'string' || id === '' || installType === 'development') return REPO_URL;
  if (/firefox/i.test(userAgent)) {
    const gecko = manifest.browser_specific_settings?.gecko?.id;
    return typeof gecko === 'string' && gecko !== '' ? `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(gecko)}/reviews/` : REPO_URL;
  }
  const update = manifest.update_url;
  if (typeof update !== 'string' || update === '') return REPO_URL;
  let host = '';
  try {
    host = new URL(update).hostname;
  } catch {
    return REPO_URL;
  }
  const edge = host.endsWith('microsoft.com') || (!host.endsWith('google.com') && /\bEdg\//.test(userAgent));
  return edge
    ? `https://microsoftedge.microsoft.com/addons/detail/${encodeURIComponent(id)}`
    : `https://chromewebstore.google.com/detail/${encodeURIComponent(id)}/reviews`;
}
