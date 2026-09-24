'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(() => h.boot());
after(() => h.teardown());

test('group membership lifecycle: create, add, leave, remove, auto-delete', async () => {
  const alice = await h.register('alice', 'Alice');
  const bob = await h.register('bob', 'Bob');
  const carol = await h.register('carol', 'Carol');

  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);
  const c = await h.connect(carol.token);

  // create
  a.send({ type: 'group:create', name: 'Team', memberIds: [bob.user.id] });
  const createdA = await a.wait((m) => m.type === 'group:created');
  const createdB = await b.wait((m) => m.type === 'group:created');
  const gid = createdA.group.id;
  assert.equal(createdA.group.members.length, 2);
  assert.equal(createdA.group.createdBy, alice.user.id);
  assert.ok(createdB, 'bob also receives group:created');

  // add member
  a.send({ type: 'group:addmember', groupId: gid, userId: carol.user.id });
  const addedC = await c.wait((m) => m.type === 'group:member-added');
  await a.wait((m) => m.type === 'group:member-added');
  assert.equal(addedC.group.members.length, 3);

  // leave
  c.send({ type: 'group:leave', groupId: gid });
  const leftSelf = await c.wait((m) => m.type === 'group:left');
  const memberLeft = await a.wait((m) => m.type === 'group:member-left');
  assert.equal(leftSelf.groupId, gid);
  assert.equal(memberLeft.group.members.length, 2);
  assert.equal(memberLeft.leftUser.id, carol.user.id);

  // non-creator cannot remove
  b.send({ type: 'group:remove', groupId: gid, userId: alice.user.id });
  const errB = await b.wait((m) => m.type === 'error');
  assert.match(errB.error, /creator/i);

  // creator removes a member
  a.send({ type: 'group:remove', groupId: gid, userId: bob.user.id });
  const removedSelf = await b.wait((m) => m.type === 'group:removed');
  const memberRemoved = await a.wait((m) => m.type === 'group:member-removed');
  assert.equal(removedSelf.groupId, gid);
  assert.equal(memberRemoved.group.members.length, 1);
  assert.equal(memberRemoved.removedUser.id, bob.user.id);

  // last member leaves -> group deleted for everyone
  a.send({ type: 'group:leave', groupId: gid });
  await a.wait((m) => m.type === 'group:left');
  const aliceGroups = await h.api('/api/groups', { token: alice.token });
  const bobGroups = await h.api('/api/groups', { token: bob.token });
  assert.ok(!aliceGroups.groups.some((g) => g.id === gid), 'alice no longer sees the group');
  assert.ok(!bobGroups.groups.some((g) => g.id === gid), 'bob no longer sees the group');

  a.close(); b.close(); c.close();
});

test('group messaging + read state', async () => {
  const ann = await h.register('ann', 'Ann');
  const ben = await h.register('ben', 'Ben');
  const a = await h.connect(ann.token);
  const b = await h.connect(ben.token);

  a.send({ type: 'group:create', name: 'Chat', memberIds: [ben.user.id] });
  const created = await a.wait((m) => m.type === 'group:created');
  await b.wait((m) => m.type === 'group:created');
  const gid = created.group.id;

  a.send({ type: 'groupmsg:send', groupId: gid, body: 'hello team' });
  const msgB = await b.wait((m) => m.type === 'groupmsg:new');
  assert.equal(msgB.message.body, 'hello team');
  assert.equal(msgB.message.senderId, ann.user.id);

  const history = await h.api(`/api/groups/${gid}/messages`, { token: ben.token });
  assert.equal(history.messages.length, 1);

  // non-member is forbidden from reading history
  const cy = await h.register('cy', 'Cy');
  await assert.rejects(() => h.api(`/api/groups/${gid}/messages`, { token: cy.token }), /member/i);

  a.close(); b.close();
});
