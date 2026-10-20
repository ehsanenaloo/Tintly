// @ts-check
// Alarms for the schedule. With the optional `alarms` permission the worker follows the hours or the sun times: outside the
// active time the engine is not registered, so a page that is off loads nothing of ours. The browser keeps the alarms while the worker
// sleeps and wakes it when one is due. Without the permission nothing here runs and the page decides, as before.
import { schedule } from './schedule-core.js';

export const NEXT = 'dk-schedule-next';
export const CHECK = 'dk-schedule-check';
/** The push of the settings to the account that waits for its time (sync.js). It wakes a worker that was stopped meanwhile. */
export const SYNC_RETRY = 'dk-sync-retry';
/** The shortest wait the browsers give an alarm (Chrome: 30 seconds). */
export const MIN_ALARM_MS = 30_000;
/** The registration comes back this long before the active time starts, so a late alarm still leaves the first page covered. */
export const LEAD_MS = 60_000;
/** The registration goes this long after the active time ends. A stale registration after the end only loads files the page keeps off. */
export const SETTLE_MS = 2_000;
/** A pass at this rate catches what no event tells the worker: a changed clock, a moved time zone, a laptop that slept through an alarm. */
export const CHECK_MINUTES = 30;

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Can this schedule take the engine away from pages? Only hours and sun times that turn Tintly on and off can. The system scheme
 * is known to the page alone, and a schedule that switches the mode keeps Tintly on in both states.
 * @param {any} automation
 */
export function usesClock(automation) {
  return isObject(automation) && (automation.mode === 'time' || automation.mode === 'location') && automation.behavior !== 'scheme';
}

/** The parts of the schedule that decide the answer. @param {any} automation */
const keyOf = (automation) =>
  JSON.stringify([automation.mode, automation.time?.from, automation.time?.to, automation.location?.lat, automation.location?.lon]);

/**
 * What the registration should do at this moment and when to look again.
 * `idle`: Tintly is off now and does not start within LEAD_MS, so no page needs the engine. `at`: the time of the next pass, or null.
 * The answer comes from the same functions as the page's gate, in local time (daylight saving included).
 * @param {any} automation @param {number} now
 * @returns {{ idle: boolean, at: number | null }}
 */
export function outlook(automation, now) {
  if (!usesClock(automation)) return { idle: false, at: null };
  const answer = schedule.evaluate(automation, new Date(now), false);
  // No coordinates: the gate has no schedule to follow.
  if (answer.active === null) return { idle: false, at: null };
  if (answer.active) return { idle: false, at: answer.next === null ? null : answer.next + SETTLE_MS };
  if (answer.next === null) return { idle: true, at: null };
  if (answer.next - now > LEAD_MS) return { idle: true, at: answer.next - LEAD_MS };
  return { idle: false, at: answer.next + SETTLE_MS };
}

/**
 * @typedef {object} AlarmsApi
 * @property {(name: string, info: { when?: number, delayInMinutes?: number, periodInMinutes?: number }) => Promise<void> | void} create
 * @property {(name: string) => Promise<{ periodInMinutes?: number } | undefined>} get
 * @property {(name: string) => Promise<boolean>} clear
 */

/**
 * @param {{ api: () => AlarmsApi | undefined, permissions: { contains(d: any): Promise<boolean> }, now?: () => number, warn?: (e: unknown) => void }} deps
 */
export function createAlarms({ api, permissions, now = () => Date.now(), warn = () => {} }) {
  /** What the alarms stand for: the key of the schedule, or '' when none are set. */
  let armed = '';
  /** What the last pass looked at, to skip a pass when a slider drag writes the settings again. Null before the first pass. */
  let seen = /** @type {string | null} */ (null);

  /** @param {AlarmsApi} a */
  async function clearAll(a) {
    try {
      await a.clear(NEXT);
      await a.clear(CHECK);
    } catch {
      // The permission was taken away while we worked.
    }
  }

  async function granted() {
    try {
      return await permissions.contains({ permissions: ['alarms'] });
    } catch {
      return false;
    }
  }

  return {
    /**
     * The alarm of the waiting Sync push. Set only when the `alarms` permission is there; it is not part of the schedule, so a pass over the
     * schedule leaves it alone. Both calls resolve to whether the alarm was set or removed.
     */
    retry: {
      /** @param {number} when time of the push; an earlier time than the browsers allow is moved to the earliest one */
      async set(when) {
        const a = api();
        if (!a || !(await granted())) return false;
        try {
          await a.create(SYNC_RETRY, { when: Math.max(when, now() + MIN_ALARM_MS) });
          return true;
        } catch (error) {
          warn(error);
          return false;
        }
      },
      async clear() {
        const a = api();
        if (!a) return false;
        try {
          return await a.clear(SYNC_RETRY);
        } catch {
          // The permission was taken away while we worked: the browser dropped the alarm.
          return false;
        }
      },
    },
    /** Are the alarms set for a schedule? */
    get armed() {
      return armed !== '';
    },
    /**
     * Bring the alarms to the settings: set them for an hours or sun schedule when the permission is there, remove them otherwise.
     * Resolves to true when they are set. @param {any} settings @param {boolean} [force] set them again also when nothing changed (an alarm fired, a permission changed)
     */
    async sync(settings, force = false) {
      const automation = settings?.automation;
      const wanted = isObject(settings) && settings.enabled !== false && usesClock(automation);
      const signature = wanted ? keyOf(automation) : '';
      if (!force && seen === signature && armed === signature) return armed !== '';
      seen = signature;
      const a = api();
      if (!wanted || !a || !(await granted())) {
        armed = '';
        if (a) await clearAll(a);
        return false;
      }
      const t = now();
      const { at } = outlook(automation, t);
      try {
        if (at === null) await a.clear(NEXT);
        else await a.create(NEXT, { when: Math.max(at, t + 1000) });
        const have = await a.get(CHECK);
        if (!have || have.periodInMinutes !== CHECK_MINUTES) await a.create(CHECK, { delayInMinutes: CHECK_MINUTES, periodInMinutes: CHECK_MINUTES });
        armed = signature;
        return true;
      } catch (error) {
        armed = '';
        seen = null;
        warn(error);
        return false;
      }
    },
    /**
     * Is the engine unneeded right now? True only while the alarms stand for this schedule and the answer holds, so a page never
     * loses its script on the word of a timer that does not exist. @param {any} settings
     */
    idleFor(settings) {
      if (armed === '' || !isObject(settings) || settings.enabled === false || !usesClock(settings.automation)) return false;
      if (keyOf(settings.automation) !== armed) return false;
      return outlook(settings.automation, now()).idle;
    },
  };
}
