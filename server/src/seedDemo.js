'use strict';
// Demo data using back-dated timestamps so a reviewer immediately sees late / waiting / reopen cases.
const { pool } = require('./db');
const svc = require('./tickets');

const ist = (s) => new Date(`${s}+05:30`);

async function seedDemo() {
  const n = (await pool.query('SELECT count(*)::int AS n FROM tickets')).rows[0].n;
  if (n > 0) return;
  const ag = {};
  (await pool.query('SELECT * FROM agents')).rows.forEach((a) => { ag[a.email.split('@')[0]] = a; });

  const mk = (o, when) => svc.createTicket({ customerName: o.c, customerEmail: `${o.c.split(' ')[0].toLowerCase()}@example.com`, subject: o.s, body: o.b, priority: o.p }, ist(when));

  // 1. Friday 18:00 arrival - NOT late on the weekend (medium)
  await mk({ c: 'Priya Shah', s: 'Invoice PDF shows wrong GST number', b: 'The invoice generated today has an old GST number.', p: 'medium' }, '2026-11-20T18:00:00');
  // 2. Urgent, unanswered since Thursday -> LATE
  await mk({ c: 'Ravi Teja', s: 'Cannot log in - whole team blocked', b: 'Nobody in our office can log in since this morning.', p: 'urgent' }, '2026-11-19T10:00:00');
  // 3. Claimed by Arjun, answered, waiting on customer for days (clock paused, not late)
  const t3 = await mk({ c: 'Nisha Rao', s: 'Export to Excel is empty', b: 'The export button gives an empty file.', p: 'medium' }, '2026-11-16T10:00:00');
  await svc.claim(t3.id, ag.arjun, ist('2026-11-16T10:10:00'));
  await svc.reply(t3.id, ag.arjun, { body: 'Could you tell us which report you exported and the date range?', askCustomer: true }, ist('2026-11-16T10:30:00'));
  await svc.addNote(t3.id, ag.arjun, 'INTERNAL: customer is on the legacy plan, check the export flag before promising anything.', ist('2026-11-16T10:35:00'));
  // 4. Resolved yesterday - customer can still reopen
  const t4 = await mk({ c: 'Tom George', s: 'How do I change my billing email?', b: 'Where can I change the billing email?', p: 'low' }, '2026-11-18T11:00:00');
  await svc.claim(t4.id, ag.divya, ist('2026-11-18T11:30:00'));
  await svc.reply(t4.id, ag.divya, { body: 'Let me check that for you.' }, ist('2026-11-18T11:40:00'));
  await svc.resolve(t4.id, ag.divya, 'Settings > Billing > Contact. Marking this as done.', ist('2026-11-20T12:00:00'));
  // 5. Fresh, unassigned
  await mk({ c: 'Asha Menon', s: 'Dark mode request', b: 'Could you add a dark mode to the dashboard?', p: 'low' }, '2026-11-21T09:00:00');
  // 6. Claimed by Rahul, urgent priority raised mid-way
  const t6 = await mk({ c: 'Kabir Sheth', s: 'Reports page times out', b: 'The reports page takes over a minute.', p: 'medium' }, '2026-11-19T09:45:00');
  await svc.claim(t6.id, ag.rahul, ist('2026-11-19T10:00:00'));
  await svc.reply(t6.id, ag.rahul, { body: 'Looking into it now.' }, ist('2026-11-19T10:20:00'));
  await svc.setPriority(t6.id, ag.rahul, 'urgent', ist('2026-11-20T10:00:00'));
}
module.exports = { seedDemo };
if (require.main === module) {
  require('./db').migrate().then(require('./seed').seed).then(seedDemo).then(() => pool.end());
}
