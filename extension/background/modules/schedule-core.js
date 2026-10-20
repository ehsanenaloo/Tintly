// @ts-check
// The schedule functions of the page, for the worker. Imports run in order: the shim first, then the page file.
import './schedule-shim.js';
import '../../content/core/schedule.js';

const holder = /** @type {any} */ (globalThis).__dk;
// The worker keeps no namespace of the page: it takes the functions and removes the object.
delete (/** @type {any} */ (globalThis).__dk);

/** @type {{ evaluate(automation: Record<string, any> | undefined, now: Date, systemDark: boolean): { active: boolean | null, behavior: 'onOff' | 'scheme', next: number | null } }} */
export const schedule = holder.schedule;
