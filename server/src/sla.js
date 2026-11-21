'use strict';
/**
 * SLA engine - pure functions, no I/O.
 *
 * Working time = 09:30-18:30 Asia/Kolkata (fixed UTC+05:30, India has no DST),
 * Monday-Friday, minus holidays. Everything is computed in "working minutes".
 *
 * Interpretations of Meera's notes (see README "Decisions"):
 *   urgent  : reply within 2 working hours; fix by END of the same working day
 *   medium  : reply within "half a day" (4.5 working h); fix in 3 working days
 *   low     : reply within "one day" (9 working h); fix in 5 working days
 *   customer-wait pauses the resolution clock; 5 working days of silence -> auto-close
 *   reopen window after "resolved" = 5 working days
 */

const MS_MIN = 60000;
const TZ_OFFSET_MIN = 330;
const OPEN_MIN = 9 * 60 + 30; // 09:30
const CLOSE_MIN = 18 * 60 + 30; // 18:30
const WORK_DAY_MIN = CLOSE_MIN - OPEN_MIN; // 540

const POLICIES = {
  urgent: { response: 2 * 60, resolution: { endOfWorkingDay: true } },
  medium: { response: WORK_DAY_MIN / 2, resolution: 3 * WORK_DAY_MIN },
  low: { response: WORK_DAY_MIN, resolution: 5 * WORK_DAY_MIN },
};
const AUTO_CLOSE_MIN = 5 * WORK_DAY_MIN;
const REOPEN_WINDOW_MIN = 5 * WORK_DAY_MIN;

const toMs = (d) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : new Date(d).getTime());

// ---- calendar helpers (all in IST) ---------------------------------------
const localMin = (ms) => ms / MS_MIN + TZ_OFFSET_MIN;
const dayOf = (ms) => Math.floor(localMin(ms) / 1440);
const minOfDay = (ms) => localMin(ms) - dayOf(ms) * 1440;
const fromLocal = (day, min) => (day * 1440 + min - TZ_OFFSET_MIN) * MS_MIN;
const dateStr = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const dow = (day) => (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0=Sun

function isWorkingDay(day, holidays) {
  const w = dow(day);
  if (w === 0 || w === 6) return false;
  return !(holidays && holidays.has(dateStr(day)));
}

/** First working instant >= ms (ms itself if it is inside working hours). */
function nextWorkingInstant(ms, holidays) {
  let day = dayOf(ms);
  const m = minOfDay(ms);
  if (isWorkingDay(day, holidays)) {
    if (m < OPEN_MIN) return fromLocal(day, OPEN_MIN);
    if (m < CLOSE_MIN) return ms;
  }
  day += 1;
  for (let i = 0; i < 4000 && !isWorkingDay(day, holidays); i++) day += 1;
  return fromLocal(day, OPEN_MIN);
}

/** Working minutes between two instants. */
function workingMinutesBetween(aIn, bIn, holidays) {
  const a = toMs(aIn);
  const b = toMs(bIn);
  if (!(b > a)) return 0;
  const dA = dayOf(a);
  const dB = dayOf(b);
  let total = 0;
  for (let d = dA; d <= dB; d++) {
    if (!isWorkingDay(d, holidays)) continue;
    const s = d === dA ? minOfDay(a) : 0;
    const e = d === dB ? minOfDay(b) : 1440;
    total += Math.max(0, Math.min(e, CLOSE_MIN) - Math.max(s, OPEN_MIN));
  }
  return total;
}

/** Instant reached after `minutes` of working time, starting at `startIn`. */
function addWorkingMinutes(startIn, minutes, holidays) {
  let t = nextWorkingInstant(toMs(startIn), holidays);
  let remaining = minutes;
  for (let guard = 0; guard < 5000; guard++) {
    const day = dayOf(t);
    const m = minOfDay(t);
    const left = CLOSE_MIN - m;
    if (remaining <= left) return fromLocal(day, m + remaining);
    remaining -= left;
    t = nextWorkingInstant(fromLocal(day, CLOSE_MIN), holidays);
  }
  throw new Error('addWorkingMinutes: runaway loop');
}

/** 18:30 of the working day the ticket's clock starts on. */
function endOfWorkingDay(startIn, holidays) {
  const t = nextWorkingInstant(toMs(startIn), holidays);
  return fromLocal(dayOf(t), CLOSE_MIN);
}

// ---- ticket deadlines -----------------------------------------------------
/**
 * t: { priority, sla_start_at, first_response_at, response_breached,
 *      paused_since, paused_working_minutes, resolved_at, closed_at,
 *      resolution_breached, status }
 *
 * Priority changes: working time already elapsed is kept; the NEW priority's
 * target is simply applied to the same clock (so raising to urgent can make a
 * ticket late at once, lowering it can bring it back on time). Every change is
 * written to the audit log with the before/after deadlines.
 */
function computeSla(t, nowIn, holidays) {
  const now = toMs(nowIn);
  const policy = POLICIES[t.priority];
  const start = toMs(t.sla_start_at);
  const terminal = t.status === 'resolved' || t.status === 'closed';

  const pausedSince = t.paused_since ? toMs(t.paused_since) : null;
  const pausedNow = pausedSince ? workingMinutesBetween(pausedSince, now, holidays) : 0;
  const paused = Number(t.paused_working_minutes || 0) + pausedNow;

  const responseDue = addWorkingMinutes(start, policy.response, holidays);
  let resolutionDue;
  if (policy.resolution.endOfWorkingDay) {
    const eod = endOfWorkingDay(start, holidays);
    resolutionDue = paused > 0 ? addWorkingMinutes(eod, paused, holidays) : eod;
  } else {
    resolutionDue = addWorkingMinutes(start, policy.resolution + paused, holidays);
  }

  const responded = !!t.first_response_at;
  const responseBreached = responded ? !!t.response_breached : now > responseDue;
  const resolutionBreached = terminal ? !!t.resolution_breached : now > resolutionDue;

  return {
    responseDue: new Date(responseDue).toISOString(),
    resolutionDue: new Date(resolutionDue).toISOString(),
    responseBreached,
    resolutionBreached,
    late: responseBreached || resolutionBreached,
    lateReasons: [
      ...(responseBreached ? ['first response was/is overdue'] : []),
      ...(resolutionBreached ? ['resolution was/is overdue'] : []),
    ],
    waitingOnCustomer: t.status === 'waiting_on_customer',
    pausedWorkingMinutes: Math.round(paused),
    autoCloseAt: pausedSince ? new Date(addWorkingMinutes(pausedSince, AUTO_CLOSE_MIN, holidays)).toISOString() : null,
    reopenUntil:
      t.status === 'resolved' && t.resolved_at
        ? new Date(addWorkingMinutes(toMs(t.resolved_at), REOPEN_WINDOW_MIN, holidays)).toISOString()
        : null,
  };
}

module.exports = {
  POLICIES,
  AUTO_CLOSE_MIN,
  REOPEN_WINDOW_MIN,
  WORK_DAY_MIN,
  isWorkingDay,
  nextWorkingInstant,
  workingMinutesBetween,
  addWorkingMinutes,
  endOfWorkingDay,
  computeSla,
  _internal: { dateStr, dayOf, minOfDay, fromLocal },
};
