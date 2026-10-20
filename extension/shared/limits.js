// @ts-check

/** Every numeric limit of stored and imported data, in one place. */
export const L = Object.freeze({
  IMPORT_BYTES: 1024 * 1024,
  MAX_DEPTH: 8,
  MAX_ERRORS: 50,
  PRESETS: 50,
  SITE_RULES: 2000,
  USER_FIXES: 2000,
  DARK_SITE_ENTRIES: 2000,
  SELECTORS: 200,
  DARK_HINTS: 50,
  URL_PARTS: 50,
  URL_PART_CHARS: 200,
  URL_PART_STARS: 8,
  SELECTOR_CHARS: 200,
  PATTERN_CHARS: 300,
  HOST_CHARS: 253,
  NAME_CHARS: 60,
  ID_CHARS: 40,
  NOTE_CHARS: 200,
  FONT_CHARS: 100,
  TIMESTAMP: Object.freeze({ min: 0, max: 8_640_000_000_000_000 }),
  SHOWN_COUNT: Object.freeze({ min: 0, max: 100_000 }),
  CSS_CHARS: 100_000,
  BRIGHTNESS: Object.freeze({ min: 50, max: 150 }),
  CONTRAST: Object.freeze({ min: 50, max: 150 }),
  SEPIA: Object.freeze({ min: 0, max: 100 }),
  GRAYSCALE: Object.freeze({ min: 0, max: 100 }),
  WARMTH: Object.freeze({ min: 0, max: 100 }),
  // Tenths of a pixel: 0 to 10 means 0 to 1 px.
  TEXT_STROKE: Object.freeze({ min: 0, max: 10 }),
  // The E-ink and Paper mode. Percent, except the weight, which counts steps.
  EINK_CONTRAST: Object.freeze({ min: 50, max: 200 }),
  WHITE_CAP: Object.freeze({ min: 50, max: 100 }),
  EINK_BLUE: Object.freeze({ min: 0, max: 100 }),
  EINK_COLOR: Object.freeze({ min: 0, max: 100 }),
  IMAGE_CONTRAST: Object.freeze({ min: 50, max: 200 }),
  EINK_WEIGHT: Object.freeze({ min: 0, max: 3 }),
  // The numbers of gray levels the mode can use; 0 means no rounding.
  EINK_LEVELS: Object.freeze([0, 2, 4, 8, 16]),
  // Percent of a full deficiency the correction for color vision is made for.
  CVD_SEVERITY: Object.freeze({ min: 0, max: 100 }),
  // How far the correction moves colors; 50 is the middle.
  CVD_BOOST: Object.freeze({ min: 0, max: 100 }),
});

/** Limits of `storage.sync`. The chunk budget leaves room for the key name. */
export const SYNC = Object.freeze({
  PREFIX: 'dk.sync.',
  ITEM_BYTES: 8192,
  TOTAL_BYTES: 102_400,
  MAX_ITEMS: 512,
  KEY_RESERVE: 64,
});
