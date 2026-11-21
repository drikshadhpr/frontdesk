'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../src/sla');

// helper: IST wall-clock -> Date
const ist = (s) => new Date(`${s}+05:30`);
const H = new Set();

test('Friday 18:00 ticket is not late on Sunday morning (Meera\'s example)', () => {
  const t = { priority: 'medium', sla_start_at: ist('2026-11-20T18:00:00'), status: 'open', paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-22T10:00:00'), H);
  // 4.5h reply: 30 min Friday + 240 min Monday => Mon 13:30
  assert.equal(new Date(r.responseDue).toISOString(), ist('2026-11-23T13:30:00').toISOString());
  assert.equal(r.late, false);
});

test('urgent reply deadline spans the weekend; fix-by is end of the same working day', () => {
  const t = { priority: 'urgent', sla_start_at: ist('2026-11-20T18:00:00'), status: 'open', paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-22T10:00:00'), H);
  assert.equal(new Date(r.responseDue).toISOString(), ist('2026-11-23T11:00:00').toISOString());
  assert.equal(r.responseBreached, false);
  assert.equal(new Date(r.resolutionDue).toISOString(), ist('2026-11-20T18:30:00').toISOString());
});

test('urgent ticket arriving Friday 18:00 has a 30-minute same-day window (documented trade-off)', () => {
  const t = { priority: 'urgent', sla_start_at: ist('2026-11-20T18:00:00'), status: 'in_progress', paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-23T09:31:00'), H);
  assert.equal(r.resolutionBreached, true);
});

test('working minutes ignore nights and weekends', () => {
  const m = sla.workingMinutesBetween(ist('2026-11-20T17:30:00'), ist('2026-11-23T10:30:00'), H);
  assert.equal(m, 60 + 60); // Fri 17:30-18:30, Mon 09:30-10:30
});

test('addWorkingMinutes lands at end of day, not next morning, when exact', () => {
  const d = sla.addWorkingMinutes(ist('2026-11-23T09:30:00'), 540, H);
  assert.equal(new Date(d).toISOString(), ist('2026-11-23T18:30:00').toISOString());
});

test('after-hours / weekend arrival starts the clock at next opening', () => {
  const d = sla.addWorkingMinutes(ist('2026-11-21T14:00:00'), 120, H); // Saturday
  assert.equal(new Date(d).toISOString(), ist('2026-11-23T11:30:00').toISOString());
});

test('holidays are skipped', () => {
  const h = new Set(['2026-11-24']); // Tuesday holiday
  const d = sla.addWorkingMinutes(ist('2026-11-23T18:00:00'), 60, h);
  assert.equal(new Date(d).toISOString(), ist('2026-11-25T10:00:00').toISOString());
});

test('medium: 4.5h reply, 3 working days fix', () => {
  const t = { priority: 'medium', sla_start_at: ist('2026-11-23T09:30:00'), status: 'open', paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-23T10:00:00'), H);
  assert.equal(new Date(r.responseDue).toISOString(), ist('2026-11-23T14:00:00').toISOString());
  assert.equal(new Date(r.resolutionDue).toISOString(), ist('2026-11-25T18:30:00').toISOString());
});

test('waiting on customer pauses the resolution clock', () => {
  const base = { priority: 'medium', sla_start_at: ist('2026-11-23T09:30:00'), first_response_at: ist('2026-11-23T10:00:00'), response_breached: false, status: 'waiting_on_customer', paused_since: ist('2026-11-23T10:00:00'), paused_working_minutes: 0 };
  // a week of silence (3 working days gone by Thu 12:00): never late for resolution while paused
  const r = sla.computeSla(base, ist('2026-11-26T12:00:00'), H);
  assert.equal(r.resolutionBreached, false);
  assert.equal(r.waitingOnCustomer, true);
  // auto-close after 5 working days of silence
  assert.equal(new Date(r.autoCloseAt).toISOString(), ist('2026-11-30T10:00:00').toISOString());
  // after resume, paused minutes extend the deadline
  const resumed = { ...base, status: 'in_progress', paused_since: null, paused_working_minutes: 1620 };
  const r2 = sla.computeSla(resumed, ist('2026-11-30T10:00:00'), H);
  assert.equal(r2.resolutionBreached, false);
});

test('raising priority to urgent mid-way keeps elapsed time and can make it late', () => {
  const t = { priority: 'urgent', sla_start_at: ist('2026-11-23T09:30:00'), first_response_at: ist('2026-11-23T10:00:00'), response_breached: false, status: 'in_progress', paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-24T09:45:00'), H);
  assert.equal(r.resolutionBreached, true);
  assert.equal(r.responseBreached, false);
});

test('reopen window is 5 working days after resolve', () => {
  const t = { priority: 'low', sla_start_at: ist('2026-11-16T09:30:00'), status: 'resolved', resolved_at: ist('2026-11-20T12:00:00'), resolution_breached: false, first_response_at: ist('2026-11-16T10:00:00'), response_breached: false, paused_working_minutes: 0 };
  const r = sla.computeSla(t, ist('2026-11-21T12:00:00'), H);
  assert.equal(new Date(r.reopenUntil).toISOString(), ist('2026-11-27T12:00:00').toISOString());
});
