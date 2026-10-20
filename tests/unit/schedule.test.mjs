import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('core/schedule.js');
const S = dk.schedule;
const MIN = 60000;
const DAY = 86400000;

/** An independent method (the Almanac for Computers algorithm) to compare the sun times with. Returns minutes of UTC day, 0 to 1440. */
function almanac(year, month, day, lat, lon, rising) {
  const rad = Math.PI / 180;
  const n1 = Math.floor((275 * month) / 9);
  const n2 = Math.floor((month + 9) / 12);
  const n3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
  const N = n1 - n2 * n3 + day - 30;
  const lngHour = lon / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
  RA /= 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let UT = (T - lngHour) % 24;
  if (UT < 0) UT += 24;
  return UT * 60;
}

const PLACES = {
  London: [51.5, -0.12],
  'New York': [40.71, -74.0],
  Tokyo: [35.68, 139.69],
  Sydney: [-33.87, 151.21],
  Tehran: [35.69, 51.39],
  'Cape Town': [-33.92, 18.42],
  Singapore: [1.35, 103.82],
  'Sao Paulo': [-23.55, -46.63],
  Cairo: [30.04, 31.24],
  Moscow: [55.75, 37.62],
};
const DATES = [[2025, 3, 20], [2025, 6, 21], [2025, 9, 22], [2025, 12, 21]];

const wrap = (m) => ((((m + 720) % 1440) + 1440) % 1440) - 720;

test('sunrise and sunset agree with an independent method within 3 minutes at 10 places in 4 seasons', () => {
  let worst = 0;
  for (const [name, [lat, lon]] of Object.entries(PLACES)) {
    for (const [y, m, d] of DATES) {
      const start = Date.UTC(y, m - 1, d);
      const sun = S.sunOfDay(start, lat, lon);
      for (const [key, rising] of [['sunrise', true], ['sunset', false]]) {
        const ours = (sun[key] - start) / MIN;
        const theirs = almanac(y, m, d, lat, lon, rising);
        const diff = Math.abs(wrap(ours - theirs));
        worst = Math.max(worst, diff);
        assert.ok(diff <= 3, `${name} ${y}-${m}-${d} ${key}: ${diff.toFixed(2)} min`);
      }
    }
  }
  console.log(`# sun times: worst difference to the second method ${worst.toFixed(2)} min over 80 values`);
});

test('polar day and polar night are found, and the answer is rechecked later', () => {
  const june = Date.UTC(2025, 5, 21, 12);
  const dec = Date.UTC(2025, 11, 21, 12);
  assert.deepEqual(S.sunOfDay(Math.floor(june / DAY) * DAY, 78.2, 15.6), { polar: 'day' });
  assert.deepEqual(S.sunOfDay(Math.floor(dec / DAY) * DAY, 78.2, 15.6), { polar: 'night' });
  assert.equal(S.nightAt(june, 78.2, 15.6).night, false);
  assert.equal(S.nightAt(dec, 78.2, 15.6).night, true);
  assert.ok(S.nightAt(dec, 78.2, 15.6).next > dec);
  // The south pole mirrors it.
  assert.equal(S.nightAt(june, -80, 0).night, true);
  assert.equal(S.nightAt(dec, -80, 0).night, false);
});

test('night is true between sunset and sunrise and the next change is the right event', () => {
  const [lat, lon] = PLACES.London;
  const day = Date.UTC(2025, 5, 21);
  const sun = S.sunOfDay(day, lat, lon);
  const noon = day + 12 * 60 * MIN;
  assert.equal(S.nightAt(noon, lat, lon).night, false);
  assert.equal(Math.round((S.nightAt(noon, lat, lon).next - sun.sunset) / MIN), 0);
  assert.equal(S.nightAt(sun.sunset + MIN, lat, lon).night, true);
  assert.equal(S.nightAt(sun.sunrise - MIN, lat, lon).night, true);
  assert.equal(S.nightAt(sun.sunrise + MIN, lat, lon).night, false);
  // The longitude of Auckland: the local evening falls on the previous UTC day.
  for (let h = 0; h < 48; h++) {
    const at = Date.UTC(2025, 0, 10) + h * 60 * MIN;
    const r = S.nightAt(at, -36.85, 174.76);
    assert.ok(r.next > at && r.next - at <= 24 * 60 * MIN + 1, `hour ${h}`);
  }
});

test('a window may cross midnight, and an empty window is never active', () => {
  const at = (h, m) => h * 60 + m;
  assert.equal(S.inWindow(at(19, 0), '18:00', '07:00'), true);
  assert.equal(S.inWindow(at(3, 0), '18:00', '07:00'), true);
  assert.equal(S.inWindow(at(7, 0), '18:00', '07:00'), false);
  assert.equal(S.inWindow(at(12, 0), '18:00', '07:00'), false);
  assert.equal(S.inWindow(at(18, 0), '18:00', '07:00'), true);
  assert.equal(S.inWindow(at(12, 0), '09:00', '17:00'), true);
  assert.equal(S.inWindow(at(17, 0), '09:00', '17:00'), false);
  assert.equal(S.inWindow(at(12, 0), '09:00', '09:00'), false);
  assert.equal(S.inWindow(at(12, 0), 'bad', '09:00'), false);
  assert.equal(S.inWindow(at(12, 0), '24:00', '09:00'), false);
});

test('the next change of a window is the nearest mark, today or tomorrow', () => {
  const now = new Date(2025, 5, 10, 12, 0, 0);
  assert.equal(S.nextWindowChange(now, '18:00', '07:00'), new Date(2025, 5, 10, 18, 0).getTime());
  const late = new Date(2025, 5, 10, 23, 0, 0);
  assert.equal(S.nextWindowChange(late, '18:00', '07:00'), new Date(2025, 5, 11, 7, 0).getTime());
  assert.equal(S.nextWindowChange(now, 'bad', '07:00'), null);
  // Exactly at a mark, the next one is later.
  const mark = new Date(2025, 5, 10, 18, 0, 0);
  assert.equal(S.nextWindowChange(mark, '18:00', '07:00'), new Date(2025, 5, 11, 7, 0).getTime());
});

test('evaluate: no automation, time, system and place', () => {
  const now = new Date(2025, 5, 10, 20, 0, 0);
  assert.deepEqual(S.evaluate({ mode: 'none', behavior: 'onOff' }, now, true), { active: null, behavior: 'onOff', next: null });
  assert.deepEqual(S.evaluate(undefined, now, true).active, null);
  const time = S.evaluate({ mode: 'time', behavior: 'scheme', time: { from: '18:00', to: '07:00' } }, now, false);
  assert.equal(time.active, true);
  assert.equal(time.behavior, 'scheme');
  assert.equal(time.next, new Date(2025, 5, 11, 7, 0).getTime());
  assert.equal(S.evaluate({ mode: 'system', behavior: 'onOff' }, now, true).active, true);
  assert.equal(S.evaluate({ mode: 'system', behavior: 'onOff' }, now, false).active, false);
  const place = S.evaluate({ mode: 'location', behavior: 'onOff', location: { lat: 51.5, lon: -0.12 } }, new Date(Date.UTC(2025, 5, 21, 12)), false);
  assert.equal(place.active, false);
  assert.ok(place.next > Date.UTC(2025, 5, 21, 12));
  assert.equal(S.evaluate({ mode: 'location', behavior: 'onOff', location: { lat: null, lon: null } }, now, false).active, null);
});

test('daylight saving: a window keeps its local hours when the clock jumps', () => {
  // Whatever the machine zone is, the marks are built from local calendar parts, so the local hour is always the mark.
  for (const day of [8, 9, 10, 29, 30, 31]) {
    const now = new Date(2025, day > 15 ? 2 : 2, day, 1, 0, 0);
    const next = new Date(S.nextWindowChange(now, '03:30', '04:30'));
    assert.deepEqual([next.getHours(), next.getMinutes()], [3, 30], String(day));
  }
});
