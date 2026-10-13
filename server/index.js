/**
 * Fellas Invitational — live scoring server.
 *
 *  HTTP  REST API under /api  (see routes.js, admin.js)
 *  WS    Live push on the same port: clients receive
 *        { type: 'scores_updated', pairing_id, match_no } and
 *        { type: 'tournament_updated' } and re-fetch the read models.
 *
 * Run:  node server/index.js   (PORT env overrides, default 3000)
 */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

require('./db'); // ensure schema exists
const db = require('./db');

// Auto-seed on first boot when the database is empty (e.g. fresh Render
// deploy with a new persistent disk). Safe: seed.js only wipes/reseeds the
// 2026 test tournament, and this only runs when no tournaments exist at all.
try {
  const count = db.prepare('SELECT COUNT(*) AS c FROM tournaments').get().c;
  if (count === 0) {
    console.log('Empty database detected — seeding 2026 test tournament...');
    require('./seed')().then(
      () => console.log('Auto-seed complete.'),
      (e) => console.error('Auto-seed failed:', e)
    );
  }
} catch (e) {
  console.error('Auto-seed check failed:', e.message);
}
const auth = require('./auth');
const routes = require('./routes');
const adminRoutes = require('./admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.sessionMiddleware);

// ------------------------------------------------------------- live bus
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
// Routes push updates through here (e.g. after saving scores).
app.locals.broadcast = broadcast;

// ------------------------------------------------------------------ API
app.use('/api', routes);
app.use('/api/admin', adminRoutes);

// --------------------------------------------------------------- static
// Frontend lives in public/ (Phase 6). Until then, a small status page.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) res.json({ ok: true, service: 'fellas-invitational-live', api: '/api/health' });
  });
});

// ------------------------------------------------------------------ boot
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  // Immediately orient the client; it then fetches REST read models.
  ws.send(JSON.stringify({ type: 'connected', clients: wsClients.size }));
});

server.listen(PORT, () => {
  console.log(`Fellas Invitational live server on http://localhost:${PORT}`);
  console.log(`WebSocket live sync ready (${wsClients.size} clients).`);
});
