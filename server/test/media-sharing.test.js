'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
before(async () => { ctx = await h.boot(); });
after(() => h.teardown());

// Raw-bytes upload (the client POSTs the file body with its mime as Content-Type).
function upload(token, name, mime, body) {
  return fetch(`${ctx.baseUrl}/api/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': mime },
    body,
  });
}

test('media sharing: upload, attach to a DM, deliver, and fetch bytes', async () => {
  const alice = await h.register('alice', 'Alice');
  const bob = await h.register('bob', 'Bob');
  const a = await h.connect(alice.token);
  const b = await h.connect(bob.token);

  // 1. Alice uploads a small text file.
  const upRes = await upload(alice.token, 'note.txt', 'text/plain', 'hello file');
  assert.equal(upRes.status, 201);
  const { upload: up } = await upRes.json();
  assert.equal(up.name, 'note.txt');
  assert.equal(up.mime, 'text/plain');
  assert.equal(up.size, 'hello file'.length);
  assert.match(up.id, /^[a-f0-9]{32}$/);

  // 2. Alice sends it as a DM attachment (empty body + attachment is allowed).
  a.send({ type: 'message:send', recipientId: bob.user.id, body: '', attachment: { id: up.id } });
  const got = await b.wait((m) => m.type === 'message:new');
  assert.equal(got.message.attachment.id, up.id);
  assert.equal(got.message.attachment.mime, 'text/plain');
  assert.equal(got.message.attachment.name, 'note.txt');

  // Sender gets its own copy back with the attachment.
  const sent = await a.wait((m) => m.type === 'message:sent');
  assert.equal(sent.message.attachment.id, up.id);

  // 3. Attachment persists in thread history.
  const thread = await h.api(`/api/messages/${bob.user.id}`, { token: alice.token });
  const withAtt = thread.messages.find((m) => m.attachment && m.attachment.id === up.id);
  assert.ok(withAtt, 'attachment survives a thread reload');

  // 4. Bob can fetch the bytes back (authenticated).
  const dl = await fetch(`${ctx.baseUrl}/api/uploads/${up.id}`, { headers: { authorization: 'Bearer ' + bob.token } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'text/plain');
  assert.equal(await dl.text(), 'hello file');

  a.close(); b.close();
});

test('media sharing: rejects bad mime, cross-user attach, and unauthenticated fetch', async () => {
  const alice = await h.register('alice2', 'Alice');
  const bob = await h.register('bob2', 'Bob');
  const b = await h.connect(bob.token);

  // Disallowed mime type -> 415.
  const bad = await upload(alice.token, 'evil.exe', 'application/x-msdownload', 'MZ');
  assert.equal(bad.status, 415);

  // A real upload owned by Alice.
  const okRes = await upload(alice.token, 'a.txt', 'text/plain', 'secret');
  const { upload: up } = await okRes.json();

  // Bob cannot attach Alice's upload to his own message.
  b.send({ type: 'message:send', recipientId: alice.user.id, body: 'x', attachment: { id: up.id } });
  const err = await b.wait((m) => m.type === 'error');
  assert.match(err.error, /did not upload/i);

  // Fetching without a token is unauthorized.
  const noAuth = await fetch(`${ctx.baseUrl}/api/uploads/${up.id}`);
  assert.equal(noAuth.status, 401);

  b.close();
});

test('media sharing: attachment in a group message reaches all members', async () => {
  const ann = await h.register('ann', 'Ann');
  const ben = await h.register('ben', 'Ben');
  const a = await h.connect(ann.token);
  const b = await h.connect(ben.token);

  a.send({ type: 'group:create', name: 'Crew', memberIds: [ben.user.id] });
  const created = await a.wait((m) => m.type === 'group:created');
  await b.wait((m) => m.type === 'group:created');
  const gid = created.group.id;

  const upRes = await upload(ann.token, 'pic.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { upload: up } = await upRes.json();

  a.send({ type: 'groupmsg:send', groupId: gid, body: 'look', attachment: { id: up.id } });
  const gm = await b.wait((m) => m.type === 'groupmsg:new');
  assert.equal(gm.message.attachment.id, up.id);
  assert.equal(gm.message.attachment.mime, 'image/png');

  // Group history carries the attachment too.
  const hist = await h.api(`/api/groups/${gid}/messages`, { token: ben.token });
  assert.ok(hist.messages.some((m) => m.attachment && m.attachment.id === up.id));

  a.close(); b.close();
});
