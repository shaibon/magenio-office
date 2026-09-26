/**
 * WEEKLY SCHEDULES — "every Monday and Thursday at 09:00" instead of
 * "every 86400000 ms".
 *
 * A `ScheduledMission` has always fired on a fixed interval, which cannot say
 * "weekday mornings": an interval drifts relative to the clock, and a 24h one
 * started at 15:00 fires at 15:00 forever. This module adds the other shape.
 * When a mission carries a valid `weekly`, that REPLACES its interval; the
 * interval is left on the record untouched so switching back restores it.
 *
 * Pure and import-free on purpose, so the test loader can take it directly and
 * the scheduler's arithmetic is testable without a clock or a config file.
 *
 * ── Everything here is LOCAL time, deliberately ────────────────────────────
 * "09:00 on Monday" means 09:00 where the user is sitting, which is the only
 * reading a person expects. That is why the next occurrence is built with the
 * Date(y, m, d, h, min) constructor rather than by adding milliseconds: adding
 * 7 * 86400000 across a daylight-saving boundary lands an hour off, while
 * re-constructing from calendar fields lands on the same wall clock. On a
 * spring-forward day a time that does not exist (02:30 in most of the US) rolls
 * forward the way the platform rolls it, which is the standard behaviour and
 * the one every other scheduler produces too.
 */

export interface WeeklySchedule {
  /** 0 = Sunday … 6 = Saturday. Empty means "not a weekly schedule". */
  days: number[];
  /** Minutes since local midnight, 0..1439. */
  minute: number;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Initials for the 7-button picker. Two Ts and two Ss — the position carries
 *  the meaning, and every calendar in the world does the same. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * How long after a MISSED slot the mission still fires.
 *
 * A laptop asleep at 09:00 and opened at 10:30 should still get its 09:00 run;
 * one closed on Friday and opened on Monday should not get Friday's. Six hours
 * splits those two cases about where a person would. This matches what the
 * interval scheduler already does (it clamps a negative remaining time to zero
 * and fires on boot), so the two kinds of schedule behave the same way after a
 * sleep rather than one of them silently skipping.
 */
export const WEEKLY_CATCHUP_MS = 6 * 60 * 60 * 1000;

/** Validate and canonicalise. Returns null for anything that is not a usable
 *  weekly schedule — no days, a bad day number, a minute outside the day — so
 *  every caller has exactly one check to make. Days come back sorted and
 *  de-duplicated, so two schedules that mean the same thing compare equal. */
export function normalizeWeekly(w: unknown): WeeklySchedule | null {
  if (!w || typeof w !== 'object') return null;
  const raw = w as { days?: unknown; minute?: unknown };
  if (!Array.isArray(raw.days)) return null;
  const days = [...new Set(
    raw.days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  )].sort((a, b) => a - b);
  if (days.length === 0) return null;
  const minute = raw.minute;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
  return { days, minute };
}

/** "09:00". Zero-padded 24h, because a schedule an operator is reading back
 *  should not need an am/pm second look. */
export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Human summary for a row: "weekdays at 09:00", "Mon, Thu at 14:30". */
export function formatWeekly(w: unknown): string {
  const n = normalizeWeekly(w);
  if (!n) return 'no days picked';
  const at = formatMinute(n.minute);
  const key = n.days.join(',');
  if (key === '0,1,2,3,4,5,6') return `every day at ${at}`;
  if (key === '1,2,3,4,5') return `weekdays at ${at}`;
  if (key === '0,6') return `weekends at ${at}`;
  return `${n.days.map((d) => WEEKDAY_LABELS[d]).join(', ')} at ${at}`;
}

/** Build the local instant for `minute` on the day `offset` days from `from`.
 *  Calendar-field construction, not millisecond arithmetic — see the DST note. */
function slotAt(from: Date, offset: number, minute: number): Date {
  return new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + offset,
    Math.floor(minute / 60), minute % 60, 0, 0
  );
}

/** The first matching slot STRICTLY after `nowMs`, or null if there are no days.
 *  Eight candidates is always enough: the worst case is one day a week whose
 *  slot has already passed today, which lands on offset 7. */
export function nextWeeklyFireMs(w: unknown, nowMs: number): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t > nowMs) return t;
  }
  return null;
}

/** The most recent matching slot at or before `nowMs`, or null. Used only to
 *  decide whether a slot was MISSED while the app was not running. */
export function previousWeeklyFireMs(w: unknown, nowMs: number): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset >= -7; offset--) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t <= nowMs) return t;
  }
  return null;
}

/**
 * How long the scheduler should wait before firing this mission, or null when
 * the schedule is not usable.
 *
 * Zero means "fire now": a slot passed while we were not watching, it is recent
 * enough to still be worth running, and we have not already run it. That last
 * clause is what `lastFiredAt` is for — without it, re-arming the scheduler
 * (which happens on every save of ANY mission) would re-fire a mission that
 * already ran minutes ago.
 */
export function weeklyDelayMs(w: unknown, nowMs: number, lastFiredAt = 0): number | null {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const prev = previousWeeklyFireMs(n, nowMs);
  if (prev !== null && prev > lastFiredAt && nowMs - prev <= WEEKLY_CATCHUP_MS) return 0;
  const next = nextWeeklyFireMs(n, nowMs);
  return next === null ? null : Math.max(0, next - nowMs);
}

/* ─────────────────────────── active window ───────────────────────────────────
 * "Full rate Mon-Fri 08:00-20:00, once or twice a day otherwise" for a mission
 * that stays interval-based. Unlike `weekly` this does NOT replace the interval:
 * inside the window `intervalMs` applies, outside it `outsideIntervalMs` does
 * (absent = stay silent until the window reopens). Same local-time,
 * calendar-field arithmetic as above. The window is same-day only
 * (fromMinute < toMinute); "festivi" just means "outside the window". */

export interface ActiveWindow {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Window opens at this minute since local midnight (inclusive), 0..1439. */
  fromMinute: number;
  /** …and closes at this one (exclusive), fromMinute+1..1440. */
  toMinute: number;
  /** Cadence outside the window; absent = no runs outside it. */
  outsideIntervalMs?: number;
  /** Fixed times of day (minutes since local midnight, sorted, 0..1439) for
   *  outside the window; TAKES PRECEDENCE over `outsideIntervalMs`. A listed
   *  time that itself falls inside the window is skipped. */
  outsideMinutes?: number[];
}

/** Validate and canonicalise; null for anything unusable (a bad window is
 *  ignored, so the mission falls back to its plain interval). */
export function normalizeActiveWindow(w: unknown): ActiveWindow | null {
  if (!w || typeof w !== 'object') return null;
  const raw = w as { days?: unknown; fromMinute?: unknown; toMinute?: unknown; outsideIntervalMs?: unknown; outsideMinutes?: unknown };
  const days = normalizeWeekly({ days: raw.days, minute: 0 })?.days;
  if (!days) return null;
  const { fromMinute: from, toMinute: to, outsideIntervalMs: out } = raw;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from > 1439) return null;
  if (typeof to !== 'number' || !Number.isInteger(to) || to <= from || to > 1440) return null;
  const win: ActiveWindow = { days, fromMinute: from, toMinute: to };
  if (typeof out === 'number' && Number.isFinite(out) && out > 0) win.outsideIntervalMs = out;
  if (Array.isArray(raw.outsideMinutes)) {
    const mins = [...new Set(raw.outsideMinutes.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 1439))].sort((a, b) => a - b);
    if (mins.length) win.outsideMinutes = mins;
  }
  return win;
}

/** "weekdays 08:00-20:00, off-window every 12h". */
export function formatActiveWindow(w: unknown): string {
  const n = normalizeActiveWindow(w);
  if (!n) return 'no window';
  const key = n.days.join(',');
  const d = key === '1,2,3,4,5' ? 'weekdays' : key === '0,6' ? 'weekends' : key === '0,1,2,3,4,5,6' ? 'every day'
    : n.days.map((x) => WEEKDAY_LABELS[x]).join(', ');
  const out = n.outsideMinutes
    ? `off-window at ${n.outsideMinutes.map(formatMinute).join(', ')}`
    : n.outsideIntervalMs
    ? `off-window every ${n.outsideIntervalMs % 3_600_000 === 0 ? `${n.outsideIntervalMs / 3_600_000}h` : `${Math.round(n.outsideIntervalMs / 60_000)}m`}`
    : 'off-window paused';
  return `${d} ${formatMinute(n.fromMinute)}-${formatMinute(n.toMinute === 1440 ? 1439 : n.toMinute)}, ${out}`;
}

function inWindow(n: ActiveWindow, ms: number): boolean {
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  return n.days.includes(d.getDay()) && m >= n.fromMinute && m < n.toMinute;
}

/**
 * Wait before the next fire of an interval mission that carries a window, or
 * null when the window is unusable (caller keeps the plain interval).
 *
 * The next fire is the earliest of: lastFiredAt + intervalMs, if that lands
 * inside the window; lastFiredAt + outsideIntervalMs, if set (or, when
 * outsideMinutes is set, its next out-of-window time of day instead); and the next
 * window opening, so full rate resumes on the dot. Zero means overdue. A
 * mission that never fired (lastFiredAt 0) is overdue, as with plain intervals.
 */
export function activeWindowDelayMs(w: unknown, intervalMs: number, nowMs: number, lastFiredAt = 0): number | null {
  const n = normalizeActiveWindow(w);
  if (!n) return null;
  const cands: number[] = [];
  const inTick = lastFiredAt + intervalMs;
  if (inWindow(n, Math.max(inTick, nowMs))) cands.push(inTick);
  if (n.outsideMinutes) {
    // Next listed time strictly after now that is itself outside the window.
    // ponytail: a slot missed while the app was closed is not replayed.
    outer: for (let offset = 0; offset <= 7; offset++) {
      for (const m of n.outsideMinutes) {
        const t = slotAt(new Date(nowMs), offset, m).getTime();
        if (t > nowMs && !inWindow(n, t)) { cands.push(t); break outer; }
      }
    }
  } else if (n.outsideIntervalMs) cands.push(lastFiredAt + n.outsideIntervalMs);
  const from = new Date(nowMs);
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotAt(from, offset, n.fromMinute);
    if (n.days.includes(slot.getDay()) && slot.getTime() > nowMs) { cands.push(slot.getTime()); break; }
  }
  return Math.max(0, Math.min(...cands) - nowMs);
}
