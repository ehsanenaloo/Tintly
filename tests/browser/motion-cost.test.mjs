// Calm motion must not make every style change on the page more expensive. A duration on every element starts a
// transition for every changed property of every element; the E-ink and Paper mode ends the transitions that the page
// declares and gives the others nothing.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;

before(async () => {
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});
afterEach(async () => {
  for (const page of browser.context.pages()) await page.close().catch(() => {});
});

const EINK = { mode: 'eink', einkPreset: 'eink' };
const PAPER = { mode: 'eink', einkPreset: 'paper' };

async function open(path, theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000);
  // The motion style and the handler come with the on-demand module of the mode.
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
  return page;
}

/** Stop the fixture's own loop and give the page a quiet frame. */
const quiet = (page) => page.evaluate(() => new Promise((r) => { window.stopChurn(); setTimeout(r, 200); }));

test('E-ink gives no transition duration to an element that has none, so its style changes start nothing', { timeout: 60000 }, async () => {
  const page = await open('/eink-churn.html', EINK);
  await quiet(page);
  const got = await page.evaluate(async () => {
    const plain = [...document.querySelectorAll('.cell:not(.declared)')][3];
    const before = getComputedStyle(plain).transitionDuration;
    plain.style.color = 'rgb(1, 2, 3)';
    plain.style.transform = 'translateX(4px)';
    plain.style.backgroundColor = 'rgb(5, 6, 7)';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { before, running: plain.getAnimations().length };
  });
  assert.equal(got.before, '0s');
  assert.equal(got.running, 0);
});

test('E-ink ends a transition that the page declares at once and still sends transitionend', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  const got = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.getElementById('slide');
        const started = performance.now();
        el.addEventListener('transitionend', () => resolve({ ended: performance.now() - started, width: getComputedStyle(el).width }), { once: true });
        el.classList.add('wide');
        setTimeout(() => resolve({ ended: -1, width: getComputedStyle(el).width }), 3000);
      }),
  );
  // The page asked for four seconds.
  assert.ok(got.ended > 0 && got.ended < 1000, `transitionend after ${got.ended} ms`);
  assert.equal(got.width, '300px');
});

test('E-ink ends thousands of transitions that start at once in one short task', { timeout: 90000 }, async () => {
  const page = await open('/eink-many-transitions.html', EINK);
  const got = await page.evaluate(async () => {
    /** @type {number[]} */
    const long = [];
    const watch = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) long.push(e.duration);
    });
    watch.observe({ type: 'longtask' });
    window.flip();
    await new Promise((r) => setTimeout(r, 1500));
    watch.disconnect();
    const running = document.getAnimations().filter((a) => typeof a.transitionProperty === 'string' && a.playState === 'running').length;
    return { longest: Math.round(Math.max(0, ...long)), running, padding: getComputedStyle(document.querySelector('.card')).paddingTop };
  });
  // Asked one element at a time, the browser looked through every running transition for each element: seconds here.
  assert.ok(got.longest < 1000, `longest task ${got.longest} ms`);
  assert.equal(got.running, 0);
  assert.equal(got.padding, '5px');
});

test('Paper keeps the transitions of the page', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', PAPER);
  const width = await page.evaluate(async () => {
    document.getElementById('slide').classList.add('wide');
    await new Promise((r) => setTimeout(r, 300));
    return getComputedStyle(document.getElementById('slide')).width;
  });
  assert.notEqual(width, '300px');
  assert.notEqual(width, '100px');
});

test('a switch from E-ink back to Dark leaves no handler and no style behind', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  await page.waitForFunction(() => !document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
  const width = await page.evaluate(async () => {
    document.getElementById('slide').classList.add('wide');
    await new Promise((r) => setTimeout(r, 300));
    return getComputedStyle(document.getElementById('slide')).width;
  });
  assert.notEqual(width, '300px', 'the page transition runs again in Dark');
});

test('E-ink ends a transition of a pseudo-element at once and still sends transitionend', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  const got = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const style = document.createElement('style');
        style.textContent = '#slide::before{content:"";display:block;width:10px;height:10px;background:#888;transition:width 4s linear}#slide.wide::before{width:200px}';
        document.head.append(style);
        const el = document.getElementById('slide');
        const started = performance.now();
        const log = [];
        window.__log = log;
        addEventListener('transitionrun', (e) => log.push('run ' + e.propertyName + e.pseudoElement), true);
        el.addEventListener('transitionend', (e) => {
          log.push('end ' + e.propertyName + e.pseudoElement);
          if (e.pseudoElement === '::before') resolve({ ended: performance.now() - started, width: getComputedStyle(el, '::before').width });
        });
        getComputedStyle(el, '::before').width;
        requestAnimationFrame(() => el.classList.add('wide'));
        setTimeout(() => resolve({ ended: -1, width: getComputedStyle(el, '::before').width }), 3000);
      }),
  );
  assert.ok(got.ended > 0 && got.ended < 1000, `transitionend after ${got.ended} ms, width ${got.width} ${JSON.stringify(await page.evaluate(() => window.__log))}`);
  assert.equal(got.width, '200px');
});

test('E-ink ends every transition of a burst, and leaves an animation of the page that is not a transition alone', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  const got = await page.evaluate(async () => {
    const style = document.createElement('style');
    style.textContent = '.b{width:10px;height:6px;transition:width 5s linear}.b.on{width:80px}';
    document.head.append(style);
    const host = document.createElement('div');
    for (let i = 0; i < 300; i++) {
      const d = document.createElement('i');
      d.className = 'b';
      host.append(d);
    }
    document.body.append(host);
    const own = host.children[0].animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 1e9 });
    getComputedStyle(host).height;
    await new Promise((r) => requestAnimationFrame(r));
    let ended = 0;
    host.addEventListener('transitionend', () => (ended += 1));
    const started = performance.now();
    for (const d of host.children) d.classList.add('on');
    await new Promise((r) => setTimeout(r, 1500));
    return { ended, ms: performance.now() - started, running: own.playState, wide: [...host.children].every((d) => getComputedStyle(d).width === '80px') };
  });
  assert.equal(got.ended, 300);
  assert.equal(got.wide, true);
  assert.equal(got.running, 'running');
});
