import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

export default function NewTicket() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [f, setF] = useState({ customerName: '', customerEmail: '', subject: '', body: '', priority: 'medium' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/api/public/tickets', { method: 'POST', auth: false, body: { ...f, followsToken: params.get('follows') || undefined } });
      nav(`/t/${r.token}`);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <div className="card narrow wide">
      <h1>Contact Arvo Support</h1>
      <form onSubmit={submit}>
        <label>Your name<input value={f.customerName} onChange={set('customerName')} required /></label>
        <label>Email<input type="email" value={f.customerEmail} onChange={set('customerEmail')} required /></label>
        <label>How serious is it?
          <select value={f.priority} onChange={set('priority')}>
            <option value="urgent">I cannot work at all</option>
            <option value="medium">Something is broken, but I can still work</option>
            <option value="low">A question or small request</option>
          </select>
        </label>
        <label>Subject<input value={f.subject} onChange={set('subject')} required maxLength={200} /></label>
        <label>Describe the problem<textarea rows={6} value={f.body} onChange={set('body')} required /></label>
        {err && <p className="error">{err}</p>}
        <button disabled={busy}>Submit</button>
      </form>
      <p className="muted small">Bookmark the page you land on after submitting - it is your private link to this ticket.</p>
    </div>
  );
}
