// @ts-check
// Cooperative time slicing: do work in short slices and give the main thread back between them.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /**
   * Give the browser a turn. A message channel puts the continuation at the back of the line, so the parser,
   * timers and input of the page get their turn. `scheduler.yield()` was tried first and is not used: its
   * continuation goes to the front of the line, and a long job then starved the page's own timers.
   */
  function yieldToBrowser() {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve(undefined);
      };
      channel.port2.postMessage(0);
    });
  }

  /**
   * @param {{ softMs?: number, hardMs?: number, now?: () => number, yield?: () => Promise<unknown> }} [options]
   *   `softMs` is where a slice should stop, `hardMs` is where a slice counts as an overrun.
   */
  function createSlicer(options = {}) {
    const baseSoft = options.softMs ?? 6;
    const baseHard = options.hardMs ?? 12;
    let soft = baseSoft;
    let hard = baseHard;
    const clock = options.now ?? (() => performance.now());
    const give = options.yield ?? yieldToBrowser;
    let start = clock();
    // The last time any caller asked the slicer something. A loop that starts after a long silence begins a new slice:
    // the time in between was not ours.
    let touched = start;
    const IDLE_GAP_MS = 4;

    // The slices are also counted by phase, so work done while the page shows its quick dark version (long slices on
    // purpose) is told apart from work done after the engine is ready.
    let phase = 'live';
    /** @type {Record<string, { slices: number, maxMs: number, overruns: number }>} */
    const phases = {};
    const stats = { slices: 0, maxMs: 0, totalMs: 0, overruns: 0, overrunsInARow: 0, maxOverrunsInARow: 0, phases };

    function closeSlice() {
      const spent = clock() - start;
      stats.slices += 1;
      stats.totalMs += spent;
      if (spent > stats.maxMs) stats.maxMs = spent;
      const part = phases[phase] ?? (phases[phase] = { slices: 0, maxMs: 0, overruns: 0 });
      part.slices += 1;
      if (spent > part.maxMs) part.maxMs = spent;
      if (spent > hard) {
        part.overruns += 1;
        stats.overruns += 1;
        stats.overrunsInARow += 1;
        if (stats.overrunsInARow > stats.maxOverrunsInARow) stats.maxOverrunsInARow = stats.overrunsInARow;
      } else {
        stats.overrunsInARow = 0;
      }
    }

    const shouldYield = () => {
      const now = clock();
      touched = now;
      return now - start >= soft;
    };

    /** Longer slices, for a time when the page is not shown anyway. With no arguments the first limits come back. */
    function tune(softMs = baseSoft, hardMs = baseHard) {
      soft = softMs;
      hard = hardMs;
    }

    async function yieldNow() {
      closeSlice();
      await give();
      start = clock();
      touched = start;
    }

    async function maybeYield() {
      if (shouldYield()) await yieldNow();
    }

    return {
      stats,
      shouldYield,
      tune,
      /** Name the phase that the next slices belong to. @param {string} name */
      phase(name) {
        phase = name;
      },
      yieldNow,
      maybeYield,
      /** Count the work done since the last yield as a slice. Call when a task ends. */
      finish: closeSlice,
      /** Start measuring a new slice, for example after waiting for an event. */
      reset() {
        start = clock();
        touched = start;
      },
      /**
       * Run `fn` on each item, yielding when the slice is used up. Stops early when `isStopped()` is true.
       * @template T
       * @param {Iterable<T>} items
       * @param {(item: T) => void} fn
       * @param {() => boolean} [isStopped]
       */
      async forEach(items, fn, isStopped) {
        if (clock() - touched > IDLE_GAP_MS) start = clock();
        for (const item of items) {
          if (isStopped && isStopped()) return;
          fn(item);
          if (shouldYield()) await yieldNow();
        }
      },
    };
  }

  dk.slicer = Object.freeze({ createSlicer });
})();
