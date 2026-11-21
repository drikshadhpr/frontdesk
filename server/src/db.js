'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5433/frontdesk';
const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: url, ssl, max: 10 });

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query('SELECT pg_advisory_lock(424242)');
  try { await pool.query(sql); } finally { await pool.query('SELECT pg_advisory_unlock(424242)'); }
}

module.exports = { pool, tx, migrate };
