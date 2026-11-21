'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { pub, api } = require('./routes');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api/public', pub);
  app.use('/api', api);

  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
module.exports = { createApp };
