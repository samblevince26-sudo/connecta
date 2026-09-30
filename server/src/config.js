require('dotenv').config();

const crypto = require('crypto');
const path = require('path');

function parseIceServers(raw) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!raw) return servers;
  // Format: turn:host:port?user=x&pass=y|turns:host2:port?user=x&pass=y
  for (const part of raw.split('|')) {
    const entry = part.trim();
    if (!entry) continue;
    const [urls, query] = entry.split('?');
    const server = { urls };
    if (query) {
      const params = new URLSearchParams(query);
      if (params.get('user')) server.username = params.get('user');
      if (params.get('pass')) server.credential = params.get('pass');
    }
    servers.push(server);
  }
  return servers;
}

// Static ICE servers (STUN by default, or whatever ICE_SERVERS provides).
const baseIceServers = parseIceServers(process.env.ICE_SERVERS);

// TURN relay using coturn's REST / shared-secret scheme. When configured, the
// server mints short-lived HMAC credentials per user instead of shipping a
// permanent password to every client.
const turn = {
  enabled: Boolean(process.env.TURN_HOST && process.env.TURN_SECRET),
  host: process.env.TURN_HOST || '',
  secret: process.env.TURN_SECRET || '',
  ttlSeconds: parseInt(process.env.TURN_TTL || '86400', 10),
  urls: [],
};

if (turn.enabled) {
  const host = turn.host;
  turn.urls = [
    `turn:${host}:3478`,
    `turn:${host}:3478?transport=tcp`,
    `turns:${host}:5349`,
  ];
}

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  dbDriver: (process.env.DB_DRIVER || 'sqlite').toLowerCase(),
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'connecta.sqlite'),
  databaseUrl: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '',
  rtc: { baseIceServers, turn },
  // Self-hosted LiveKit SFU for group calls. When url+key+secret are all set,
  // group calls route media through the SFU instead of a full WebRTC mesh.
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  },
};
config.livekit.enabled = Boolean(
  config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret
);

// --- File uploads -----------------------------------------------------------
// Local-disk storage by default (zero config, works on both DB drivers). To move
// to object storage later, swap server/src/storage.js — nothing else changes.
config.uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
config.maxUploadBytes = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '25', 10)) * 1024 * 1024;
config.allowedUploadMimes = (process.env.ALLOWED_UPLOAD_MIMES
  ? process.env.ALLOWED_UPLOAD_MIMES.split(',')
  : [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime',
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4',
      'application/pdf', 'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]
).map((s) => s.trim().toLowerCase()).filter(Boolean);

if ((config.dbDriver === 'postgres' || config.dbDriver === 'pg') && !config.databaseUrl) {
  throw new Error('DB_DRIVER=postgres requires SUPABASE_DB_URL (or DATABASE_URL) to be set.');
}

// Returns the ICE server list for a given user. With TURN enabled this embeds
// time-limited credentials (username = "<expiry>:<userId>", credential =
// base64(HMAC-SHA1(secret, username))) matching coturn's use-auth-secret scheme.
function getIceServers(userId) {
  const servers = [...baseIceServers];
  if (!turn.enabled) return servers;
  const expiry = Math.floor(Date.now() / 1000) + turn.ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac('sha1', turn.secret)
    .update(username)
    .digest('base64');
  for (const urls of turn.urls) servers.push({ urls, username, credential });
  return servers;
}

config.getIceServers = getIceServers;

if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'dev-insecure-secret-change-me') {
  throw new Error('JWT_SECRET must be set to a strong value in production.');
}

module.exports = config;
