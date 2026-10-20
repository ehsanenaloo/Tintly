// Positive signals that the gate of a page has decided. A test that claims "nothing was done" must wait for one of these
// first: without it, a content script that never ran passes the same assertion.

/**
 * The status the page reported to the worker (`on`, `off`, `site-off`, `dark-detected`, `page-scheme`, ...). Waits for
 * a report, and with `want` (a list) for one of those values. Throws when none comes in time.
 * @param {{ worker: { evaluate: Function } }} browser
 * @param {string} url  address of the open tab; a fragment is ignored
 * @param {{ want?: string[], timeout?: number }} [options]
 * @returns {Promise<string>}
 */
export async function pageStatus(browser, url, { want, timeout = 15000 } = {}) {
  const found = await browser.worker.evaluate(
    async ({ u, wanted, ms }) => {
      const end = Date.now() + ms;
      let last = null;
      while (Date.now() < end) {
        const [tab] = await chrome.tabs.query({ url: u });
        if (tab?.id !== undefined) {
          const key = `tab:${tab.id}`;
          last = (await chrome.storage.session.get(key))[key]?.status ?? null;
          if (last !== null && (!wanted || wanted.includes(last))) return { ok: true, status: last };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false, status: last };
    },
    { u: url.split('#')[0], wanted: want ?? null, ms: timeout },
  );
  if (!found.ok) throw new Error(`the page ${url} did not report ${want ? want.join(' or ') : 'a status'} (last: ${found.status})`);
  return found.status;
}

/**
 * Wait until the engine files have started in every frame of the tab (the isolated world has `bootStarted`), then
 * return how many frames that is. Only the top frame reports a status; this is the signal for the others.
 * @param {{ worker: { evaluate: Function } }} browser
 * @param {string} url
 * @param {{ timeout?: number, minimum?: number }} [options]  `minimum`: fewest frames that must have started
 * @returns {Promise<number>}
 */
export async function framesStarted(browser, url, { timeout = 15000, minimum = 2 } = {}) {
  const result = await browser.worker.evaluate(
    async ({ u, ms, min }) => {
      const end = Date.now() + ms;
      let seen = [];
      while (Date.now() < end) {
        const [tab] = await chrome.tabs.query({ url: u });
        if (tab?.id !== undefined) {
          try {
            seen = (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'ISOLATED', func: () => globalThis.__dk?.bootStarted === true })).map((r) => r.result === true);
          } catch {
            seen = [];
          }
          if (seen.length >= min && seen.every(Boolean)) return { ok: true, count: seen.length };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false, count: seen.length, started: seen.filter(Boolean).length };
    },
    { u: url.split('#')[0], ms: timeout, min: minimum },
  );
  if (!result.ok) throw new Error(`the engine started in ${result.started ?? 0} of ${result.count} frames of ${url}`);
  return result.count;
}

/**
 * Wait until dark-page detection has run at least once in the frame whose address contains `part` (the detect module
 * counts its probes). That is the signal that the decision of that frame has been made, so a later "left alone" is a
 * verdict and not a frame the engine never reached.
 * @param {{ worker: { evaluate: Function } }} browser
 * @param {string} url  address of the tab
 * @param {string} part  part of the address of the frame
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<number>}  the probe count
 */
export async function frameProbed(browser, url, part, { timeout = 15000 } = {}) {
  const result = await browser.worker.evaluate(
    async ({ u, p, ms }) => {
      const end = Date.now() + ms;
      let seen = [];
      while (Date.now() < end) {
        const [tab] = await chrome.tabs.query({ url: u });
        if (tab?.id !== undefined) {
          try {
            seen = (await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'ISOLATED', func: () => ({ href: location.href, probes: globalThis.__dk?.detect?.stats().probes ?? 0 }) })).map((r) => r.result);
          } catch {
            seen = [];
          }
          const hit = seen.find((s) => s?.href.includes(p) && s.probes >= 1);
          if (hit) return { ok: true, probes: hit.probes };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok: false, frames: seen.map((s) => `${s?.href}:${s?.probes}`) };
    },
    { u: url.split('#')[0], p: part, ms: timeout },
  );
  if (!result.ok) throw new Error(`detection did not run in the frame "${part}" of ${url} (${result.frames.join(', ')})`);
  return result.probes;
}
