import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtTime, ApiError } from '../api.js';

export default function CustomerTicket() {
  const { token } = useParams();
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api(`/api/public/tickets/${token}`, { auth: false }).then(setT).catch((e) => setErr(e.message)), [token]);
  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);

  async function post(path) {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try { setT(await api(`/api/public/tickets/${token}/${path}`, { method: 'POST', auth: false, body: { body: text } })); setText(''); }
    catch (e) { setErr(e.message); if (e instanceof ApiError) await load(); }
    finally { setBusy(false); }
  }

  if (!t) return <div className="card narrow"><p className={err ? 'error' : 'muted'}>{err || 'Loading...'}</p></div>;
  return (
    <div className="card narrow wide">
      <h1>{t.ref} &middot; {t.subject}</h1>
      <p><span className="badge st-open">{t.status}</span></p>
      <div className="thread">
        {t.messages.map((m, i) => (
          <div key={i} className={`msg ${m.from === 'you' ? 'customer' : 'agent'}`}>
            <div className="meta"><b>{m.from === 'you' ? 'You' : `${m.agentName || 'Support'} (Arvo Support)`}</b> &middot; {fmtTime(m.at)}</div>
            <div className="body">{m.body}</div>
          </div>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
      {t.canReply && (
        <form onSubmit={(e) => { e.preventDefault(); post('messages'); }}>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply..." />
          <button disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
      {t.canReopen && (
        <form onSubmit={(e) => { e.preventDefault(); post('reopen'); }}>
          <p>This ticket was marked as resolved. Not fixed? You can reopen it until <b>{fmtTime(t.reopenUntil)}</b>.</p>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="What is still wrong?" />
          <button disabled={busy || !text.trim()}>Reopen ticket</button>
        </form>
      )}
      {t.statusCode === 'closed' && (
        <p>This ticket is closed. <Link to={`/new?follows=${token}`}>Open a new ticket</Link> if you still need help.</p>
      )}
    </div>
  );
}
