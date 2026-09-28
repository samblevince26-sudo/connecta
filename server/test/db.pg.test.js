'use strict';
// Postgres adapter integration test.
//
// This exercises server/src/db.pg.js against a LIVE Postgres/Supabase database.
// It is SKIPPED unless TEST_PG_URL is set, so the default `npm test` (which runs
// on ephemeral SQLite) stays green with no database present.
//
// To run it:
//   1. Start Postgres with the schema applied, e.g.
//        supabase start          # local Docker stack, auto-applies migrations
//      (or any Postgres where you've run supabase/migrations/0001_init.sql)
//   2. Point the test at it and run just this file:
//        TEST_PG_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//          node --test test/db.pg.test.js
//
// NOTE: the test writes rows and does not clean up; use a throwaway database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const PG_URL = process.env.TEST_PG_URL;
const rand = () => crypto.randomBytes(4).toString('hex');

test('postgres adapter: users, contacts, messages, groups round-trip',
  { skip: PG_URL ? false : 'set TEST_PG_URL to run the Postgres integration test' },
  async () => {
    // config.js/db.pg.js read env at require time.
    process.env.DB_DRIVER = 'postgres';
    process.env.SUPABASE_DB_URL = PG_URL;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef';
    const db = require('../src/db');

    try {
      // --- users -----------------------------------------------------------
      const alice = await db.createUser({ username: `alice_${rand()}`, password: 'password123', displayName: 'Alice' });
      const bob = await db.createUser({ username: `bob_${rand()}`, password: 'password123', displayName: 'Bob' });
      assert.ok(alice.id && bob.id, 'users get ids');
      assert.equal(alice.displayName, 'Alice');

      const verified = await db.verifyCredentials(alice.username, 'password123');
      assert.equal(verified.id, alice.id, 'login verifies password');
      assert.equal(await db.verifyCredentials(alice.username, 'wrong'), null, 'bad password rejected');

      // duplicate username -> message contains UNIQUE (routes.js maps to 409)
      await assert.rejects(
        () => db.createUser({ username: alice.username, password: 'password123', displayName: 'Dup' }),
        /UNIQUE/i
      );

      // --- contacts + 1:1 messages ----------------------------------------
      await db.addContact(alice.id, bob.id);
      assert.equal(await db.isContact(alice.id, bob.id), true, 'contact is mutual');
      assert.equal(await db.isContact(bob.id, alice.id), true);

      const m1 = await db.saveMessage({ senderId: alice.id, recipientId: bob.id, body: 'hi bob' });
      assert.equal(typeof m1.id, 'number', 'message id is a Number (bigint coerced)');
      assert.equal(m1.delivered, 0);

      let thread = await db.getThread(alice.id, bob.id);
      assert.equal(thread.length, 1);
      assert.equal(thread[0].body, 'hi bob');

      let unread = await db.unreadCounts(bob.id);
      assert.equal(unread[alice.id], 1, 'bob has 1 unread from alice');

      await db.markDelivered(bob.id, alice.id);
      await db.markRead(bob.id, alice.id);
      unread = await db.unreadCounts(bob.id);
      assert.equal(unread[alice.id] || 0, 0, 'read clears unread');
      thread = await db.getThread(alice.id, bob.id);
      assert.equal(thread[0].read, 1, 'read flag coerced to 1');

      // --- groups ----------------------------------------------------------
      const group = await db.createGroup({ name: 'Team', creatorId: alice.id, memberIds: [bob.id] });
      assert.equal(group.members.length, 2, 'creator + bob');
      assert.equal(await db.isGroupMember(group.id, bob.id), true);

      const gm = await db.saveGroupMessage({ groupId: group.id, senderId: alice.id, body: 'hey team' });
      assert.equal(typeof gm.id, 'number');
      assert.equal(await db.groupUnreadCount(group.id, bob.id), 1, 'bob has 1 group unread');
      await db.markGroupRead(group.id, bob.id, gm.id);
      assert.equal(await db.groupUnreadCount(group.id, bob.id), 0, 'group read clears unread');

      // --- search (DM + group, scoped, case-insensitive) --------------------
      const dmTok = 'zebra' + rand();
      await db.saveMessage({ senderId: alice.id, recipientId: bob.id, body: `find ${dmTok}` });
      const gTok = 'falcon' + rand();
      await db.saveGroupMessage({ groupId: group.id, senderId: alice.id, body: `meet ${gTok}` });

      const dmHits = await db.searchMessages(alice.id, dmTok.toUpperCase());
      assert.equal(dmHits.length, 1, 'dm search is case-insensitive (ILIKE)');
      assert.equal(dmHits[0].kind, 'dm');
      assert.equal(dmHits[0].peerId, bob.id);
      assert.equal(typeof dmHits[0].id, 'number', 'search id coerced to Number');

      const gHits = await db.searchMessages(bob.id, gTok);
      assert.equal(gHits.length, 1, 'group member finds the group message');
      assert.equal(gHits[0].kind, 'group');
      assert.equal(gHits[0].groupId, group.id);
      assert.equal(gHits[0].groupName, 'Team');

      const dave = await db.createUser({ username: `dave_${rand()}`, password: 'password123', displayName: 'Dave' });
      assert.equal((await db.searchMessages(dave.id, dmTok)).length, 0, 'no cross-user leakage');

      // --- attachments (media/file sharing) ---------------------------------
      const upId = crypto.randomBytes(16).toString('hex');
      const upload = await db.createUpload({ id: upId, ownerId: alice.id, name: 'photo.png', mime: 'image/png', size: 2048 });
      assert.equal(upload.id, upId);
      assert.equal(typeof upload.size, 'number', 'upload size coerced to Number (bigint)');
      assert.equal((await db.getUpload(upId)).mime, 'image/png', 'upload metadata round-trips');

      const att = { id: upId, name: 'photo.png', mime: 'image/png', size: 2048 };
      const mAtt = await db.saveMessage({ senderId: alice.id, recipientId: bob.id, body: '', attachment: att });
      assert.deepEqual(mAtt.attachment, att, 'attachment round-trips on a DM');
      const threadAtt = await db.getThread(alice.id, bob.id);
      assert.deepEqual(threadAtt.find((x) => x.id === mAtt.id).attachment, att, 'attachment persists across thread reload');

      const gAtt = await db.saveGroupMessage({ groupId: group.id, senderId: alice.id, body: 'look', attachment: att });
      assert.deepEqual(gAtt.attachment, att, 'attachment round-trips on a group message');
      const gMsgs = await db.getGroupMessages(group.id);
      assert.deepEqual(gMsgs.find((x) => x.id === gAtt.id).attachment, att, 'attachment persists in group history');

      // add + remove members; empty group auto-deletes
      const carol = await db.createUser({ username: `carol_${rand()}`, password: 'password123', displayName: 'Carol' });
      assert.equal(await db.addGroupMember(group.id, carol.id), true);
      assert.equal((await db.getGroup(group.id)).members.length, 3);
      await db.removeGroupMember(group.id, carol.id);
      await db.removeGroupMember(group.id, bob.id);
      await db.removeGroupMember(group.id, alice.id);
      assert.equal(await db.getGroup(group.id), null, 'empty group is deleted');

      // --- calls -----------------------------------------------------------
      const callId = await db.logCall({ callerId: alice.id, calleeId: bob.id, kind: 'video' });
      await db.endCall(callId, 'ended');
      const history = await db.callHistory(alice.id);
      assert.ok(history.some((c) => c.id === callId && c.status === 'ended'), 'call logged + ended');
    } finally {
      await db.close();
    }
  }
);
