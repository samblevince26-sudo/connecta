const express = require('express');
const db = require('./db');
const { signToken, requireAuth } = require('./auth');
const { isOnline } = require('./ws');

const router = express.Router();

function withUser(user) {
  return { ...user, online: isOnline(user.id) };
}

router.post('/auth/register', (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_.]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: letters, numbers, dot, underscore.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const name = (displayName || username).trim();
  if (!name || name.length > 64) {
    return res.status(400).json({ error: 'Display name must be 1-64 characters.' });
  }
  try {
    const user = db.createUser({ username, password, displayName: name });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = db.verifyCredentials(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = signToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: db.getUserById(req.userId) });
});

router.get('/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  res.json({ users: db.searchUsers(q, req.userId).map(withUser) });
});

router.get('/contacts', requireAuth, (req, res) => {
  res.json({ contacts: db.listContacts(req.userId).map(withUser) });
});

router.post('/contacts', requireAuth, (req, res) => {
  const { username, userId } = req.body || {};
  try {
    const contact = userId
      ? db.addContact(req.userId, userId)
      : db.addContactByUsername(req.userId, username || '');
    res.status(201).json({ contact: withUser(contact) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages/:peerId', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
  const messages = db.getThread(req.userId, req.params.peerId, limit);
  res.json({ messages });
});

router.get('/conversations', requireAuth, (req, res) => {
  const unread = db.unreadCounts(req.userId);
  res.json({ unread });
});

router.get('/calls/history', requireAuth, (req, res) => {
  res.json({ calls: db.callHistory(req.userId) });
});

router.get('/groups', requireAuth, (req, res) => {
  res.json({ groups: db.listGroups(req.userId), unread: db.groupUnreadCounts(req.userId) });
});

router.get('/groups/:id/messages', requireAuth, (req, res) => {
  if (!db.isGroupMember(req.params.id, req.userId)) {
    return res.status(403).json({ error: 'Not a member of this group.' });
  }
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 500);
  res.json({ messages: db.getGroupMessages(req.params.id, limit) });
});

module.exports = router;
