import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtTime } from '../api.js';
import { Priority, Status, SlaFlags, Due } from '../components/Badges.jsx';

export default function TicketDetail({ agent }) {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('reply');
  const [text, setText] = useState('');
  const [ask, setAsk] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState([]);

  const load = useCallback(() => api(`/api/tickets/${id}`).then((d) => { setData(d); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); const i = setInterval(load, 20000); return () => clearInterval(i); }, [load]);
  useEffect(() => { if (agent.role === 'manager') api('/api/agents').then(setAgents).catch(() => {}); }, [agent.role]);

  async function act(path, body, after) {
    setBusy(true); setErr('');
    try { await api(`/api/tickets/${id}/${path}`, { method: 'POST', body }); if (after) after(); }
    catch (e) { setErr(e.message); }
    finally { await load(); setBusy(false); }
  }

  if (!data) return <p className={err ? 'error' : 'muted'}>{err || 'Loading...'}</p>;
  const { ticket: t, messages, internalNotes, events } = data;
  const active = ['open', 'in_progress', 'waiting_on_customer'].includes(t.status);
  const mine = t.assigneeId === agent.id;
  const thread = [
    ...messages.map((m) => ({ ...m, kind: m.from === 'customer' ? 'customer' : 'agent' })),
    ...internalNotes.map((n) => ({ ...n, kind: 'note' })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    if (mode === 'note') act('notes', { body: text }, () => setText(''));
    else act('reply', { body: text, askCustomer: ask }, () => { setText(''); setAsk(false); });
  }

  return (
    <div>
      <p><Link to="/agent">&larr; Tickets</Link></p>
      <div className="card">
        <div className="row">
          <h2>{t.ref} &middot; {t.subject}</h2>
          <div className="spacer" />
          <Priority p={t.priority} /> <Status s={t.status} /> <SlaFlags t={t} />
        </div>
        <p className="muted small">
          {t.customerName} &lt;{t.customerEmail}&gt; &middot; opened {fmtTime(t.createdAt)} &middot; assigned to <b>{t.assigneeName || 'nobody'}</b>
          {t.reopenCount > 0 && <> &middot; reopened {t.reopenCount}x</>}
        </p>
        {active && (
          <p className="sla">
            <Due t={t} /> &middot; Fix by {fmtTime(t.sla.resolutionDue)}
            {t.sla.waitingOnCustomer && <> &middot; <b>SLA clock paused</b> until customer replies (auto-closes {fmtTime(t.sla.autoCloseAt)})</>}
          </p>
        )}
        {t.status === 'resolved' && <p className="sla">Customer can reopen until {fmtTime(t.sla.reopenUntil)}</p>}
        {err && <p className="error">{err}</p>}
        {active && (
          <div className="actions">
            {!t.assigneeId && <button disabled={busy} onClick={() => act('claim')}>Take this ticket</button>}
            {t.assigneeId && (mine || agent.role === 'manager') && <button className="ghost" disabled={busy} onClick={() => act('release')}>Release</button>}
            {agent.role === 'manager' && (
              <select value="" onChange={(e) => e.target.value && act('assign', { agentId: Number(e.target.value) })}>
                <option value="">Assign to...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <select value={t.priority} disabled={busy} onChange={(e) => act('priority', { priority: e.target.value })}>
              <option value="urgent">Urgent</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
            {(mine || agent.role === 'manager') && t.assigneeId && (
              <button className="ok" disabled={busy} onClick={() => {
                const body = window.prompt(t.firstResponseAt ? 'Closing message to customer (optional):' : 'Message to customer (required):', '');
                if (body === null) return;
                act('resolve', body.trim() ? { body: body.trim() } : {});
              }}>Mark resolved</button>
            )}
          </div>
        )}
      </div>

      <div className="thread">
        {thread.map((m) => (
          <div key={`${m.kind}-${m.id}`} className={`msg ${m.kind}`}>
            <div className="meta">
              {m.kind === 'note' && <span className="badge note">INTERNAL NOTE - never shown to the customer</span>}
              <b>{m.authorName}</b> &middot; {fmtTime(m.at)}
            </div>
            <div className="body">{m.body}</div>
          </div>
        ))}
      </div>

      {active && (
        <form className="card composer" onSubmit={send}>
          <div className="tabs">
            <button type="button" className={mode === 'reply' ? 'tab on' : 'tab'} onClick={() => setMode('reply')}>Reply to customer</button>
            <button type="button" className={mode === 'note' ? 'tab on note-tab' : 'tab'} onClick={() => setMode('note')}>Internal note</button>
          </div>
          {mode === 'note' && <p className="notice">Only your team can see this note.</p>}
          {mode === 'reply' && !mine && <p className="notice">{t.assigneeId ? `Only ${t.assigneeName} can reply to the customer.` : 'Take the ticket to reply.'}</p>}
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'note' ? 'Write a note for the team...' : 'Write your reply...'} className={mode === 'note' ? 'note-area' : ''} />
          <div className="row">
            {mode === 'reply' && <label className="inline"><input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} /> I'm asking the customer a question (pause the SLA clock)</label>}
            <div className="spacer" />
            <button disabled={busy || !text.trim() || (mode === 'reply' && !mine)}>{mode === 'note' ? 'Add note' : 'Send reply'}</button>
          </div>
        </form>
      )}

      <p><button className="link" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide' : 'Show'} audit log ({events.length} events, tamper-evident)</button></p>
      {showLog && (
        <table className="log">
          <thead><tr><th>When (IST)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}><td>{fmtTime(e.at)}</td><td>{e.actorName}</td><td>{e.type}</td><td className="small muted"><code>{JSON.stringify(e.data)}</code></td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
