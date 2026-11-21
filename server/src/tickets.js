'use strict';
const crypto = require('crypto');
const { pool, tx } = require('./db');
const { HttpError } = require('./errors');
const { appendEvent } = require('./audit');
const { getHolidays } = require('./holidays');
const clock = require('./clock');
const sla = require('./sla');

const ACTIVE = ['open', 'in_progress', 'waiting_on_customer'];
const sys = { type: 'system', id: null, name: 'System' };
const agentActor = (a) => ({ type: 'agent', id: a.id, name: a.name });

async function lock(client, where, param) {
  const r = await client.query(`SELECT * FROM tickets WHERE ${where} FOR UPDATE`, [param]);
  if (!r.rows[0]) throw new HttpError(404, 'Ticket not found');
  return r.rows[0];
}
const lockById = (c, id) => lock(c, 'id=$1', id);
const lockByToken = (c, token) => lock(c, 'access_token=$1', token);

async function updateTicket(client, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const r = await client.query(`UPDATE tickets SET ${sets} WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => fields[k])]);
  return r.rows[0];
}

async function addMessage(client, t, { authorType, agentId = null, body, now }) {
  const r = await client.query(
    'INSERT INTO messages (ticket_id, author_type, agent_id, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [t.id, authorType, agentId, body, now]
  );
  return r.rows[0];
}

/** Records first response (response clock stops here). Returns field changes. */
function firstResponseFields(t, now, h) {
  if (t.first_response_at) return { fields: {}, info: { firstResponse: false } };
  const due = sla.computeSla(t, now, h).responseDue;
  const breached = now.getTime() > new Date(due).getTime();
  return {
    fields: { first_response_at: now, response_breached: breached },
    info: {
      firstResponse: true,
      responseDue: due,
      responseWorkingMinutes: Math.round(sla.workingMinutesBetween(t.sla_start_at, now, h)),
      metTarget: !breached,
    },
  };
}

// ---------------------------------------------------------------- create
async function createTicket({ subject, body, customerName, customerEmail, priority, followsTicketId = null }, now = clock.now()) {
  const token = crypto.randomBytes(24).toString('hex');
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO tickets (subject, customer_name, customer_email, priority, access_token, created_at, sla_start_at, follows_ticket_id)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING *`,
      [subject, customerName, customerEmail, priority, token, now, followsTicketId]
    );
    const t = r.rows[0];
    const m = await addMessage(c, t, { authorType: 'customer', body, now });
    await appendEvent(c, { ticketId: t.id, at: now, actor: { type: 'customer', id: null, name: customerName }, type: 'ticket_created', data: { priority, messageId: Number(m.id), followsTicketId } });
    return t;
  });
}

// ---------------------------------------------------------------- agent actions
// Atomic: the row lock + conditional checks mean exactly one concurrent claim wins (INC-0291).
async function claim(id, agent, now = clock.now()) {
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (t.assignee_id) {
      const o = await c.query('SELECT name FROM agents WHERE id=$1', [t.assignee_id]);
      throw new HttpError(409, `Already taken by ${o.rows[0].name}`, { code: 'ALREADY_CLAIMED', assigneeId: t.assignee_id });
    }
    if (!ACTIVE.includes(t.status)) throw new HttpError(409, `Ticket is ${t.status}`);
    const u = await updateTicket(c, id, { assignee_id: agent.id, status: t.status === 'waiting_on_customer' ? t.status : 'in_progress' });
    await appendEvent(c, { ticketId: id, at: now, actor: agentActor(agent), type: 'claimed', data: {} });
    return u;
  });
}

async function release(id, agent, now = clock.now()) {
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (!t.assignee_id) throw new HttpError(409, 'Ticket is not assigned');
    if (t.assignee_id !== agent.id && agent.role !== 'manager') throw new HttpError(403, 'Only the assignee or a manager can release a ticket');
    if (!ACTIVE.includes(t.status)) throw new HttpError(409, `Ticket is ${t.status}`);
    const u = await updateTicket(c, id, { assignee_id: null, status: t.status === 'waiting_on_customer' ? t.status : 'open' });
    await appendEvent(c, { ticketId: id, at: now, actor: agentActor(agent), type: 'released', data: { previousAssigneeId: t.assignee_id } });
    return u;
  });
}

async function assign(id, agent, targetId, now = clock.now()) {
  if (agent.role !== 'manager') throw new HttpError(403, 'Only managers can reassign');
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (!ACTIVE.includes(t.status)) throw new HttpError(409, `Ticket is ${t.status}`);
    const a = await c.query('SELECT id, name FROM agents WHERE id=$1', [targetId]);
    if (!a.rows[0]) throw new HttpError(404, 'Agent not found');
    const u = await updateTicket(c, id, { assignee_id: targetId, status: t.status === 'waiting_on_customer' ? t.status : 'in_progress' });
    await appendEvent(c, { ticketId: id, at: now, actor: agentActor(agent), type: 'assigned', data: { from: t.assignee_id, to: targetId, toName: a.rows[0].name } });
    return u;
  });
}

async function reply(id, agent, { body, askCustomer = false }, now = clock.now()) {
  const h = await getHolidays();
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (t.assignee_id !== agent.id) throw new HttpError(409, t.assignee_id ? 'Only the assigned agent can reply. Claim the ticket first or add an internal note.' : 'Claim this ticket before replying.');
    if (t.status !== 'in_progress' && t.status !== 'waiting_on_customer') throw new HttpError(409, `Cannot reply: ticket is ${t.status}`);
    const m = await addMessage(c, t, { authorType: 'agent', agentId: agent.id, body, now });
    const fr = firstResponseFields(t, now, h);
    const fields = { ...fr.fields };
    let paused = false;
    if (askCustomer && t.status !== 'waiting_on_customer') {
      fields.status = 'waiting_on_customer';
      fields.paused_since = now;
      paused = true;
    }
    const u = await updateTicket(c, id, fields);
    await appendEvent(c, { ticketId: id, at: now, actor: agentActor(agent), type: 'reply_sent', data: { messageId: Number(m.id), ...fr.info, pausedSlaClock: paused } });
    return u;
  });
}

async function addNote(id, agent, body, now = clock.now()) {
  return tx(async (c) => {
    const t = await lockById(c, id);
    const r = await c.query('INSERT INTO internal_notes (ticket_id, agent_id, body, created_at) VALUES ($1,$2,$3,$4) RETURNING id', [id, agent.id, body, now]);
    // event deliberately carries no note text
    await appendEvent(c, { ticketId: t.id, at: now, actor: agentActor(agent), type: 'internal_note_added', data: { noteId: Number(r.rows[0].id) } });
  });
}

async function setPriority(id, agent, priority, now = clock.now()) {
  const h = await getHolidays();
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (!ACTIVE.includes(t.status)) throw new HttpError(409, `Ticket is ${t.status}`);
    if (t.priority === priority) return t;
    const before = sla.computeSla(t, now, h);
    const u = await updateTicket(c, id, { priority });
    const after = sla.computeSla(u, now, h);
    await appendEvent(c, {
      ticketId: id, at: now, actor: agentActor(agent), type: 'priority_changed',
      data: {
        from: t.priority, to: priority,
        rule: 'elapsed working time is kept; the new priority target is applied to the same clock',
        responseDueBefore: before.responseDue, responseDueAfter: after.responseDue,
        resolutionDueBefore: before.resolutionDue, resolutionDueAfter: after.resolutionDue,
        lateAfterChange: after.late,
      },
    });
    return u;
  });
}

async function resolve(id, agent, body, now = clock.now()) {
  const h = await getHolidays();
  return tx(async (c) => {
    const t = await lockById(c, id);
    if (t.assignee_id !== agent.id && agent.role !== 'manager') throw new HttpError(409, 'Only the assigned agent can resolve this ticket');
    if (t.status !== 'in_progress' && t.status !== 'waiting_on_customer') throw new HttpError(409, `Cannot resolve: ticket is ${t.status}`);
    let fields = {};
    let info = { firstResponse: false };
    if (body) {
      await addMessage(c, t, { authorType: 'agent', agentId: agent.id, body, now });
      const fr = firstResponseFields(t, now, h);
      fields = { ...fr.fields };
      info = fr.info;
    } else if (!t.first_response_at) {
      throw new HttpError(400, 'Add a message to the customer when resolving a ticket that has had no reply yet');
    }
    // close any open pause
    if (t.paused_since) {
      fields.paused_working_minutes = t.paused_working_minutes + sla.workingMinutesBetween(t.paused_since, now, h);
      fields.paused_since = null;
    }
    const merged = { ...t, ...fields, status: 'resolved', resolved_at: now };
    const breached = sla.computeSla({ ...merged, status: 'in_progress' }, now, h).resolutionBreached;
    const u = await updateTicket(c, id, { ...fields, status: 'resolved', resolved_at: now, resolution_breached: breached });
    await appendEvent(c, { ticketId: id, at: now, actor: agentActor(agent), type: 'resolved', data: { resolutionBreached: breached, withMessage: !!body, ...info } });
    return u;
  });
}

// ---------------------------------------------------------------- customer actions
async function customerReply(token, body, now = clock.now()) {
  const h = await getHolidays();
  return tx(async (c) => {
    const t = await lockByToken(c, token);
    if (t.status === 'resolved') throw new HttpError(409, 'This ticket is marked as resolved. You can reopen it if the problem is not fixed.', { code: 'RESOLVED' });
    if (t.status === 'closed') throw new HttpError(409, 'This ticket is closed. Please open a new ticket.', { code: 'CLOSED' });
    const m = await addMessage(c, t, { authorType: 'customer', body, now });
    const fields = {};
    let resumed = false;
    if (t.status === 'waiting_on_customer') {
      fields.paused_working_minutes = t.paused_working_minutes + sla.workingMinutesBetween(t.paused_since, now, h);
      fields.paused_since = null;
      fields.status = t.assignee_id ? 'in_progress' : 'open';
      resumed = true;
    }
    const u = Object.keys(fields).length ? await updateTicket(c, t.id, fields) : t;
    await appendEvent(c, { ticketId: t.id, at: now, actor: { type: 'customer', id: null, name: t.customer_name }, type: 'customer_replied', data: { messageId: Number(m.id), resumedSlaClock: resumed } });
    return u;
  });
}

async function reopen(token, body, now = clock.now()) {
  const h = await getHolidays();
  return tx(async (c) => {
    const t = await lockByToken(c, token);
    if (t.status !== 'resolved') throw new HttpError(409, t.status === 'closed' ? 'The reopen window has passed. Please open a new ticket.' : 'Only resolved tickets can be reopened', { code: t.status === 'closed' ? 'CLOSED' : 'NOT_RESOLVED' });
    const until = sla.addWorkingMinutes(t.resolved_at, sla.REOPEN_WINDOW_MIN, h);
    if (now.getTime() > until) throw new HttpError(409, 'The reopen window has passed. Please open a new ticket.', { code: 'CLOSED' });
    const m = await addMessage(c, t, { authorType: 'customer', body, now });
    const u = await updateTicket(c, t.id, {
      status: t.assignee_id ? 'in_progress' : 'open',
      resolved_at: null, resolution_breached: false,
      sla_start_at: now, first_response_at: null, response_breached: false,
      paused_since: null, paused_working_minutes: 0,
      reopen_count: t.reopen_count + 1,
    });
    await appendEvent(c, { ticketId: t.id, at: now, actor: { type: 'customer', id: null, name: t.customer_name }, type: 'reopened', data: { messageId: Number(m.id), previouslyResolvedAt: t.resolved_at.toISOString(), slaRestartedAt: now.toISOString() } });
    return u;
  });
}

// ---------------------------------------------------------------- background rules
async function runMaintenance(now = clock.now()) {
  const h = await getHolidays();
  let closed = 0;
  const cand = await pool.query("SELECT id FROM tickets WHERE status IN ('waiting_on_customer','resolved')");
  for (const { id } of cand.rows) {
    await tx(async (c) => {
      const t = await lockById(c, id);
      if (t.status === 'waiting_on_customer' && t.paused_since) {
        const due = sla.addWorkingMinutes(t.paused_since, sla.AUTO_CLOSE_MIN, h);
        if (now.getTime() >= due) {
          const breached = sla.computeSla(t, new Date(due), h).resolutionBreached;
          await updateTicket(c, id, { status: 'closed', closed_at: now, close_reason: 'no_customer_reply', resolution_breached: breached });
          await appendEvent(c, { ticketId: id, at: now, actor: sys, type: 'auto_closed', data: { reason: 'customer did not reply for 5 working days', dueAt: new Date(due).toISOString() } });
          closed++;
        }
      } else if (t.status === 'resolved') {
        const due = sla.addWorkingMinutes(t.resolved_at, sla.REOPEN_WINDOW_MIN, h);
        if (now.getTime() > due) {
          await updateTicket(c, id, { status: 'closed', closed_at: now, close_reason: 'reopen_window_elapsed' });
          await appendEvent(c, { ticketId: id, at: now, actor: sys, type: 'closed', data: { reason: 'reopen window (5 working days) elapsed', dueAt: new Date(due).toISOString() } });
          closed++;
        }
      }
    });
  }
  return closed;
}

module.exports = { createTicket, claim, release, assign, reply, addNote, setPriority, resolve, customerReply, reopen, runMaintenance, ACTIVE };
