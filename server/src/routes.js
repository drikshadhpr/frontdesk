'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { pool } = require('./db');
const { HttpError } = require('./errors');
const svc = require('./tickets');
const views = require('./views');
const { getHolidays, invalidate } = require('./holidays');
const { verifyChain } = require('./audit');
const clock = require('./clock');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
};
const text = (max) => z.string().trim().min(1).max(max);
const PRIORITY = z.enum(['urgent', 'medium', 'low']);

// ============================================================ PUBLIC (customer) API
const pub = express.Router();
pub.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

pub.post('/tickets', wrap(async (req, res) => {
  const b = parse(z.object({
    customerName: text(120), customerEmail: z.string().trim().email().max(200),
    subject: text(200), body: text(10000), priority: PRIORITY,
    followsToken: z.string().optional(),
  }), req.body);
  let followsTicketId = null;
  if (b.followsToken) {
    const r = await pool.query('SELECT id FROM tickets WHERE access_token=$1', [b.followsToken]);
    followsTicketId = r.rows[0]?.id ?? null;
  }
  const t = await svc.createTicket({ ...b, followsTicketId });
  res.status(201).json({ ref: t.ref, token: t.access_token });
}));

async function loadCustomerView(token) {
  const t = (await pool.query('SELECT * FROM tickets WHERE access_token=$1', [token])).rows[0];
  if (!t) throw new HttpError(404, 'Ticket not found');
  // ONLY the messages table is queried here - internal_notes is never touched.
  const msgs = (await pool.query('SELECT * FROM messages WHERE ticket_id=$1 ORDER BY id', [t.id])).rows;
  const names = {};
  (await pool.query('SELECT id, name FROM agents')).rows.forEach((a) => { names[a.id] = a.name.split(' ')[0]; });
  return views.customerTicket(t, msgs, names, await getHolidays(), clock.now());
}

pub.get('/tickets/:token', wrap(async (req, res) => res.json(await loadCustomerView(req.params.token))));
pub.post('/tickets/:token/messages', wrap(async (req, res) => {
  const { body } = parse(z.object({ body: text(10000) }), req.body);
  await svc.customerReply(req.params.token, body);
  res.status(201).json(await loadCustomerView(req.params.token));
}));
pub.post('/tickets/:token/reopen', wrap(async (req, res) => {
  const { body } = parse(z.object({ body: text(10000) }), req.body);
  await svc.reopen(req.params.token, body);
  res.json(await loadCustomerView(req.params.token));
}));

// ============================================================ AGENT API
const api = express.Router();

api.post('/auth/login', rateLimit({ windowMs: 60_000, limit: 20 }), wrap(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
  const a = (await pool.query('SELECT * FROM agents WHERE email=$1', [email])).rows[0];
  if (!a || !(await bcrypt.compare(password, a.password_hash))) throw new HttpError(401, 'Wrong email or password');
  const token = jwt.sign({ sub: a.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, agent: { id: a.id, name: a.name, email: a.email, role: a.role } });
}));

api.use(wrap(async (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Not signed in');
  let payload;
  try { payload = jwt.verify(m[1], JWT_SECRET); } catch { throw new HttpError(401, 'Session expired, sign in again'); }
  const a = (await pool.query('SELECT id, name, email, role FROM agents WHERE id=$1', [payload.sub])).rows[0];
  if (!a) throw new HttpError(401, 'Unknown agent');
  req.agent = a;
  next();
}));

api.get('/me', (req, res) => res.json(req.agent));
api.get('/agents', wrap(async (req, res) => {
  res.json((await pool.query('SELECT id, name, role FROM agents ORDER BY name')).rows);
}));

const LIST_SQL = `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id`;

async function listTickets(agent, view) {
  const now = clock.now();
  const h = await getHolidays();
  let where = '';
  const params = [];
  if (view === 'mine') { where = "WHERE t.assignee_id=$1 AND t.status IN ('open','in_progress','waiting_on_customer')"; params.push(agent.id); }
  else if (view === 'unassigned') where = "WHERE t.assignee_id IS NULL AND t.status IN ('open','in_progress','waiting_on_customer')";
  else if (view === 'active') where = "WHERE t.status IN ('open','in_progress','waiting_on_customer')";
  else if (view === 'done') where = "WHERE t.status IN ('resolved','closed')";
  const rows = (await pool.query(`${LIST_SQL} ${where} ORDER BY t.id DESC LIMIT 500`, params)).rows;
  return rows.map((r) => views.agentTicket(r, h, now, r.assignee_name));
}

const rank = (t) => (t.sla.late ? 0 : t.sla.waitingOnCustomer ? 2 : 1);
api.get('/tickets', wrap(async (req, res) => {
  const view = ['mine', 'unassigned', 'active', 'done', 'all'].includes(req.query.view) ? req.query.view : 'mine';
  const list = await listTickets(req.agent, view);
  // late first, then soonest resolution deadline; waiting-on-customer last
  list.sort((a, b) => rank(a) - rank(b) || new Date(a.sla.resolutionDue) - new Date(b.sla.resolutionDue));
  res.json(list);
}));

// Export: ticket metadata only. Conversation and internal notes are never included.
api.get('/tickets/export.csv', wrap(async (req, res) => {
  const list = await listTickets(req.agent, 'all');
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['ref', 'subject', 'priority', 'status', 'customer', 'assignee', 'created_at', 'first_response_at', 'resolved_at', 'response_due', 'resolution_due', 'late', 'late_reasons'];
  const lines = [head.join(',')].concat(list.map((t) => [t.ref, t.subject, t.priority, t.status, t.customerName, t.assigneeName, t.createdAt, t.firstResponseAt, t.resolvedAt, t.sla.responseDue, t.sla.resolutionDue, t.sla.late, t.sla.lateReasons.join('; ')].map(esc).join(',')));
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="tickets.csv"').send(lines.join('\n'));
}));

// "Which problems were late and why?"
api.get('/reports/late', wrap(async (req, res) => {
  const list = (await listTickets(req.agent, 'all')).filter((t) => t.sla.late);
  const out = [];
  for (const t of list) {
    const ev = (await pool.query("SELECT at, actor_name, type, data FROM ticket_events WHERE ticket_id=$1 AND type IN ('reply_sent','priority_changed','customer_replied','resolved','reopened','auto_closed') ORDER BY id", [t.id])).rows;
    out.push({ ...t, relevantEvents: ev });
  }
  res.json(out);
}));

api.get('/tickets/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = (await pool.query(`${LIST_SQL} WHERE t.id=$1`, [id])).rows[0];
  if (!r) throw new HttpError(404, 'Ticket not found');
  const [msgs, notes, events] = await Promise.all([
    pool.query('SELECT m.*, a.name AS agent_name FROM messages m LEFT JOIN agents a ON a.id=m.agent_id WHERE ticket_id=$1 ORDER BY m.id', [id]),
    pool.query('SELECT n.*, a.name AS agent_name FROM internal_notes n JOIN agents a ON a.id=n.agent_id WHERE ticket_id=$1 ORDER BY n.id', [id]),
    pool.query('SELECT id, at, actor_type, actor_name, type, data FROM ticket_events WHERE ticket_id=$1 ORDER BY id', [id]),
  ]);
  res.json({
    ticket: views.agentTicket(r, await getHolidays(), clock.now(), r.assignee_name),
    messages: msgs.rows.map((m) => ({ id: Number(m.id), from: m.author_type, authorName: m.author_type === 'agent' ? m.agent_name : r.customer_name, body: m.body, at: m.created_at })),
    internalNotes: notes.rows.map((n) => ({ id: Number(n.id), authorName: n.agent_name, body: n.body, at: n.created_at })),
    events: events.rows.map((e) => ({ id: Number(e.id), at: e.at, actorType: e.actor_type, actorName: e.actor_name, type: e.type, data: e.data })),
  });
}));

api.get('/tickets/:id/audit/verify', wrap(async (req, res) => res.json(await verifyChain(pool, Number(req.params.id)))));

const idp = (req) => Number(req.params.id);
api.post('/tickets/:id/claim', wrap(async (req, res) => { await svc.claim(idp(req), req.agent); res.json({ ok: true }); }));
api.post('/tickets/:id/release', wrap(async (req, res) => { await svc.release(idp(req), req.agent); res.json({ ok: true }); }));
api.post('/tickets/:id/assign', wrap(async (req, res) => {
  const { agentId } = parse(z.object({ agentId: z.number().int() }), req.body);
  await svc.assign(idp(req), req.agent, agentId); res.json({ ok: true });
}));
api.post('/tickets/:id/reply', wrap(async (req, res) => {
  const b = parse(z.object({ body: text(10000), askCustomer: z.boolean().optional() }), req.body);
  await svc.reply(idp(req), req.agent, b); res.status(201).json({ ok: true });
}));
api.post('/tickets/:id/notes', wrap(async (req, res) => {
  const { body } = parse(z.object({ body: text(10000) }), req.body);
  await svc.addNote(idp(req), req.agent, body); res.status(201).json({ ok: true });
}));
api.post('/tickets/:id/priority', wrap(async (req, res) => {
  const { priority } = parse(z.object({ priority: PRIORITY }), req.body);
  await svc.setPriority(idp(req), req.agent, priority); res.json({ ok: true });
}));
api.post('/tickets/:id/resolve', wrap(async (req, res) => {
  const b = parse(z.object({ body: text(10000).optional() }), req.body || {});
  await svc.resolve(idp(req), req.agent, b.body); res.json({ ok: true });
}));

api.get('/holidays', wrap(async (req, res) => {
  res.json((await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, name FROM holidays ORDER BY day")).rows);
}));
api.post('/holidays', wrap(async (req, res) => {
  if (req.agent.role !== 'manager') throw new HttpError(403, 'Only managers can edit holidays');
  const b = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: text(100) }), req.body);
  await pool.query('INSERT INTO holidays (day, name) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET name=EXCLUDED.name', [b.day, b.name]);
  invalidate(); res.status(201).json({ ok: true });
}));
api.delete('/holidays/:day', wrap(async (req, res) => {
  if (req.agent.role !== 'manager') throw new HttpError(403, 'Only managers can edit holidays');
  await pool.query('DELETE FROM holidays WHERE day=$1', [req.params.day]); invalidate(); res.json({ ok: true });
}));

module.exports = { pub, api };
