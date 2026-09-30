'use strict';
// SFU (LiveKit) signaling test.
//
// Verifies the server hands group-call participants a LiveKit client config
// (url + room + a signed participant JWT) on create/join, and that the JWT
// carries the right room and identity. No media is exchanged here — that needs
// a browser + a running livekit-server, covered manually.

// config.js reads env at require time, so these must be set before helpers.
process.env.CONNECTA_TEST_SFU = '1';
process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880';
process.env.LIVEKIT_API_KEY = 'test-key';
process.env.LIVEKIT_API_SECRET = 'test-secret-test-secret-test-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

function decodeJwt(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  return payload;
}

test('group call create/join hand out a signed LiveKit SFU config', async () => {
  const ctx = await h.boot();
  try {
    const alice = await h.register('alice');
    const bob = await h.register('bob');
    const a = await h.connect(alice.token);
    const b = await h.connect(bob.token);

    a.send({ type: 'groupcall:create', kind: 'video' });
    const created = await a.wait((m) => m.type === 'groupcall:created');
    assert.ok(created.sfu, 'creator receives an sfu config');
    assert.equal(created.sfu.url, 'ws://127.0.0.1:7880');
    assert.equal(created.sfu.room, created.callId, 'room name is the call id');

    const grant = decodeJwt(created.sfu.token);
    assert.equal(grant.sub, alice.user.id, 'identity is the user id');
    assert.equal(grant.name, alice.user.displayName, 'display name lands in the token');
    assert.equal(grant.video.room, created.callId, 'grant is scoped to the room');
    assert.equal(grant.video.roomJoin, true);
    assert.equal(grant.video.canPublish, true);
    assert.equal(grant.video.canSubscribe, true);

    // Bob joins the same call and gets his own token for the same room.
    b.send({ type: 'groupcall:join', callId: created.callId });
    const joined = await b.wait((m) => m.type === 'groupcall:joined');
    assert.ok(joined.sfu, 'joiner receives an sfu config');
    assert.equal(joined.sfu.room, created.callId);
    const bGrant = decodeJwt(joined.sfu.token);
    assert.equal(bGrant.sub, bob.user.id, 'joiner token uses joiner identity');
    assert.notEqual(joined.sfu.token, created.sfu.token, 'tokens are per-user');

    a.close(); b.close();
  } finally {
    await h.teardown();
  }
});
