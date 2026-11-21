import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtTime } from '../api.js';
import { Priority, Status } from '../components/Badges.jsx';

export default function LateReport() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/reports/late').then(setRows).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="error">{err}</p>;
  if (!rows) return <p className="muted">Loading...</p>;
  return (
    <div>
      <h2>Late tickets</h2>
      <p className="muted">Every ticket that missed (or is missing) a reply or resolution deadline, with the events that explain why.</p>
      {rows.length === 0 && <p className="muted empty">No late tickets.</p>}
      {rows.map((t) => (
        <div className="card" key={t.id}>
          <div className="row">
            <b><Link to={`/agent/tickets/${t.id}`}>{t.ref}</Link> &middot; {t.subject}</b><div className="spacer" />
            <Priority p={t.priority} /> <Status s={t.status} />
          </div>
          <p className="small"><span className="badge late">{t.sla.lateReasons.join('; ')}</span> &nbsp; reply due {fmtTime(t.sla.responseDue)} &middot; fix due {fmtTime(t.sla.resolutionDue)} &middot; paused for {t.sla.pausedWorkingMinutes} working min &middot; assignee: {t.assigneeName || 'none'}</p>
          <ul className="small">
            {t.relevantEvents.map((e, i) => <li key={i}>{fmtTime(e.at)} - {e.actor_name}: {e.type.replace(/_/g, ' ')}{e.type === 'priority_changed' ? ` (${e.data.from} to ${e.data.to})` : ''}</li>)}
            {t.relevantEvents.length === 0 && <li>No agent reply recorded yet.</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}
