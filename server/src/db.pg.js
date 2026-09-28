// Postgres / Supabase data adapter.
//
// Exposes the SAME function interface as db.sqlite.js, but every function is
// async (returns a Promise). Call sites `await` the result, so the SQLite and
// Postgres drivers are interchangeable. Shape parity is deliberate: bigint ids
// and COUNT(*) come back from pg as strings and are coerced to Number, and the
// boolean delivered/read columns are returned as 0/1 to match SQLite.
//
// The schema lives in ../../supabase/migrations/0001_init.sql — apply it before
// running with DB_DRIVER=postgres.

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const config = require('./config');

// Supabase (and most managed Postgres) require TLS. Since pg 8.x, an
// `sslmode=require` in the connection string is parsed as `verify-full` AND
// overrides any explicit `ssl` option, which breaks against managed certs with
// a self-signed root in the chain. So: detect the requested sslmode, strip it
// from the URL, and pass our own `ssl` object instead. PG_REJECT_UNAUTHORIZED=1
// opts back into full certificate verification.
const SSLMODE_RE = /([?&])sslmode=[^&]*/i;
const wantsTls = SSLMODE_RE.test(config.databaseUrl);
const rejectUnauthorized = process.env.PG_REJECT_UNAUTHORIZED === '1';
const connectionString = config.databaseUrl.replace(SSLMODE_RE, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString,
  ssl: wantsTls ? { rejectUnauthorized } : undefined,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

function encAttachment(a) { return a ? JSON.stringify(a) : null; }
function decAttachment(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
}

const data = {
  async createUser({ username, password, displayName }) {
    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 12);
    try {
      await query(
        'INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, username.trim(), hash, displayName.trim(), Date.now()]
      );
    } catch (err) {
      // Normalize the unique-violation so routes.js reports 409 identically to
      // the SQLite driver (which throws a message containing "UNIQUE").
      if (err && err.code === '23505') {
        throw new Error('UNIQUE constraint failed: users.username');
      }
      throw err;
    }
    const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
    return publicUser(rows[0]);
  },

  async verifyCredentials(username, password) {
    const rows = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
    const row = rows[0];
    if (!row) return null;
    if (!bcrypt.compareSync(password, row.password_hash)) return null;
    return publicUser(row);
  },

  async getUserById(id) {
    const rows = await query('SELECT * FROM users WHERE id = $1', [id]);
    return publicUser(rows[0]);
  },

  async searchUsers(searchTerm, excludeId) {
    const q = `%${String(searchTerm).replace(/[%_]/g, '')}%`;
    const rows = await query(
      'SELECT id, username, display_name FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 20',
      [q, excludeId]
    );
    return rows.map(publicUser);
  },

  async addContact(ownerId, contactId) {
    if (ownerId === contactId) throw new Error('Cannot add yourself as a contact.');
    const target = await query('SELECT * FROM users WHERE id = $1', [contactId]);
    if (!target[0]) throw new Error('User not found.');
    const now = Date.now();
    // Mutual, idempotent.
    await query(
      'INSERT INTO contacts (owner_id, contact_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [ownerId, contactId, now]
    );
    await query(
      'INSERT INTO contacts (owner_id, contact_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [contactId, ownerId, now]
    );
    return publicUser(target[0]);
  },

  async addContactByUsername(ownerId, username) {
    const rows = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
    if (!rows[0]) throw new Error('User not found.');
    return data.addContact(ownerId, rows[0].id);
  },

  async listContacts(ownerId) {
    const rows = await query(
      `SELECT u.id, u.username, u.display_name
         FROM contacts c JOIN users u ON u.id = c.contact_id
        WHERE c.owner_id = $1
        ORDER BY lower(u.display_name)`,
      [ownerId]
    );
    return rows.map(publicUser);
  },

  async isContact(ownerId, contactId) {
    const rows = await query('SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_id = $2', [ownerId, contactId]);
    return rows.length > 0;
  },

  async saveMessage({ senderId, recipientId, body, attachment }) {
    const createdAt = Date.now();
    const rows = await query(
      'INSERT INTO messages (sender_id, recipient_id, body, created_at, attachment) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [senderId, recipientId, body, createdAt, encAttachment(attachment)]
    );
    return {
      id: Number(rows[0].id),
      senderId,
      recipientId,
      body,
      createdAt,
      delivered: 0,
      read: 0,
      attachment: attachment || null,
    };
  },

  async getThread(userA, userB, limit = 200) {
    const rows = await query(
      `SELECT id, sender_id, recipient_id, body, created_at, delivered, read, attachment
         FROM messages
        WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $3 AND recipient_id = $4)
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [userA, userB, userB, userA, limit]
    );
    return rows.reverse().map((m) => ({
      id: Number(m.id),
      senderId: m.sender_id,
      recipientId: m.recipient_id,
      body: m.body,
      createdAt: Number(m.created_at),
      delivered: m.delivered ? 1 : 0,
      read: m.read ? 1 : 0,
      attachment: decAttachment(m.attachment),
    }));
  },

  async markDelivered(recipientId, senderId) {
    await query(
      'UPDATE messages SET delivered = true WHERE recipient_id = $1 AND sender_id = $2 AND delivered = false',
      [recipientId, senderId]
    );
  },

  async markRead(recipientId, senderId) {
    await query(
      'UPDATE messages SET read = true WHERE recipient_id = $1 AND sender_id = $2 AND read = false',
      [recipientId, senderId]
    );
  },

  async unreadCounts(userId) {
    const rows = await query(
      'SELECT sender_id, COUNT(*)::int AS n FROM messages WHERE recipient_id = $1 AND read = false GROUP BY sender_id',
      [userId]
    );
    const out = {};
    for (const r of rows) out[r.sender_id] = r.n;
    return out;
  },

  async logCall({ callerId, calleeId, kind }) {
    const id = uuidv4();
    await query(
      'INSERT INTO calls (id, caller_id, callee_id, kind, status, started_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, callerId, calleeId, kind, 'ringing', Date.now()]
    );
    return id;
  },

  async endCall(id, status) {
    await query('UPDATE calls SET status = $1, ended_at = $2 WHERE id = $3', [status, Date.now(), id]);
  },

  async callHistory(userId, limit = 50) {
    const rows = await query(
      `SELECT id, caller_id, callee_id, kind, status, started_at, ended_at
         FROM calls
        WHERE caller_id = $1 OR callee_id = $2
        ORDER BY started_at DESC
        LIMIT $3`,
      [userId, userId, limit]
    );
    return rows.map((c) => ({
      id: c.id,
      callerId: c.caller_id,
      calleeId: c.callee_id,
      kind: c.kind,
      status: c.status,
      startedAt: Number(c.started_at),
      endedAt: c.ended_at == null ? null : Number(c.ended_at),
    }));
  },

  async createGroup({ name, creatorId, memberIds }) {
    const id = uuidv4();
    const now = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO groups (id, name, created_by, created_at) VALUES ($1,$2,$3,$4)',
        [id, name.trim(), creatorId, now]
      );
      await client.query(
        'INSERT INTO group_members (group_id, user_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, creatorId, now]
      );
      for (const uid of memberIds) {
        if (uid === creatorId) continue;
        await client.query(
          'INSERT INTO group_members (group_id, user_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [id, uid, now]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return data.getGroup(id);
  },

  async getGroup(id) {
    const rows = await query('SELECT * FROM groups WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) return null;
    const members = await query(
      `SELECT u.id, u.username, u.display_name
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
        ORDER BY lower(u.display_name)`,
      [id]
    );
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      members: members.map(publicUser),
    };
  },

  async isGroupMember(groupId, userId) {
    const rows = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    return rows.length > 0;
  },

  async addGroupMember(groupId, userId) {
    const g = await query('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (!g[0]) throw new Error('Group not found.');
    const u = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!u[0]) throw new Error('User not found.');
    if (await data.isGroupMember(groupId, userId)) return false;
    await query(
      'INSERT INTO group_members (group_id, user_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [groupId, userId, Date.now()]
    );
    return true;
  },

  async removeGroupMember(groupId, userId) {
    await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    const remaining = await query('SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1', [groupId]);
    if (remaining[0].n === 0) {
      await query('DELETE FROM groups WHERE id = $1', [groupId]);
      return null;
    }
    return data.getGroup(groupId);
  },

  async listGroups(userId) {
    const rows = await query(
      `SELECT g.id
         FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = $1
        ORDER BY g.created_at DESC`,
      [userId]
    );
    const groups = await Promise.all(rows.map((g) => data.getGroup(g.id)));
    return groups.filter(Boolean);
  },

  async saveGroupMessage({ groupId, senderId, body, attachment }) {
    const createdAt = Date.now();
    const rows = await query(
      'INSERT INTO group_messages (group_id, sender_id, body, created_at, attachment) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [groupId, senderId, body, createdAt, encAttachment(attachment)]
    );
    return { id: Number(rows[0].id), groupId, senderId, body, createdAt, attachment: attachment || null };
  },

  async getGroupMessages(groupId, limit = 200) {
    const rows = await query(
      `SELECT id, group_id, sender_id, body, created_at, attachment
         FROM group_messages
        WHERE group_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [groupId, limit]
    );
    return rows.reverse().map((m) => ({
      id: Number(m.id),
      groupId: m.group_id,
      senderId: m.sender_id,
      body: m.body,
      createdAt: Number(m.created_at),
      attachment: decAttachment(m.attachment),
    }));
  },

  async markGroupRead(groupId, userId, lastMsgId) {
    await query(
      `INSERT INTO group_reads (group_id, user_id, last_read_msg_id) VALUES ($1,$2,$3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_msg_id = EXCLUDED.last_read_msg_id`,
      [groupId, userId, lastMsgId]
    );
  },

  async groupUnreadCount(groupId, userId) {
    const rows = await query(
      `SELECT COUNT(*)::int AS n FROM group_messages gm
        WHERE gm.group_id = $1 AND gm.sender_id != $2
          AND gm.id > COALESCE((SELECT last_read_msg_id FROM group_reads gr
                                 WHERE gr.group_id = gm.group_id AND gr.user_id = $3), 0)`,
      [groupId, userId, userId]
    );
    return rows[0].n;
  },

  async groupUnreadCounts(userId) {
    const rows = await query(
      `SELECT g.id
         FROM groups g JOIN group_members m ON m.group_id = g.id
        WHERE m.user_id = $1`,
      [userId]
    );
    const out = {};
    for (const g of rows) out[g.id] = await data.groupUnreadCount(g.id, userId);
    return out;
  },

  // Mirrors db.sqlite.searchMessages. ILIKE for case-insensitive matching
  // (SQLite's LIKE is already case-insensitive for ASCII). NULL branches are
  // explicitly cast so the UNION ALL resolves column types. bigint ids and
  // created_at come back as strings and are coerced to Number.
  async searchMessages(userId, queryStr, limit = 50) {
    const q = `%${String(queryStr).replace(/[%_]/g, '')}%`;
    const rows = await query(
      `SELECT * FROM (
         SELECT 'dm' AS kind, m.id AS id, m.body AS body, m.created_at AS created_at,
                m.sender_id AS sender_id, m.recipient_id AS recipient_id,
                NULL::uuid AS group_id, NULL::text AS group_name
           FROM messages m
          WHERE (m.sender_id = $1 OR m.recipient_id = $1) AND m.body ILIKE $2
         UNION ALL
         SELECT 'group' AS kind, gm.id AS id, gm.body AS body, gm.created_at AS created_at,
                gm.sender_id AS sender_id, NULL::uuid AS recipient_id,
                gm.group_id AS group_id, g.name AS group_name
           FROM group_messages gm JOIN groups g ON g.id = gm.group_id
          WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = $3)
            AND gm.body ILIKE $2
       ) s ORDER BY created_at DESC LIMIT $4`,
      [userId, q, userId, limit]
    );
    return rows.map((r) => ({
      kind: r.kind,
      id: Number(r.id),
      body: r.body,
      createdAt: Number(r.created_at),
      senderId: r.sender_id,
      peerId: r.kind === 'dm' ? (r.sender_id === userId ? r.recipient_id : r.sender_id) : null,
      groupId: r.group_id,
      groupName: r.group_name,
    }));
  },

  async createUpload({ id, ownerId, name, mime, size }) {
    const createdAt = Date.now();
    await query(
      'INSERT INTO uploads (id, owner_id, name, mime, size, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, ownerId, name, mime, size, createdAt]
    );
    return { id, ownerId, name, mime, size, createdAt };
  },

  async getUpload(id) {
    const rows = await query(
      'SELECT id, owner_id, name, mime, size, created_at FROM uploads WHERE id = $1',
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return { id: r.id, ownerId: r.owner_id, name: r.name, mime: r.mime, size: Number(r.size), createdAt: Number(r.created_at) };
  },

  // Exposed so the server can drain the pool on shutdown.
  async close() {
    await pool.end();
  },
};

module.exports = data;
