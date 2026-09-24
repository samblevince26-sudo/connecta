'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(() => h.boot());
after(() => h.teardown());

test('1:1 call signaling: ring, accept, relay, guard, end', async () => {
  const alice = await h.register('calA', 'Alice');
  const bob = await h.register('calB', 'Bob');
  const carol = await h.register('calC', 'Carol');

  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);
  const c = await h.connect(carol.token);

  assert.ok(h.hasIce(a.inbox.find((m) => m.type === 'auth:ok').iceServers), 'auth:ok carries ICE servers');

  // initiate
  a.send({ type: 'call:initiate', calleeId: bob.user.id, kind: 'video' });
  const ringing = await a.wait((m) => m.type === 'call:ringing');
  const incoming = await b.wait((m) => m.type === 'call:incoming');
  const callId = ringing.callId;
  assert.equal(ringing.kind, 'video');
  assert.equal(incoming.callId, callId);
  assert.equal(incoming.caller.id, alice.user.id);
  assert.ok(h.hasIce(incoming.iceServers));

  // accept
  b.send({ type: 'call:accept', callId });
  const accepted = await a.wait((m) => m.type === 'call:accepted');
  assert.equal(accepted.callId, callId);
  assert.ok(h.hasIce(accepted.iceServers));

  // SDP relay both directions
  a.send({ type: 'call:signal', callId, signal: { sdp: 'offer' } });
  const sigB = await b.wait((m) => m.type === 'call:signal' && m.signal.sdp === 'offer');
  b.send({ type: 'call:signal', callId, signal: { sdp: 'answer' } });
  const sigA = await a.wait((m) => m.type === 'call:signal' && m.signal.sdp === 'answer');
  assert.ok(sigB && sigA);

  // ICE candidate relay
  a.send({ type: 'call:signal', callId, signal: { candidate: 'ice-1' } });
  const iceB = await b.wait((m) => m.type === 'call:signal' && m.signal.candidate === 'ice-1');
  assert.ok(iceB);

  // non-participant cannot inject
  c.send({ type: 'call:signal', callId, signal: { sdp: 'intruder' } });
  const errC = await c.wait((m) => m.type === 'error');
  assert.match(errC.error, /participant/i);

  // end
  a.send({ type: 'call:end', callId });
  const endedB = await b.wait((m) => m.type === 'call:ended');
  assert.equal(endedB.callId, callId);
  assert.equal(endedB.reason, 'ended');

  a.close(); b.close(); c.close();
});

test('1:1 call reject + offline callee', async () => {
  const alice = await h.register('rejA', 'Alice');
  const bob = await h.register('rejB', 'Bob');
  const dave = await h.register('rejD', 'Dave'); // registered but never connects

  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);

  a.send({ type: 'call:initiate', calleeId: bob.user.id, kind: 'audio' });
  const ring = await a.wait((m) => m.type === 'call:ringing');
  await b.wait((m) => m.type === 'call:incoming' && m.callId === ring.callId);
  b.send({ type: 'call:reject', callId: ring.callId, reason: 'busy' });
  const ended = await a.wait((m) => m.type === 'call:ended' && m.callId === ring.callId);
  assert.equal(ended.reason, 'busy');

  a.send({ type: 'call:initiate', calleeId: dave.user.id, kind: 'video' });
  const errOff = await a.wait((m) => m.type === 'error');
  assert.match(errOff.error, /offline/i);

  a.close(); b.close();
});

test('group call mesh signaling: create, invite, join roles, relay, teardown', async () => {
  const alice = await h.register('gA', 'Alice');
  const bob = await h.register('gB', 'Bob');
  const carol = await h.register('gC', 'Carol');
  const dave = await h.register('gD', 'Dave');

  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);
  const c = await h.connect(carol.token);
  const d = await h.connect(dave.token);

  a.send({ type: 'groupcall:create', kind: 'video' });
  const gc = await a.wait((m) => m.type === 'groupcall:created');
  const gcid = gc.callId;
  assert.deepEqual(gc.peers, []);

  a.send({ type: 'groupcall:invite', callId: gcid, userIds: [bob.user.id, carol.user.id] });
  const incB = await b.wait((m) => m.type === 'groupcall:incoming');
  const incC = await c.wait((m) => m.type === 'groupcall:incoming');
  assert.equal(incB.callId, gcid);
  assert.equal(incC.callId, gcid);
  assert.ok(h.hasIce(incB.iceServers));

  // bob joins: newest -> isNew, roster=[alice]
  b.send({ type: 'groupcall:join', callId: gcid });
  const joinedB = await b.wait((m) => m.type === 'groupcall:joined');
  const peerJoinedA = await a.wait((m) => m.type === 'groupcall:peer-joined');
  assert.equal(joinedB.isNew, true);
  assert.equal(joinedB.peers.length, 1);
  assert.equal(joinedB.peers[0].id, alice.user.id);
  assert.equal(peerJoinedA.peer.id, bob.user.id);

  // carol joins: newest -> roster=[alice,bob]; both existing notified
  c.send({ type: 'groupcall:join', callId: gcid });
  const joinedC = await c.wait((m) => m.type === 'groupcall:joined');
  await a.wait((m) => m.type === 'groupcall:peer-joined' && m.peer.id === carol.user.id);
  await b.wait((m) => m.type === 'groupcall:peer-joined' && m.peer.id === carol.user.id);
  assert.equal(joinedC.peers.length, 2);
  assert.ok(h.hasIce(joinedC.iceServers));

  // targeted signal relay
  b.send({ type: 'groupcall:signal', callId: gcid, to: carol.user.id, signal: { sdp: 'b-to-c' } });
  const gsig = await c.wait((m) => m.type === 'groupcall:signal' && m.from === bob.user.id && m.signal.sdp === 'b-to-c');
  assert.ok(gsig);

  // non-participant signal is dropped (dave never joined)
  d.send({ type: 'groupcall:signal', callId: gcid, to: carol.user.id, signal: { sdp: 'intruder' } });
  const gotIntruder = await c.wait((m) => m.type === 'groupcall:signal' && m.signal.sdp === 'intruder', 1000).catch(() => null);
  assert.equal(gotIntruder, null);

  // explicit leave notifies remaining peers
  b.send({ type: 'groupcall:leave', callId: gcid });
  const pl1 = await a.wait((m) => m.type === 'groupcall:peer-left' && m.peerId === bob.user.id);
  const pl2 = await c.wait((m) => m.type === 'groupcall:peer-left' && m.peerId === bob.user.id);
  assert.ok(pl1 && pl2);

  // socket disconnect removes the peer from the call
  c.close();
  const pl3 = await a.wait((m) => m.type === 'groupcall:peer-left' && m.peerId === carol.user.id, 5000);
  assert.ok(pl3);

  a.close(); b.close(); d.close();
});
