'use strict';
// Test harness: boots the real server on an ephemeral port against a throwaway
// SQLite DB, and provides register/connect helpers for WebSocket assertions.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

// config.js and db.js read the environment at require time, so this must run
// before ../src/index is loaded. Force the SQLite driver explicitly: a developer
// .env may set DB_DRIVER=postgres, and dotenv would otherwise route these unit
// tests at the live database. The Postgres adapter has its own integration test
// (db.pg.test.js) gated on TEST_PG_URL.
const tmpDb = path.join(os.tmpdir(), `connecta-test-${crypto.randomBytes(6).toString('hex')}.sqlite`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_FILE = tmpDb;
process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
// Default unit tests to the WebRTC mesh path. A developer .env may enable the
// LiveKit SFU, which would silently switch group calls over; sfu.test.js opts
// back in by setting CONNECTA_TEST_SFU=1 (and its own creds) before require.
if (process.env.CONNECTA_TEST_SFU !== '1') {
  process.env.LIVEKIT_URL = '';
  process.env.LIVEKIT_API_KEY = '';
  process.env.LIVEKIT_API_SECRET = '';
}

const { server, start, stop } = require('../src/index');

let baseUrl = '';
let wsUrl = '';

async function boot() {
  const port = await start(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  return { port, baseUrl, wsUrl };
}

async function teardown() {
  await stop();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmpDb + suffix, { force: true }); } catch { /* ignore */ }
  }
}

// One-shot HTTP request with keep-alive disabled so sockets close immediately
// and the test process can exit cleanly (global fetch/undici pools connections).
function api(pathname, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      baseUrl + pathname,
      {
        method,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          const json = text ? JSON.parse(text) : {};
          if (res.statusCode >= 400) {
            const err = new Error(json.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode; err.body = json;
            return reject(err);
          }
          resolve(json);
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Usernames must be unique and <=10 chars; callers pass a base and we add a
// short random suffix that keeps the total within the limit.
async function register(base, displayName) {
  const username = base + crypto.randomBytes(2).toString('hex');
  return api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'password123', displayName: displayName || base },
  });
}

// Connects a WebSocket, authenticates, and resolves once auth:ok arrives.
function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { const w = waiters[i]; waiters.splice(i, 1); w.resolve(m); }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    const client = {
      ws,
      inbox,
      send: (o) => ws.send(JSON.stringify(o)),
      // Resolves with the first message (already-seen or future) matching pred.
      wait: (pred, timeout = 4000) => new Promise((res, rej) => {
        const found = inbox.find(pred);
        if (found) return res(found);
        const t = setTimeout(() => rej(new Error('wait timeout')), timeout);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
      }),
      close: () => ws.close(),
    };
    client.wait((m) => m.type === 'auth:ok')
      .then(() => { clearTimeout(timer); resolve(client); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

const hasIce = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((s) => s && s.urls);

module.exports = { boot, teardown, api, register, connect, hasIce };
