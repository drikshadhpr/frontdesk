'use strict';
const crypto = require('crypto');

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (prev, ev) =>
  crypto.createHash('sha256').update(prev + '|' + canonical([ev.ticketId, ev.at, ev.actorType, ev.actorId, ev.actorName, ev.type, ev.data])).digest('hex');

/** Caller must hold the ticket row lock so the chain is serialised. */
async function appendEvent(client, { ticketId, at, actor, type, data = {} }) {
  const prev = (await client.query('SELECT hash FROM ticket_events WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1', [ticketId])).rows[0];
  const prevHash = prev ? prev.hash : 'GENESIS';
  const atIso = at.toISOString();
  const ev = { ticketId, at: atIso, actorType: actor.type, actorId: actor.id ?? null, actorName: actor.name, type, data };
  const hash = hashOf(prevHash, ev);
  await client.query(
    `INSERT INTO ticket_events (ticket_id, at, actor_type, actor_id, actor_name, type, data, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ticketId, atIso, ev.actorType, ev.actorId, ev.actorName, type, JSON.stringify(data), prevHash, hash]
  );
}

async function verifyChain(client, ticketId) {
  const rows = (await client.query('SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY id', [ticketId])).rows;
  let prev = 'GENESIS';
  for (const r of rows) {
    const ev = { ticketId: r.ticket_id, at: r.at.toISOString(), actorType: r.actor_type, actorId: r.actor_id, actorName: r.actor_name, type: r.type, data: r.data };
    if (r.prev_hash !== prev || hashOf(prev, ev) !== r.hash) return { ok: false, brokenAtEventId: Number(r.id), events: rows.length };
    prev = r.hash;
  }
  return { ok: true, events: rows.length };
}

module.exports = { appendEvent, verifyChain };
