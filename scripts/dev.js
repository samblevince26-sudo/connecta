'use strict';

// Zero-dependency launcher: starts the backend, waits until it is healthy, then
// opens either the Electron desktop app (default) or just the web PWA.
// Usage: node scripts/dev.js [desktop|web]

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mode = (process.argv[2] || 'desktop').toLowerCase();
const port = readPort();

function readPort() {
  try {
    const env = fs.readFileSync(path.join(root, 'server', '.env'), 'utf8');
    const m = env.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* no .env yet; use default */ }
  return 4000;
}

const children = [];
let shuttingDown = false;

function run(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (line.trim()) process.stdout.write(`[${label}] ${line}\n`);
    }
  };
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    process.stdout.write(`[${label}] exited with code ${code}\n`);
    if (!shuttingDown) shutdown(code === 0 ? 0 : 1);
  });
  children.push(child);
  return child;
}

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
      function retry() {
        if (Date.now() - started > timeoutMs) return reject(new Error('server did not become healthy in time'));
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  if (!fs.existsSync(path.join(root, 'server', '.env'))) {
    process.stdout.write('[dev] server/.env not found — copying from .env.example (set JWT_SECRET for production)\n');
    fs.copyFileSync(path.join(root, 'server', '.env.example'), path.join(root, 'server', '.env'));
  }
  if (!fs.existsSync(path.join(root, 'server', 'node_modules'))) {
    process.stdout.write('[dev] server deps missing — run "npm run setup" first.\n');
    process.exit(1);
  }

  process.stdout.write(`[dev] starting server on port ${port}...\n`);
  run('server', 'npm', ['start'], path.join(root, 'server'));

  try {
    await waitForHealth();
  } catch (err) {
    process.stdout.write(`[dev] ${err.message}\n`);
    shutdown(1);
    return;
  }

  const url = `http://localhost:${port}`;
  if (mode === 'web') {
    process.stdout.write(`[dev] server ready — open the PWA at ${url}\n`);
    process.stdout.write('[dev] press Ctrl+C to stop.\n');
    return;
  }

  if (!fs.existsSync(path.join(root, 'desktop', 'node_modules'))) {
    process.stdout.write('[dev] desktop deps missing — run "npm run setup" first.\n');
    process.stdout.write(`[dev] server is still running; you can open the PWA at ${url}\n`);
    return;
  }

  process.stdout.write('[dev] server ready — launching desktop app...\n');
  run('desktop', 'npm', ['start'], path.join(root, 'desktop'));
  process.stdout.write(`[dev] (the web PWA is also available at ${url})\n`);
})();
