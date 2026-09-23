const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered    INTEGER NOT NULL DEFAULT 0,
    read         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (sender_id, recipient_id, created_at);

  CREATE TABLE IF NOT EXISTS calls (
    id         TEXT PRIMARY KEY,
    caller_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages (group_id, created_at, id);

  CREATE TABLE IF NOT EXISTS group_reads (
    group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_msg_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
  );
`);

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

const stmts = {
  insertUser: db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  searchUsers: db.prepare(
    'SELECT id, username, display_name FROM users WHERE username LIKE ? AND id != ? LIMIT 20'
  ),
  addContact: db.prepare(
    'INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?, ?, ?)'
  ),
  listContacts: db.prepare(
    `SELECT u.id, u.username, u.display_name
       FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.owner_id = ?
      ORDER BY u.display_name COLLATE NOCASE`
  ),
  isContact: db.prepare(
    'SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)'
  ),
  thread: db.prepare(
    `SELECT id, sender_id, recipient_id, body, created_at, delivered, read
       FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ),
  markDelivered: db.prepare(
    'UPDATE messages SET delivered = 1 WHERE recipient_id = ? AND sender_id = ? AND delivered = 0'
  ),
  markRead: db.prepare(
    'UPDATE messages SET read = 1 WHERE recipient_id = ? AND sender_id = ? AND read = 0'
  ),
  unreadCounts: db.prepare(
    `SELECT sender_id, COUNT(*) AS n
       FROM messages
      WHERE recipient_id = ? AND read = 0
      GROUP BY sender_id`
  ),
  insertCall: db.prepare(
    'INSERT INTO calls (id, caller_id, callee_id, kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  updateCallStatus: db.prepare(
    'UPDATE calls SET status = ?, ended_at = ? WHERE id = ?'
  ),
  callHistory: db.prepare(
    `SELECT id, caller_id, callee_id, kind, status, started_at, ended_at
       FROM calls
      WHERE caller_id = ? OR callee_id = ?
      ORDER BY started_at DESC
      LIMIT ?`
  ),
  insertGroup: db.prepare(
    'INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)'
  ),
  groupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
  addGroupMember: db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)'
  ),
  listGroupsForUser: db.prepare(
    `SELECT g.id, g.name, g.created_by, g.created_at
       FROM groups g JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ?
      ORDER BY g.created_at DESC`
  ),
  groupMembers: db.prepare(
    `SELECT u.id, u.username, u.display_name
       FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY u.display_name COLLATE NOCASE`
  ),
  isGroupMember: db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
  ),
  insertGroupMessage: db.prepare(
    'INSERT INTO group_messages (group_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)'
  ),
  groupMessages: db.prepare(
    `SELECT id, group_id, sender_id, body, created_at
       FROM group_messages
      WHERE group_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ),
  setGroupRead: db.prepare(
    `INSERT INTO group_reads (group_id, user_id, last_read_msg_id) VALUES (?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_msg_id = excluded.last_read_msg_id`
  ),
  groupUnread: db.prepare(
    `SELECT COUNT(*) AS n FROM group_messages gm
      WHERE gm.group_id = ? AND gm.sender_id != ?
        AND gm.id > COALESCE((SELECT last_read_msg_id FROM group_reads gr
                               WHERE gr.group_id = gm.group_id AND gr.user_id = ?), 0)`
  ),
};

const data = {
  createUser({ username, password, displayName }) {
    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 12);
    stmts.insertUser.run(id, username.trim(), hash, displayName.trim(), Date.now());
    return publicUser(stmts.userById.get(id));
  },

  verifyCredentials(username, password) {
    const row = stmts.userByUsername.get(username.trim());
    if (!row) return null;
    if (!bcrypt.compareSync(password, row.password_hash)) return null;
    return publicUser(row);
  },

  getUserById(id) {
    return publicUser(stmts.userById.get(id));
  },

  searchUsers(query, excludeId) {
    const q = `%${String(query).replace(/[%_]/g, '')}%`;
    return stmts.searchUsers.all(q, excludeId).map(publicUser);
  },

  addContact(ownerId, contactId) {
    if (ownerId === contactId) throw new Error('Cannot add yourself as a contact.');
    const target = stmts.userById.get(contactId);
    if (!target) throw new Error('User not found.');
    stmts.addContact.run(ownerId, contactId, Date.now());
    // Make the relationship mutual so both sides see the thread.
    stmts.addContact.run(contactId, ownerId, Date.now());
    return publicUser(target);
  },

  addContactByUsername(ownerId, username) {
    const row = stmts.userByUsername.get(username.trim());
    if (!row) throw new Error('User not found.');
    return data.addContact(ownerId, row.id);
  },

  listContacts(ownerId) {
    return stmts.listContacts.all(ownerId).map(publicUser);
  },

  isContact(ownerId, contactId) {
    return Boolean(stmts.isContact.get(ownerId, contactId));
  },

  saveMessage({ senderId, recipientId, body }) {
    const createdAt = Date.now();
    const info = stmts.insertMessage.run(senderId, recipientId, body, createdAt);
    return {
      id: info.lastInsertRowid,
      senderId,
      recipientId,
      body,
      createdAt,
      delivered: 0,
      read: 0,
    };
  },

  getThread(userA, userB, limit = 200) {
    return stmts.thread
      .all(userA, userB, userB, userA, limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        recipientId: m.recipient_id,
        body: m.body,
        createdAt: m.created_at,
        delivered: m.delivered,
        read: m.read,
      }));
  },

  markDelivered(recipientId, senderId) {
    stmts.markDelivered.run(recipientId, senderId);
  },

  markRead(recipientId, senderId) {
    stmts.markRead.run(recipientId, senderId);
  },

  unreadCounts(userId) {
    const out = {};
    for (const r of stmts.unreadCounts.all(userId)) out[r.sender_id] = r.n;
    return out;
  },

  logCall({ callerId, calleeId, kind }) {
    const id = uuidv4();
    stmts.insertCall.run(id, callerId, calleeId, kind, 'ringing', Date.now());
    return id;
  },

  endCall(id, status) {
    stmts.updateCallStatus.run(status, Date.now(), id);
  },

  callHistory(userId, limit = 50) {
    return stmts.callHistory.all(userId, userId, limit).map((c) => ({
      id: c.id,
      callerId: c.caller_id,
      calleeId: c.callee_id,
      kind: c.kind,
      status: c.status,
      startedAt: c.started_at,
      endedAt: c.ended_at,
    }));
  },

  createGroup({ name, creatorId, memberIds }) {
    const id = uuidv4();
    const now = Date.now();
    const tx = db.transaction(() => {
      stmts.insertGroup.run(id, name.trim(), creatorId, now);
      stmts.addGroupMember.run(id, creatorId, now);
      for (const uid of memberIds) {
        if (uid !== creatorId) stmts.addGroupMember.run(id, uid, now);
      }
    });
    tx();
    return data.getGroup(id);
  },

  getGroup(id) {
    const row = stmts.groupById.get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      members: stmts.groupMembers.all(id).map(publicUser),
    };
  },

  isGroupMember(groupId, userId) {
    return Boolean(stmts.isGroupMember.get(groupId, userId));
  },

  listGroups(userId) {
    return stmts.listGroupsForUser.all(userId).map((g) => data.getGroup(g.id));
  },

  saveGroupMessage({ groupId, senderId, body }) {
    const createdAt = Date.now();
    const info = stmts.insertGroupMessage.run(groupId, senderId, body, createdAt);
    return { id: info.lastInsertRowid, groupId, senderId, body, createdAt };
  },

  getGroupMessages(groupId, limit = 200) {
    return stmts.groupMessages
      .all(groupId, limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        groupId: m.group_id,
        senderId: m.sender_id,
        body: m.body,
        createdAt: m.created_at,
      }));
  },

  markGroupRead(groupId, userId, lastMsgId) {
    stmts.setGroupRead.run(groupId, userId, lastMsgId);
  },

  groupUnreadCount(groupId, userId) {
    return stmts.groupUnread.get(groupId, userId, userId).n;
  },

  groupUnreadCounts(userId) {
    const out = {};
    for (const g of stmts.listGroupsForUser.all(userId)) {
      out[g.id] = data.groupUnreadCount(g.id, userId);
    }
    return out;
  },
};

module.exports = data;
