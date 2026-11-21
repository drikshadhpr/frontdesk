'use strict';
require('dotenv').config(); // loads .env from the project root if it exists
const { migrate, pool } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');
const { runMaintenance } = require('./tickets');

(async () => {
  await migrate();
  await seed();
  if (process.env.SEED_DEMO === 'true') await require('./seedDemo').seedDemo();
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Frontdesk listening on :${port}`));
  const tick = () => runMaintenance().catch((e) => console.error('maintenance failed', e));
  tick();
  setInterval(tick, 60_000);
  process.on('SIGTERM', () => pool.end().finally(() => process.exit(0)));
})().catch((e) => { console.error(e); process.exit(1); });