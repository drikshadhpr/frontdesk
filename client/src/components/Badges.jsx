import React from 'react';
import { fmtTime } from '../api.js';

export const Priority = ({ p }) => <span className={`badge pr-${p}`}>{p}</span>;
const STATUS = { open: 'Open', in_progress: 'In progress', waiting_on_customer: 'Waiting on customer', resolved: 'Resolved', closed: 'Closed' };
export const Status = ({ s }) => <span className={`badge st-${s}`}>{STATUS[s] || s}</span>;

export function SlaFlags({ t }) {
  const s = t.sla;
  const terminal = t.status === 'resolved' || t.status === 'closed';
  return (
    <span className="flags">
      {s.late && <span className="badge late" title={s.lateReasons.join('; ')}>LATE{terminal ? ' (was)' : ''}</span>}
      {s.waitingOnCustomer && <span className="badge waiting" title={`SLA clock paused. Auto-closes ${fmtTime(s.autoCloseAt)}`}>Waiting on customer</span>}
    </span>
  );
}

export function Due({ t }) {
  const s = t.sla;
  if (t.status === 'resolved' || t.status === 'closed') return <span className="muted">-</span>;
  const label = t.firstResponseAt ? 'Fix by' : 'Reply by';
  const when = t.firstResponseAt ? s.resolutionDue : s.responseDue;
  const over = t.firstResponseAt ? s.resolutionBreached : s.responseBreached;
  return <span className={over ? 'over' : ''}>{label} {fmtTime(when)}</span>;
}
