export const GECKO_ID = 'tintly@enaloo.com';
export const GECKO_MIN_VERSION = '128.0';

const KNOWN_KEYS = new Set([
  'manifest_version',
  'name',
  'short_name',
  'version',
  'description',
  'default_locale',
  'minimum_chrome_version',
  'icons',
  'action',
  'options_ui',
  'background',
  'permissions',
  'optional_permissions',
  'host_permissions',
  'content_scripts',
  'commands',
  'content_security_policy',
  'key',
]);

const CHROME_ONLY_OPTIONAL = new Set(['fontSettings']);
// Firefox lists these as permissions of no prompt, and does not take them as optional ones.
const FIREFOX_REQUIRED = new Map([
  ['contextMenus', 'menus'],
  ['alarms', 'alarms'],
]);
const FIREFOX_ONLY_OPTIONAL = [];

/** Turn the Chrome manifest into the Firefox manifest. Unknown keys stop the build. */
export function toFirefoxManifest(source) {
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`firefox-manifest: unknown manifest key "${key}"`);
  }
  const out = structuredClone(source);
  delete out.key;
  delete out.minimum_chrome_version;

  const worker = out.background?.service_worker;
  if (!worker) throw new Error('firefox-manifest: background.service_worker is missing');
  out.background = { scripts: [worker], type: out.background.type ?? 'module' };

  if (out.optional_permissions) {
    // Firefox calls the context menu permission `menus` and does not accept it, or `alarms`, as an optional one (it drops them with a
    // warning). Both are quiet permissions with no install prompt, so the Firefox build has them from the start.
    const kept = out.optional_permissions.filter((p) => !CHROME_ONLY_OPTIONAL.has(p) && !FIREFOX_REQUIRED.has(p));
    for (const [chromeName, firefoxName] of FIREFOX_REQUIRED) {
      if (out.optional_permissions.includes(chromeName)) out.permissions = [...(out.permissions ?? []), firefoxName];
    }
    const merged = [...kept, ...FIREFOX_ONLY_OPTIONAL];
    if (merged.length) out.optional_permissions = merged;
    else delete out.optional_permissions;
  }

  out.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: {
      strict_min_version: GECKO_MIN_VERSION,
    },
  };
  return out;
}
