// @ts-check
// Named color palettes for the dark and the light mode. A palette is a background and a text color. Choosing one writes
// them into the theme fields `darkBackground` and `darkText` (or `lightBackground` and `lightText`) and its id into
// `colorSchemeDark` (or `colorSchemeLight`). The id is a label for the person: what the page shows always comes from the
// color fields, and the settings page works out the palette from those fields. No palette has a tint of its own: the
// engine already takes the hue of the two colors.

export const CUSTOM = 'Custom';

/** @typedef {{ id: string, background: string, text: string }} Palette */

/** @type {readonly Palette[]} */
export const DARK_PALETTES = Object.freeze([
  Object.freeze({ id: 'Default', background: '#16181d', text: '#e6e8eb' }),
  Object.freeze({ id: 'Graphite', background: '#202225', text: '#e1e2e4' }),
  Object.freeze({ id: 'AMOLED', background: '#000000', text: '#e8e8e8' }),
  Object.freeze({ id: 'Midnight', background: '#0b1426', text: '#dbe5f4' }),
  Object.freeze({ id: 'Solarized', background: '#002b36', text: '#93a1a1' }),
  Object.freeze({ id: 'Nord', background: '#2e3440', text: '#d8dee9' }),
  Object.freeze({ id: 'Gruvbox', background: '#282828', text: '#ebdbb2' }),
]);

/** @type {readonly Palette[]} */
export const LIGHT_PALETTES = Object.freeze([
  Object.freeze({ id: 'Default', background: '#eeece8', text: '#1a1c20' }),
  Object.freeze({ id: 'WarmPaper', background: '#f4ecd8', text: '#3a2e20' }),
  Object.freeze({ id: 'CoolGray', background: '#e8ecf1', text: '#1b222b' }),
  Object.freeze({ id: 'HighContrast', background: '#ffffff', text: '#000000' }),
]);

/** The ids a settings field may hold. */
export const DARK_IDS = Object.freeze([...DARK_PALETTES.map((p) => p.id), CUSTOM]);
export const LIGHT_IDS = Object.freeze([...LIGHT_PALETTES.map((p) => p.id), CUSTOM]);

/** @param {'dark' | 'light'} kind */
export const palettesFor = (kind) => (kind === 'dark' ? DARK_PALETTES : LIGHT_PALETTES);

/**
 * The palette whose two colors these are, or Custom.
 * @param {'dark' | 'light'} kind
 * @param {unknown} background
 * @param {unknown} text
 */
export function paletteIdFor(kind, background, text) {
  const bg = typeof background === 'string' ? background.toLowerCase() : '';
  const fg = typeof text === 'string' ? text.toLowerCase() : '';
  return palettesFor(kind).find((p) => p.background === bg && p.text === fg)?.id ?? CUSTOM;
}

/**
 * The theme fields that choosing a palette writes, or null for an id that is not one (Custom changes no color).
 * @param {'dark' | 'light'} kind
 * @param {string} id
 * @returns {Record<string, string> | null}
 */
export function paletteFields(kind, id) {
  const p = palettesFor(kind).find((x) => x.id === id);
  if (!p) return null;
  return kind === 'dark'
    ? { darkBackground: p.background, darkText: p.text, colorSchemeDark: p.id }
    : { lightBackground: p.background, lightText: p.text, colorSchemeLight: p.id };
}

/**
 * The id fields that belong to the colors of a theme (or a part of one), for the kinds whose two colors are both present.
 * Used when a color is edited by hand, and to bring data from before the palettes in line.
 * @param {Record<string, any>} theme
 * @returns {Record<string, string>}
 */
export function paletteLabels(theme) {
  /** @type {Record<string, string>} */
  const out = {};
  if (theme && theme.darkBackground !== undefined && theme.darkText !== undefined) out.colorSchemeDark = paletteIdFor('dark', theme.darkBackground, theme.darkText);
  if (theme && theme.lightBackground !== undefined && theme.lightText !== undefined) out.colorSchemeLight = paletteIdFor('light', theme.lightBackground, theme.lightText);
  return out;
}
