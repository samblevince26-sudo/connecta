const express = require('express');
const db = require('./db');
const config = require('./config');
const storage = require('./storage');
const { signToken, requireAuth } = require('./auth');
const { isOnline } = require('./ws');

const router = express.Router();

function withUser(user) {
  return { ...user, online: isOnline(user.id) };
}

router.post('/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.]{3,10}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-10 chars: letters, numbers, dot, underscore.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const name = (displayName || username).trim();
  if (!name || name.length > 64) {
    return res.status(400).json({ error: 'Display name must be 1-64 characters.' });
  }
  try {
    const user = await db.createUser({ username, password, displayName: name });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await db.verifyCredentials(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = signToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: await db.getUserById(req.userId) });
});

router.get('/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  res.json({ users: (await db.searchUsers(q, req.userId)).map(withUser) });
});

// Search the caller's own DM + group message history. Results carry a `kind`
// ('dm' | 'group') plus the ids the client needs to jump to the match.
router.get('/search/messages', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  res.json({ results: await db.searchMessages(req.userId, q, limit) });
});

router.get('/contacts', requireAuth, async (req, res) => {
  res.json({ contacts: (await db.listContacts(req.userId)).map(withUser) });
});

router.post('/contacts', requireAuth, async (req, res) => {
  const { username, userId } = req.body || {};
  try {
    const contact = userId
      ? await db.addContact(req.userId, userId)
      : await db.addContactByUsername(req.userId, username || '');
    res.status(201).json({ contact: withUser(contact) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages/:peerId', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
  const messages = await db.getThread(req.userId, req.params.peerId, limit);
  res.json({ messages });
});

router.get('/conversations', requireAuth, async (req, res) => {
  const unread = await db.unreadCounts(req.userId);
  res.json({ unread });
});

router.get('/calls/history', requireAuth, async (req, res) => {
  res.json({ calls: await db.callHistory(req.userId) });
});

router.get('/groups', requireAuth, async (req, res) => {
  res.json({ groups: await db.listGroups(req.userId), unread: await db.groupUnreadCounts(req.userId) });
});

router.get('/groups/:id/messages', requireAuth, async (req, res) => {
  if (!(await db.isGroupMember(req.params.id, req.userId))) {
    return res.status(403).json({ error: 'Not a member of this group.' });
  }
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
  res.json({ messages: await db.getGroupMessages(req.params.id, limit) });
});

// --- File uploads -----------------------------------------------------------
// The client POSTs raw bytes (Content-Type = the file's mime, filename in the
// `name` query param). express.raw is scoped to this route only, so the global
// JSON parser is untouched. Returns metadata; the client then references
// `upload` on a message:send / groupmsg:send.
router.post('/uploads', requireAuth, express.raw({ type: '*/*', limit: config.maxUploadBytes }), async (req, res) => {
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!config.allowedUploadMimes.includes(mime)) {
    return res.status(415).json({ error: 'That file type is not allowed.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Empty upload.' });
  }
  const name = (String(req.query.name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180)) || 'file';
  const id = storage.newId();
  try {
    await storage.write(id, req.body);
    const upload = await db.createUpload({ id, ownerId: req.userId, name, mime, size: req.body.length });
    res.status(201).json({ upload });
  } catch (err) {
    await storage.remove(id);
    res.status(500).json({ error: 'Could not store the file.' });
  }
});

// Serves a stored file. Any authenticated user with the unguessable id can fetch
// it (capability-URL model); media elements load it via an authenticated fetch on
// the client, so the token never appears in a URL.
router.get('/uploads/:id', requireAuth, async (req, res) => {
  if (!storage.isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  const up = await db.getUpload(req.params.id);
  if (!up) return res.status(404).json({ error: 'Not found.' });
  const inline = /^(image|video|audio)\//.test(up.mime) || up.mime === 'application/pdf' || up.mime === 'text/plain';
  res.setHeader('Content-Type', up.mime);
  res.setHeader('Content-Length', up.size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${up.name.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  storage.readStream(up.id).pipe(res);
});

module.exports = router;
