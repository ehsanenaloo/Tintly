// @ts-check

/**
 * The number format of a page. Digits are Latin in every language: the browser draws the digits of number and time fields
 * by its own rules, and a page that mixes the two kinds of digits looks broken.
 * @param {string} [locale]
 */
export function numberFormat(locale) {
  try {
    return new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  } catch {
    return new Intl.NumberFormat();
  }
}
