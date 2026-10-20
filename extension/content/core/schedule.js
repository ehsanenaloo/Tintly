// @ts-check
// Automation: active hours, sunset to sunrise at a place, and the system scheme. Pure functions of the clock and the
// settings; the gate decides what to do with the answer and sets the timer for the next change.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;
  const RAD = Math.PI / 180;
  const ZENITH = 90.833;
  // How long a polar day or night is trusted before the answer is checked again.
  const POLAR_RECHECK = 6 * 60 * MINUTE;

  /** @param {unknown} text @returns {number | null} minutes after midnight */
  function parseTime(text) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  /** Is the clock inside the window? It may cross midnight. An empty window (same start and end) is never active. */
  function inWindow(/** @type {number} */ nowMinutes, /** @type {string} */ from, /** @type {string} */ to) {
    const a = parseTime(from);
    const b = parseTime(to);
    if (a === null || b === null || a === b) return false;
    return a < b ? nowMinutes >= a && nowMinutes < b : nowMinutes >= a || nowMinutes < b;
  }

  /** The next time the clock reaches `from` or `to`, as a timestamp. Uses local calendar arithmetic, so a change of daylight saving is followed. */
  function nextWindowChange(/** @type {Date} */ now, /** @type {string} */ from, /** @type {string} */ to) {
    const marks = [parseTime(from), parseTime(to)].filter((v) => v !== null);
    if (marks.length < 2) return null;
    let best = Infinity;
    for (const day of [0, 1]) {
      for (const minutes of /** @type {number[]} */ (marks)) {
        const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
        if (t > now.getTime() && t < best) best = t;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  /**
   * Sunrise and sunset of one UTC day at a place, with the NOAA solar position formulas.
   * @param {number} dayStart  timestamp of 00:00 UTC of the day
   * @returns {{ sunrise: number, sunset: number } | { polar: 'day' | 'night' }}
   */
  function sunOfDay(dayStart, /** @type {number} */ lat, /** @type {number} */ lon) {
    const jd = dayStart / DAY + 2440587.5 + 0.5;
    const jc = (jd - 2451545) / 36525;
    const l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
    const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    const sinM = Math.sin(m * RAD);
    const center = sinM * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * jc) + Math.sin(3 * m * RAD) * 0.000289;
    const trueLong = l0 + center;
    const omega = 125.04 - 1934.136 * jc;
    const apparent = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const meanObliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
    const obliq = meanObliq + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(apparent * RAD));
    const y = Math.tan((obliq * RAD) / 2) ** 2;
    const eqTime =
      4 *
      (y * Math.sin(2 * l0 * RAD) - 2 * e * sinM + 4 * e * y * sinM * Math.cos(2 * l0 * RAD) - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m * RAD)) /
      RAD;
    const cosH = Math.cos(ZENITH * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
    if (cosH > 1) return { polar: 'night' };
    if (cosH < -1) return { polar: 'day' };
    const hourAngle = Math.acos(cosH) / RAD;
    const noon = 720 - 4 * lon - eqTime;
    return { sunrise: dayStart + (noon - 4 * hourAngle) * MINUTE, sunset: dayStart + (noon + 4 * hourAngle) * MINUTE };
  }

  /**
   * Is it night at this place, and when does that change?
   * @param {number} now  timestamp
   * @returns {{ night: boolean, next: number }}
   */
  function nightAt(now, /** @type {number} */ lat, /** @type {number} */ lon) {
    const today = Math.floor(now / DAY) * DAY;
    /** @type {{ at: number, night: boolean }[]} */
    const events = [];
    /** @type {'day' | 'night' | null} */
    let polarToday = null;
    for (let d = -1; d <= 2; d++) {
      const sun = sunOfDay(today + d * DAY, lat, lon);
      if ('polar' in sun) {
        if (d === 0) polarToday = sun.polar;
      } else {
        events.push({ at: sun.sunrise, night: false }, { at: sun.sunset, night: true });
      }
    }
    events.sort((a, b) => a.at - b.at);
    if (polarToday) return { night: polarToday === 'night', next: now + POLAR_RECHECK };
    let night = false;
    for (const ev of events) if (ev.at <= now) night = ev.night;
    const upcoming = events.find((ev) => ev.at > now);
    return { night, next: upcoming ? upcoming.at : now + POLAR_RECHECK };
  }

  /**
   * What the automation settings say right now.
   * `active` true means "use the dark side" (on, or the dark scheme); `null` means there is no automation.
   * @param {Record<string, any> | undefined} automation  `settings.automation`
   * @param {Date} now
   * @param {boolean} systemDark
   * @returns {{ active: boolean | null, behavior: 'onOff' | 'scheme', next: number | null }}
   */
  function evaluate(automation, now, systemDark) {
    const behavior = automation && automation.behavior === 'scheme' ? 'scheme' : 'onOff';
    const mode = automation ? automation.mode : 'none';
    if (mode === 'time' && automation) {
      const t = automation.time ?? {};
      const minutes = now.getHours() * 60 + now.getMinutes();
      return { active: inWindow(minutes, t.from, t.to), behavior, next: nextWindowChange(now, t.from, t.to) };
    }
    if (mode === 'system') return { active: systemDark, behavior, next: null };
    if (mode === 'location' && automation) {
      const { lat, lon } = automation.location ?? {};
      if (typeof lat !== 'number' || typeof lon !== 'number') return { active: null, behavior, next: null };
      const r = nightAt(now.getTime(), lat, lon);
      return { active: r.night, behavior, next: r.next };
    }
    return { active: null, behavior, next: null };
  }

  dk.schedule = Object.freeze({ inWindow, nextWindowChange, sunOfDay, nightAt, evaluate });
})();
