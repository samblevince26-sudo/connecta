'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./helpers');

before(() => h.boot());
after(() => h.teardown());

const tok = () => crypto.randomBytes(4).toString('hex');

test('message search: DMs + groups, scoped to the caller, case-insensitive', async () => {
  const alice = await h.register('alice', 'Alice');
  const bob = await h.register('bob', 'Bob');
  const carol = await h.register('carol', 'Carol');

  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);

  // Unique tokens so we never match another test's fixtures.
  const dmTok = 'zebra' + tok();
  const replyTok = 'quartz' + tok();
  const groupTok = 'falcon' + tok();

  // DM both directions.
  a.send({ type: 'message:send', recipientId: bob.user.id, body: `hello ${dmTok}` });
  await b.wait((m) => m.type === 'message:new');
  b.send({ type: 'message:send', recipientId: alice.user.id, body: `hey ${replyTok}` });
  await a.wait((m) => m.type === 'message:new');

  // A group with a matching message.
  a.send({ type: 'group:create', name: 'Crew', memberIds: [bob.user.id] });
  const created = await a.wait((m) => m.type === 'group:created');
  await b.wait((m) => m.type === 'group:created');
  const gid = created.group.id;
  a.send({ type: 'groupmsg:send', groupId: gid, body: `meet at ${groupTok}` });
  await b.wait((m) => m.type === 'groupmsg:new');

  // Alice finds her outgoing DM by token; peerId points at Bob.
  const dmHit = await h.api(`/api/search/messages?q=${encodeURIComponent(dmTok)}`, { token: alice.token });
  assert.equal(dmHit.results.length, 1);
  assert.equal(dmHit.results[0].kind, 'dm');
  assert.equal(dmHit.results[0].peerId, bob.user.id);
  assert.equal(dmHit.results[0].senderId, alice.user.id);

  // Case-insensitive match on the same token.
  const upper = await h.api(`/api/search/messages?q=${encodeURIComponent(dmTok.toUpperCase())}`, { token: alice.token });
  assert.equal(upper.results.length, 1, 'search is case-insensitive');

  // Alice finds the group message; carries groupId + groupName.
  const gHit = await h.api(`/api/search/messages?q=${encodeURIComponent(groupTok)}`, { token: alice.token });
  assert.equal(gHit.results.length, 1);
  assert.equal(gHit.results[0].kind, 'group');
  assert.equal(gHit.results[0].groupId, gid);
  assert.equal(gHit.results[0].groupName, 'Crew');

  // Bob (also a participant) sees the same DM match, with peerId = Alice.
  const bobHit = await h.api(`/api/search/messages?q=${encodeURIComponent(dmTok)}`, { token: bob.token });
  assert.equal(bobHit.results.length, 1);
  assert.equal(bobHit.results[0].peerId, alice.user.id);

  // Carol is a stranger to all of it — no leakage.
  const carolDm = await h.api(`/api/search/messages?q=${encodeURIComponent(dmTok)}`, { token: carol.token });
  const carolGroup = await h.api(`/api/search/messages?q=${encodeURIComponent(groupTok)}`, { token: carol.token });
  assert.equal(carolDm.results.length, 0);
  assert.equal(carolGroup.results.length, 0);

  // Short queries are rejected client-side by returning empty (min length 2).
  const tooShort = await h.api('/api/search/messages?q=z', { token: alice.token });
  assert.deepEqual(tooShort.results, []);

  a.close(); b.close();
});
