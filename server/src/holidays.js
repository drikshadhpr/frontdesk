'use strict';
const { pool } = require('./db');
let cache = null;
let loadedAt = 0;
async function getHolidays() {
  if (cache && Date.now() - loadedAt < 60000) return cache;
  const r = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS d FROM holidays");
  cache = new Set(r.rows.map((x) => x.d));
  loadedAt = Date.now();
  return cache;
}
const invalidate = () => { cache = null; };
module.exports = { getHolidays, invalidate };
