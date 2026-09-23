const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { attachWebSocketServer } = require('./ws');

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
attachWebSocketServer(server);

server.listen(config.port, config.host, () => {
  console.log(`Connecta server listening on http://${config.host}:${config.port}`);
  console.log(`WebSocket signaling at ws://${config.host}:${config.port}/ws`);
});

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
