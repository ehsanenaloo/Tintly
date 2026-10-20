import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const css = readFileSync(join(REPO, 'extension', 'shared', 'ui.css'), 'utf8');

/** The custom properties declared in the first block that starts with `selector`. */
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no block ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
}

const light = tokens(':root');
const dark = { ...light, ...tokens(':root[data-theme="dark"]') };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** [foreground token, background token, minimum ratio, what it is] */
const PAIRS = [
  ['ink', 'surface', 4.5, 'body text on a card'],
  ['ink', 'bg', 4.5, 'body text on the page'],
  ['ink-2', 'surface', 4.5, 'secondary text on a card'],
  ['ink-2', 'surface-2', 4.5, 'secondary text on a tinted area'],
  ['ink-3', 'surface', 4.5, 'hint text on a card'],
  ['ink-3', 'surface-2', 4.5, 'hint text on a tinted area'],
  ['ink-3', 'bg', 4.5, 'hint text on the page'],
  ['accent', 'surface', 4.5, 'link text on a card'],
  ['accent', 'bg', 4.5, 'link text on the page'],
  ['accent-strong', 'accent-soft', 4.5, 'selected tab text'],
  ['on-accent', 'accent', 4.5, 'primary button text'],
  ['on-accent', 'accent-strong', 4.5, 'primary button text on hover'],
  ['ok', 'surface', 4.5, 'status text'],
  ['warn', 'surface', 4.5, 'warning text'],
  ['danger', 'surface', 4.5, 'error text'],
  ['control-line', 'surface', 3, 'input border'],
  ['control-line', 'bg', 3, 'input border on the page'],
  ['track', 'surface', 3, 'switch and slider track'],
  ['knob', 'track', 3, 'switch knob on an off track'],
  ['knob', 'accent', 3, 'switch knob on an on track'],
  ['accent', 'surface', 3, 'focus ring and slider thumb'],
  ['accent', 'bg', 3, 'focus ring on the page'],
  ['heart', 'surface', 3, 'heart icon'],
];

for (const [name, set] of [['light', light], ['dark', dark]]) {
  test(`the ${name} tokens meet the contrast floors`, () => {
    for (const [fg, bg, min, what] of PAIRS) {
      assert.ok(set[fg] && set[bg], `missing token ${fg} or ${bg}`);
      const r = ratio(set[fg], set[bg]);
      assert.ok(r >= min, `${name}: ${what} (${fg} on ${bg}) is ${r.toFixed(2)}, needs ${min}`);
    }
  });
}

test('the dark tokens in the system-dark block match the forced dark block', () => {
  const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const start = media.indexOf(':root:not([data-theme="light"]) {');
  const body = media.slice(start, media.indexOf('\n  }', start));
  const system = Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  const forced = tokens(':root[data-theme="dark"]');
  for (const [key, value] of Object.entries(forced)) assert.equal(system[key], value, `--${key} differs`);
});
