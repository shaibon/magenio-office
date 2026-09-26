/**
 * Active window on interval missions — full cadence inside "Mon-Fri 08:00-20:00",
 * a slow (or no) cadence outside it. Runs under TZ=UTC except the DST block.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeActiveWindow, activeWindowDelayMs, formatActiveWindow } = loadTs('src/shared/weeklySchedule.ts');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const MIN = 60_000, HOUR = 3_600_000;
const WIN = { days: [1, 2, 3, 4, 5], fromMinute: 480, toMinute: 1200, outsideIntervalMs: 12 * HOUR };
// 2026-09-28 is a Monday.

test('normalizeActiveWindow validates and canonicalises', () => {
  assert.deepEqual(normalizeActiveWindow({ ...WIN, days: [5, 1, 1, 2, 3, 4] }), WIN);
  assert.equal(normalizeActiveWindow({ ...WIN, days: [] }), null);
  assert.equal(normalizeActiveWindow({ ...WIN, fromMinute: 1200, toMinute: 480 }), null, 'overnight not supported');
  assert.equal(normalizeActiveWindow({ ...WIN, toMinute: 1441 }), null);
  assert.equal(normalizeActiveWindow(undefined), null);
  const { outsideIntervalMs, ...noOut } = WIN;
  assert.deepEqual(normalizeActiveWindow({ ...noOut, outsideIntervalMs: 0 }), noOut, 'bad outside cadence = none');
});

test('inside the window the plain interval applies', () => {
  const now = at(2026, 9, 28, 10, 0);
  assert.equal(activeWindowDelayMs(WIN, 30 * MIN, now, now - 10 * MIN), 20 * MIN);
  assert.equal(activeWindowDelayMs(WIN, 30 * MIN, now, now - 2 * HOUR), 0, 'overdue fires now');
});

test('outside the window the slow cadence applies', () => {
  const now = at(2026, 9, 28, 22, 0); // Mon night
  // last fired 2h ago -> 10h to go on 12h cadence, but Tue 08:00 opens sooner (10h) -> tie; use 1h ago
  assert.equal(activeWindowDelayMs(WIN, 30 * MIN, now, now - 1 * HOUR), 10 * HOUR, 'window opens in 10h, before 11h');
  const sat = at(2026, 10, 3, 9, 0);
  assert.equal(activeWindowDelayMs(WIN, 30 * MIN, sat, sat - HOUR), 11 * HOUR, 'weekend: 12h cadence');
});

test('no outside cadence means silent until the window opens', () => {
  const { outsideIntervalMs, ...noOut } = WIN;
  const fri = at(2026, 10, 2, 21, 0);
  assert.equal(activeWindowDelayMs(noOut, 30 * MIN, fri, fri - HOUR), at(2026, 10, 5, 8, 0) - fri);
});

test('an in-window tick that would land past the close waits for the next opening or slow cadence', () => {
  const now = at(2026, 9, 28, 19, 50);
  assert.equal(activeWindowDelayMs(WIN, 30 * MIN, now, now), 12 * HOUR, '20:20 is outside; 07:50 (12h) beats the 08:00 opening');
});

test('DST: window opening is a wall-clock time, not 24h later', () => {
  const prev = process.env.TZ;
  // Spring-forward in Rome: 2026-03-29. Friday 03-27 21:00 -> Monday 03-30 08:00 local.
  const script = `
    const load=require('./test/load-ts.cjs');
    const {activeWindowDelayMs}=load('src/shared/weeklySchedule.ts');
    const W={days:[1,2,3,4,5],fromMinute:480,toMinute:1200};
    const now=new Date(2026,2,27,21,0).getTime();
    const d=activeWindowDelayMs(W,1800000,now,now-3600000);
    process.stdout.write(JSON.stringify([d===new Date(2026,2,30,8,0).getTime()-now, d/3600000]));`;
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', script],
    { env: { ...process.env, TZ: 'Europe/Rome' }, encoding: 'utf8' }).trim();
  assert.equal(out, '[true,58]', 'Fri 21:00 to Mon 08:00 is 59h normally, 58h across spring-forward');
  void prev;
});

test('formatActiveWindow', () => {
  assert.equal(formatActiveWindow(WIN), 'weekdays 08:00-20:00, off-window every 12h');
});

/* ── outsideMinutes: fixed times of day outside the window ── */
const FIXED = { days: [1, 2, 3, 4, 5], fromMinute: 480, toMinute: 1200, outsideMinutes: [18 * 60, 12 * 60] };
const delay = (w, now) => activeWindowDelayMs(w, 30 * MIN, now, now); // just fired at `now`

test('outsideMinutes: normalized sorted, de-duped, range-checked; empty = absent', () => {
  assert.deepEqual(normalizeActiveWindow({ ...FIXED, outsideMinutes: [1080, 720, 720, -1, 1440, 1.5, 'x'] }).outsideMinutes, [720, 1080]);
  assert.equal('outsideMinutes' in normalizeActiveWindow({ ...FIXED, outsideMinutes: [] }), false);
  assert.equal('outsideMinutes' in normalizeActiveWindow({ ...FIXED, outsideMinutes: [1440] }), false);
  assert.equal('outsideMinutes' in normalizeActiveWindow(WIN), false, 'no key when absent');
});

test('outsideMinutes: weekend fires at 12:00 then 18:00, not a 12h drift', () => {
  const sat0 = at(2026, 10, 3, 0, 5);
  assert.equal(delay(FIXED, sat0), at(2026, 10, 3, 12) - sat0);
  const sat12 = at(2026, 10, 3, 12, 0);
  assert.equal(delay(FIXED, sat12), 6 * HOUR, 'after 12:00 comes 18:00');
  const sat18 = at(2026, 10, 3, 18, 0);
  assert.equal(delay(FIXED, sat18), at(2026, 10, 4, 12) - sat18, 'after 18:00 comes Sunday 12:00');
  const sun18 = at(2026, 10, 4, 18, 0);
  assert.equal(delay(FIXED, sun18), at(2026, 10, 5, 8) - sun18, 'Sunday night: Monday 08:00 opening (Mon 12:00 is in-window)');
});

test('outsideMinutes: listed times inside the window are skipped', () => {
  const tueNight = at(2026, 9, 29, 20, 30);
  assert.equal(delay(FIXED, tueNight), at(2026, 9, 30, 8) - tueNight, 'nothing extra on a weekday night');
  const fri = at(2026, 10, 2, 20, 30);
  assert.equal(delay(FIXED, fri), at(2026, 10, 3, 12) - fri, 'Friday night waits for Saturday 12:00');
});

test('outsideMinutes takes precedence over outsideIntervalMs', () => {
  const both = { ...FIXED, outsideIntervalMs: HOUR };
  const sat = at(2026, 10, 3, 9, 0);
  assert.equal(delay(both, sat), 3 * HOUR);
});

test('outsideMinutes: overdue ticks are not replayed; strictly-after semantics', () => {
  const noon = at(2026, 10, 3, 12, 0);
  assert.equal(activeWindowDelayMs(FIXED, 30 * MIN, noon, noon), 6 * HOUR, 'a slot exactly now is not re-armed');
});

test('formatActiveWindow with outsideMinutes', () => {
  assert.equal(formatActiveWindow(FIXED), 'weekdays 08:00-20:00, off-window at 12:00, 18:00');
});
