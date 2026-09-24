const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { attachWebSocketServer } = require('./ws');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// The same client code powers both the desktop app and the web PWA.
// Shared UI assets (app.js / styles.css) live with the desktop renderer.
const repoRoot = path.join(__dirname, '..', '..');
app.use('/assets', express.static(path.join(repoRoot, 'desktop', 'renderer')));
// PWA shell: index.html, manifest, service worker, icons.
app.use(express.static(path.join(repoRoot, 'web')));

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use('/api', routes);

// 404 for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = http.createServer(app);
const wss = attachWebSocketServer(server);

// Listen and resolve the actual bound port (0 yields an ephemeral one, used by tests).
function start(port = config.port, host = config.host) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      console.log(`Connecta server listening on http://${host}:${bound}`);
      console.log(`WebSocket signaling at ws://${host}:${bound}/ws`);
      resolve(bound);
    });
  });
}

// Close the WebSocket server (clears its heartbeat), the HTTP server, and the
// data layer (drains the Postgres pool / closes the SQLite handle) so the
// process can exit cleanly.
function stop() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      Promise.resolve()
        .then(() => (typeof db.close === 'function' ? db.close() : undefined))
        .catch(() => {})
        .then(resolve);
    };
    wss.close(() => server.close(finish));
    setTimeout(finish, 3000).unref();
  });
}

function shutdown() {
  console.log('\nShutting down...');
  stop().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
  start();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, server, wss, start, stop, shutdown };

