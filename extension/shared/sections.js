// @ts-check
// The sections of the stored state and the storage keys that hold them. A module of its own, so that a page can read them before the
// larger modules are loaded.

export const SECTIONS = Object.freeze(['settings', 'siteRules', 'presets', 'userFixes', 'darkSites', 'ui']);

export const STATE_KEYS = Object.freeze(['schemaVersion', 'updatedAt', ...SECTIONS]);
