import React, { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
      setToken(r.token); onLogin(r.agent);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <div className="card narrow">
      <h1>Frontdesk</h1>
      <p className="muted">Agent sign in</p>
      <form onSubmit={submit}>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoFocus /></label>
        <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required /></label>
        {err && <p className="error">{err}</p>}
        <button disabled={busy}>Sign in</button>
      </form>
      <p className="muted small">Demo: meera@arvo.test (manager) or arjun@arvo.test, password <code>frontdesk123</code></p>
      <p className="small"><a href="/new">Customer? Open a ticket</a></p>
    </div>
  );
}
