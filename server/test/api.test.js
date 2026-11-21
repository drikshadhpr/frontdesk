'use strict';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || 'postgres://postgres:pw@localhost:5433/frontdesk_test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool, migrate } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const clock = require('../src/clock');
const { runMaintenance } = require('../src/tickets');

const ist = (s) => new Date(`${s}+05:30`);
let base;
let server;

async function call(method, path, { token, body } = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
}
const login = async (who) => (await call('POST', '/api/auth/login', { body: { email: `${who}@arvo.test`, password: 'frontdesk123' } })).body.token;
const newTicket = async (priority = 'medium', extra = {}) => (await call('POST', '/api/public/tickets', { body: { customerName: 'Cust Omer', customerEmail: 'c@example.com', subject: 'Help', body: 'Please help', priority, ...extra } })).body;
const tid = (ref) => Number(ref.slice(3));

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await seed();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { clock.set(null); server.close(); await pool.end(); });

test('INC-0291: two agents claiming at once - exactly one wins', async () => {
  clock.set(ist('2026-11-23T10:00:00'));
  const [a, b] = [await login('arjun'), await login('divya')];
  const t = await newTicket();
  const id = tid(t.ref);
  const rs = await Promise.all([call('POST', `/api/tickets/${id}/claim`, { token: a }), call('POST', `/api/tickets/${id}/claim`, { token: b })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const loser = rs.find((r) => r.status === 409);
  assert.match(loser.body.error, /Already taken by/);
  // the loser cannot reply either
  const loserToken = rs[0].status === 409 ? a : b;
  const rr = await call('POST', `/api/tickets/${id}/reply`, { token: loserToken, body: { body: 'my answer' } });
  assert.equal(rr.status, 409);
});

test('INC-0304: internal notes never appear in any customer-facing or export output', async () => {
  clock.set(ist('2026-11-23T10:00:00'));
  const tok = await login('sneha');
  const t = await newTicket('low');
  const id = tid(t.ref);
  const SECRET = 'TOPSECRET-handle-with-care-9931';
  await call('POST', `/api/tickets/${id}/claim`, { token: tok });
  assert.equal((await call('POST', `/api/tickets/${id}/notes`, { token: tok, body: { body: SECRET } })).status, 201);
  assert.equal((await call('POST', `/api/tickets/${id}/reply`, { token: tok, body: { body: 'Hello customer' } })).status, 201);

  const pubView = await call('GET', `/api/public/tickets/${t.token}`);
  assert.equal(pubView.status, 200);
  assert.ok(!JSON.stringify(pubView.body).includes(SECRET));
  assert.ok(!JSON.stringify(pubView.body).toLowerCase().includes('note'));
  const csv = await call('GET', '/api/tickets/export.csv', { token: tok });
  assert.ok(!csv.body.includes(SECRET));
  const lst = await call('GET', '/api/tickets?view=all', { token: tok });
  assert.ok(!JSON.stringify(lst.body).includes(SECRET));
  // events carry no note text either
  const detail = await call('GET', `/api/tickets/${id}`, { token: tok });
  assert.equal(detail.body.internalNotes[0].body, SECRET);
  assert.ok(!JSON.stringify(detail.body.events).includes(SECRET));
  // customer reply/ reopen responses are also safe
  const cr = await call('POST', `/api/public/tickets/${t.token}/messages`, { body: { body: 'thanks' } });
  assert.ok(!JSON.stringify(cr.body).includes(SECRET));
  // public API has no way to see notes or the agent API without login
  assert.equal((await call('GET', `/api/tickets/${id}`)).status, 401);
});

test('INC-0318: audit log is immutable and hash chain verifies', async () => {
  clock.set(ist('2026-11-23T10:00:00'));
  const tok = await login('rahul');
  const t = await newTicket();
  const id = tid(t.ref);
  await call('POST', `/api/tickets/${id}/claim`, { token: tok });
  clock.set(ist('2026-11-23T10:40:00'));
  await call('POST', `/api/tickets/${id}/reply`, { token: tok, body: { body: 'On it' } });
  const detail = await call('GET', `/api/tickets/${id}`, { token: tok });
  const reply = detail.body.events.find((e) => e.type === 'reply_sent');
  assert.equal(new Date(reply.at).toISOString(), ist('2026-11-23T10:40:00').toISOString());
  assert.equal(reply.actorName, 'Rahul Varma');
  assert.equal(reply.data.responseWorkingMinutes, 40);
  await assert.rejects(pool.query("UPDATE ticket_events SET actor_name='x' WHERE ticket_id=$1", [id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ticket_events WHERE ticket_id=$1', [id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE ticket_events'), /append-only/);
  await assert.rejects(pool.query('UPDATE messages SET body=$1 WHERE ticket_id=$2', ['edited', id]), /append-only/);
  await assert.rejects(pool.query('UPDATE internal_notes SET body=$1', ['edited']), /append-only/);
  const v = await call('GET', `/api/tickets/${id}/audit/verify`, { token: tok });
  assert.deepEqual(v.body, { ok: true, events: 3 });
});

test('waiting on customer pauses SLA, customer reply resumes, silence auto-closes after 5 working days', async () => {
  clock.set(ist('2026-11-23T09:30:00')); // Monday
  const tok = await login('anil');
  const t = await newTicket('medium');
  const id = tid(t.ref);
  await call('POST', `/api/tickets/${id}/claim`, { token: tok });
  clock.set(ist('2026-11-23T10:00:00'));
  await call('POST', `/api/tickets/${id}/reply`, { token: tok, body: { body: 'Which browser?', askCustomer: true } });
  // two weeks pass with no reply: it would be breached if the clock ran, but it is paused
  clock.set(ist('2026-11-27T12:00:00'));
  let d = await call('GET', `/api/tickets/${id}`, { token: tok });
  assert.equal(d.body.ticket.status, 'waiting_on_customer');
  assert.equal(d.body.ticket.sla.late, false);
  assert.equal(d.body.ticket.sla.waitingOnCustomer, true);
  // customer replies Fri 12:00 -> back in progress, paused time recorded
  await call('POST', `/api/public/tickets/${t.token}/messages`, { body: { body: 'Chrome' } });
  d = await call('GET', `/api/tickets/${id}`, { token: tok });
  assert.equal(d.body.ticket.status, 'in_progress');
  assert.ok(d.body.ticket.sla.pausedWorkingMinutes > 0);

  // second ticket: customer never answers
  clock.set(ist('2026-12-01T10:00:00'));
  const t2 = await newTicket('low');
  const id2 = tid(t2.ref);
  await call('POST', `/api/tickets/${id2}/claim`, { token: tok });
  await call('POST', `/api/tickets/${id2}/reply`, { token: tok, body: { body: 'More info?', askCustomer: true } });
  clock.set(ist('2026-12-07T18:00:00'));
  await runMaintenance(clock.now());
  assert.equal((await call('GET', `/api/tickets/${id2}`, { token: tok })).body.ticket.status, 'waiting_on_customer');
  clock.set(ist('2026-12-08T10:00:00')); // 5 working days after Tue 12-01 10:00
  await runMaintenance(clock.now());
  const closed = await call('GET', `/api/tickets/${id2}`, { token: tok });
  assert.equal(closed.body.ticket.status, 'closed');
  assert.equal(closed.body.ticket.closeReason, 'no_customer_reply');
  assert.equal(closed.body.events.at(-1).actorType, 'system');
  // customer writing back to a closed ticket is told to open a new one
  const again = await call('POST', `/api/public/tickets/${t2.token}/messages`, { body: { body: 'hello again' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CLOSED');
});

test('reopen: allowed inside 5 working days, refused after; SLA restarts', async () => {
  clock.set(ist('2026-11-23T10:00:00'));
  const tok = await login('fathima');
  const t = await newTicket('low');
  const id = tid(t.ref);
  await call('POST', `/api/tickets/${id}/claim`, { token: tok });
  assert.equal((await call('POST', `/api/tickets/${id}/resolve`, { token: tok, body: {} })).status, 400); // no reply yet, no message
  assert.equal((await call('POST', `/api/tickets/${id}/resolve`, { token: tok, body: { body: 'Fixed' } })).status, 200);
  const view = await call('GET', `/api/public/tickets/${t.token}`);
  assert.equal(view.body.canReopen, true);

  clock.set(ist('2026-11-27T10:00:00'));
  const ok = await call('POST', `/api/public/tickets/${t.token}/reopen`, { body: { body: 'Still broken' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.statusCode, 'in_progress');

  // second ticket: window passes
  clock.set(ist('2026-11-23T10:00:00'));
  const t2 = await newTicket('low');
  const id2 = tid(t2.ref);
  await call('POST', `/api/tickets/${id2}/claim`, { token: tok });
  await call('POST', `/api/tickets/${id2}/resolve`, { token: tok, body: { body: 'Done' } });
  clock.set(ist('2026-12-01T10:00:00'));
  const late = await call('POST', `/api/public/tickets/${t2.token}/reopen`, { body: { body: 'Broken again' } });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'CLOSED');
});

test('priority change is audited with before/after deadlines', async () => {
  clock.set(ist('2026-11-23T10:00:00'));
  const tok = await login('joseph');
  const t = await newTicket('medium');
  const id = tid(t.ref);
  clock.set(ist('2026-11-23T11:00:00'));
  await call('POST', `/api/tickets/${id}/priority`, { token: tok, body: { priority: 'urgent' } });
  const d = await call('GET', `/api/tickets/${id}`, { token: tok });
  const ev = d.body.events.find((e) => e.type === 'priority_changed');
  assert.equal(ev.data.from, 'medium');
  assert.equal(ev.data.to, 'urgent');
  assert.notEqual(ev.data.resolutionDueBefore, ev.data.resolutionDueAfter);
});
