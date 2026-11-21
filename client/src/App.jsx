import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Queue from './pages/Queue.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import LateReport from './pages/LateReport.jsx';
import NewTicket from './pages/NewTicket.jsx';
import CustomerTicket from './pages/CustomerTicket.jsx';

function AgentShell({ children, agent, onSignOut }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Frontdesk</div>
        <nav>
          <NavLink to="/agent">Tickets</NavLink>
          <NavLink to="/agent/late">Late report</NavLink>
        </nav>
        <div className="spacer" />
        <span className="who">{agent.name}{agent.role === 'manager' ? ' (manager)' : ''}</span>
        <button className="link" onClick={onSignOut}>Sign out</button>
      </header>
      <main>{children}</main>
    </div>
  );
}

function AgentApp() {
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(!!getToken());
  const nav = useNavigate();

  useEffect(() => {
    if (!getToken()) return;
    api('/api/me').then(setAgent).catch(() => {}).finally(() => setLoading(false));
    const off = () => setAgent(null);
    window.addEventListener('frontdesk:signout', off);
    return () => window.removeEventListener('frontdesk:signout', off);
  }, []);

  if (loading) return <p className="center muted">Loading...</p>;
  if (!agent) return <Login onLogin={(a) => { setAgent(a); nav('/agent'); }} />;
  return (
    <AgentShell agent={agent} onSignOut={() => { setToken(null); setAgent(null); }}>
      <Routes>
        <Route index element={<Queue agent={agent} />} />
        <Route path="tickets/:id" element={<TicketDetail agent={agent} />} />
        <Route path="late" element={<LateReport />} />
      </Routes>
    </AgentShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/agent" replace />} />
      <Route path="/agent/*" element={<AgentApp />} />
      <Route path="/new" element={<NewTicket />} />
      <Route path="/t/:token" element={<CustomerTicket />} />
      <Route path="*" element={<p className="center">Page not found</p>} />
    </Routes>
  );
}
