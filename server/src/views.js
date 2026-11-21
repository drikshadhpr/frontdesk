'use strict';
// Serializers. Customer-facing output is built from an explicit whitelist and
// takes only `messages` (never notes or events), so a private note cannot leak.
const sla = require('./sla');

const iso = (d) => (d ? new Date(d).toISOString() : null);

function agentTicket(t, h, now, assigneeName) {
  const s = sla.computeSla(t, now, h);
  return {
    id: t.id, ref: t.ref, subject: t.subject, priority: t.priority, status: t.status,
    customerName: t.customer_name, customerEmail: t.customer_email,
    assigneeId: t.assignee_id, assigneeName: assigneeName || null,
    createdAt: iso(t.created_at), firstResponseAt: iso(t.first_response_at), resolvedAt: iso(t.resolved_at), closedAt: iso(t.closed_at),
    closeReason: t.close_reason, reopenCount: t.reopen_count, followsTicketId: t.follows_ticket_id,
    sla: s,
  };
}

const CUSTOMER_STATUS = {
  open: 'Received', in_progress: 'In progress', waiting_on_customer: 'Waiting for your reply', resolved: 'Resolved', closed: 'Closed',
};

function customerTicket(t, messages, agentNames, h, now) {
  const s = sla.computeSla(t, now, h);
  return {
    ref: t.ref, subject: t.subject, status: CUSTOMER_STATUS[t.status], statusCode: t.status,
    createdAt: iso(t.created_at),
    messages: messages.map((m) => ({ from: m.author_type === 'customer' ? 'you' : 'support', agentName: m.author_type === 'agent' ? agentNames[m.agent_id] || 'Support' : null, body: m.body, at: iso(m.created_at) })),
    canReply: t.status === 'open' || t.status === 'in_progress' || t.status === 'waiting_on_customer',
    canReopen: t.status === 'resolved',
    reopenUntil: t.status === 'resolved' ? s.reopenUntil : null,
    closeReason: t.status === 'closed' ? t.close_reason : null,
  };
}

module.exports = { agentTicket, customerTicket };
