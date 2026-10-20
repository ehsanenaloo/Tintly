// @ts-check

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an element. `attrs` keys: `class`, `text`, `on` (event map), `data` (dataset map);
 * `true` sets a bare attribute, `false`, null and undefined skip it. Children may be nodes or text.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | number | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else if (key === 'data') for (const [name, v] of Object.entries(value)) el.dataset[name] = String(v);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
  return el;
}

/*
 * Icons are stroke shapes on a 24 by 24 grid. One entry per shape:
 * ['p', d] path, ['c', cx, cy, r] circle, ['r', x, y, w, h, rx] rectangle, ['l', x1, y1, x2, y2] line.
 */
/** @type {Record<string, Array<Array<string | number>>>} */
const SHAPES = {
  heart: [['p', 'M12 21s-7.5-4.5-9.5-9.5C1.1 8.2 3.2 5 6.5 5c2 0 3.5 1 4.5 2.5 1-1.5 2.5-2.5 4.5-2.5 3.3 0 5.4 3.2 4 6.5C19.5 16.5 12 21 12 21z']],
  more: [['c', 12, 5, 1.6], ['c', 12, 12, 1.6], ['c', 12, 19, 1.6]],
  close: [['p', 'M18 6L6 18M6 6l12 12']],
  check: [['p', 'M20 6L9 17l-5-5']],
  chevron: [['p', 'M6 9l6 6 6-6']],
  moon: [['p', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z']],
  sun: [['c', 12, 12, 4], ['p', 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41']],
  monitor: [['r', 2, 3, 20, 14, 2], ['p', 'M8 21h8M12 17v4']],
  globe: [['c', 12, 12, 10], ['p', 'M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z']],
  info: [['c', 12, 12, 10], ['p', 'M12 16v-4M12 8h.01']],
  tablet: [['r', 5, 2, 14, 20, 2], ['p', 'M9 7h6M9 11h6M9 15h3']],
  book: [['p', 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z']],
  sliders: [['p', 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6']],
  toggle: [['r', 1, 5, 22, 14, 7], ['c', 16, 12, 3]],
  drop: [['p', 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z']],
  clock: [['c', 12, 12, 10], ['p', 'M12 6v6l4 2']],
  code: [['p', 'M16 18l6-6-6-6M8 6l-6 6 6 6']],
  database: [['p', 'M3 5c0 1.66 4 3 9 3s9-1.34 9-3-4-3-9-3-9 1.34-9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5']],
  coffee: [['p', 'M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zM6 1v3M10 1v3M14 1v3']],
  star: [['p', 'M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7L12 2z']],
  branch: [['l', 6, 3, 6, 15], ['c', 18, 6, 3], ['c', 6, 18, 3], ['p', 'M18 9a9 9 0 0 1-9 9']],
  external: [['p', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3']],
  shield: [['p', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']],
  search: [['c', 11, 11, 7], ['p', 'M21 21l-4.35-4.35']],
  pause: [['r', 6, 5, 4, 14, 1], ['r', 14, 5, 4, 14, 1]],
  play: [['p', 'M8 5l11 7-11 7z']],
  wand: [['p', 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 6.2L11 5M3 21l9-9']],
};

/** Heart and star read better filled. */
const FILLED = new Set(['heart', 'star']);

/**
 * An inline SVG icon that follows the text color. Decorative: hidden from screen readers.
 * @param {string} name
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  const filled = FILLED.has(name);
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', filled ? '1.5' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [kind, ...a] of SHAPES[name] ?? []) {
    const shape = document.createElementNS(SVG_NS, { p: 'path', c: 'circle', r: 'rect', l: 'line' }[/** @type {'p'} */ (kind)]);
    if (kind === 'p') shape.setAttribute('d', String(a[0]));
    if (kind === 'c') {
      shape.setAttribute('cx', String(a[0]));
      shape.setAttribute('cy', String(a[1]));
      shape.setAttribute('r', String(a[2]));
    }
    if (kind === 'r') {
      ['x', 'y', 'width', 'height', 'rx'].forEach((n, i) => shape.setAttribute(n, String(a[i])));
    }
    if (kind === 'l') {
      ['x1', 'y1', 'x2', 'y2'].forEach((n, i) => shape.setAttribute(n, String(a[i])));
    }
    svg.append(shape);
  }
  return svg;
}

/** Put an icon at the start of every element that has `data-icon="name"`. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.icon')) continue;
    el.prepend(icon(/** @type {string} */ (el.getAttribute('data-icon')), Number(el.getAttribute('data-icon-size')) || 18));
  }
}

/**
 * Open an address in a new tab. An empty address does nothing.
 * @param {string} url
 */
export function openUrl(url) {
  if (!url) return;
  try {
    void chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
