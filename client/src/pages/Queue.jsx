import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtTime, getToken } from '../api.js';
import { Priority, Status, SlaFlags, Due } from '../components/Badges.jsx';

const TABS = [['mine', 'My tickets'], ['unassigned', 'Unassigned'], ['active', 'All active'], ['done', 'Resolved / closed']];

export default function Queue() {
  const [view, setView] = useState('mine');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => api(`/api/tickets?view=${view}`).then((r) => { setRows(r); setErr(''); }).catch((e) => setErr(e.message)), [view]);
  useEffect(() => { setRows(null); load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  async function exportCsv() {
    const r = await fetch('/api/tickets/export.csv', { headers: { Authorization: `Bearer ${getToken()}` } });
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tickets.csv'; a.click();
  }

  const lateCount = rows ? rows.filter((r) => r.sla.late && r.status !== 'resolved' && r.status !== 'closed').length : 0;
  return (
    <div>
      <div className="row">
        <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={view === k ? 'tab on' : 'tab'} onClick={() => setView(k)}>{l}</button>)}</div>
        <div className="spacer" />
        {lateCount > 0 && <span className="badge late">{lateCount} late</span>}
        <button className="ghost" onClick={exportCsv}>Export CSV</button>
      </div>
      {err && <p className="error">{err}</p>}
      {!rows ? <p className="muted">Loading...</p> : rows.length === 0 ? <p className="muted empty">Nothing here.</p> : (
        <table>
          <thead><tr><th>Ticket</th><th>Subject</th><th>Priority</th><th>Status</th><th>Next deadline</th><th>Agent</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={t.sla.late && t.status !== 'resolved' && t.status !== 'closed' ? 'row-late' : t.sla.waitingOnCustomer ? 'row-wait' : ''}>
                <td><Link to={`/agent/tickets/${t.id}`}>{t.ref}</Link></td>
                <td><Link to={`/agent/tickets/${t.id}`}>{t.subject}</Link><div className="muted small">{t.customerName}</div></td>
                <td><Priority p={t.priority} /></td>
                <td><Status s={t.status} /> <SlaFlags t={t} /></td>
                <td><Due t={t} /></td>
                <td>{t.assigneeName || <span className="muted">unassigned</span>}</td>
                <td className="muted small">{fmtTime(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
