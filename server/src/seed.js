'use strict';
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const AGENTS = [
  ['Meera Nair', 'meera@arvo.test', 'manager'],
  ['Arjun Menon', 'arjun@arvo.test'], ['Divya Krishnan', 'divya@arvo.test'], ['Rahul Varma', 'rahul@arvo.test'],
  ['Sneha Pillai', 'sneha@arvo.test'], ['Anil Kumar', 'anil@arvo.test'], ['Fathima Beevi', 'fathima@arvo.test'],
  ['Joseph Mathew', 'joseph@arvo.test'], ['Lakshmi Iyer', 'lakshmi@arvo.test'],
];
// PLACEHOLDER list - Arvo must confirm its real festival calendar (editable by managers in the app).
const HOLIDAYS = [['2026-12-25', 'Christmas'], ['2027-01-26', 'Republic Day'], ['2027-04-14', 'Vishu'], ['2027-08-15', 'Independence Day']];

async function seed() {
  const pw = process.env.SEED_PASSWORD || 'frontdesk123';
  const hash = await bcrypt.hash(pw, 10);
  for (const [name, email, role] of AGENTS) {
    await pool.query('INSERT INTO agents (name,email,password_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING', [name, email, hash, role || 'agent']);
  }
  for (const [d, n] of HOLIDAYS) await pool.query('INSERT INTO holidays (day,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [d, n]);
}
module.exports = { seed };
