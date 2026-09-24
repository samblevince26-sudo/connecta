const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('./auth');
const db = require('./db');
const config = require('./config');

// userId -> Set<ws>
const connections = new Map();
// callId -> { callerId, calleeId }
const activeCalls = new Map();
// callId -> { kind, participants: Set<userId>, createdAt }
const groupCalls = new Map();

function addConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(userId);
}

function isOnline(userId) {
  return connections.has(userId) && connections.get(userId).size > 0;
}

function send(userId, message) {
  const set = connections.get(userId);
  if (!set) return false;
  const payload = JSON.stringify(message);
  let sent = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      sent = true;
    }
  }
  return sent;
}

function sendTo(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcastPresence(userId, online) {
  // Notify every contact of this user about the presence change.
  for (const contact of db.listContacts(userId)) {
    send(contact.id, { type: 'presence', userId, online });
  }
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.userId = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendTo(ws, { type: 'error', error: 'Invalid JSON.' });
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        sendTo(ws, { type: 'error', error: err.message || 'Server error.' });
      }
    });

    ws.on('close', () => {
      if (ws.userId) {
        removeFromGroupCalls(ws.userId);
        removeConnection(ws.userId, ws);
        if (!isOnline(ws.userId)) broadcastPresence(ws.userId, false);
      }
    });
  });

  // Heartbeat: drop dead sockets so presence stays accurate.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  interval.unref(); // never let the heartbeat alone hold the process open
  wss.on('close', () => clearInterval(interval));

  return wss;
}

function requireUser(ws) {
  if (!ws.userId) throw new Error('Not authenticated.');
  return ws.userId;
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'auth':
      return handleAuth(ws, msg);
    default:
      break;
  }
  // Everything below requires an authenticated socket.
  requireUser(ws);
  switch (msg.type) {
    case 'message:send':
      return handleSendMessage(ws, msg);
    case 'message:read':
      return handleMarkRead(ws, msg);
    case 'typing':
      return handleTyping(ws, msg);
    case 'call:initiate':
      return handleCallInitiate(ws, msg);
    case 'call:accept':
      return handleCallAccept(ws, msg);
    case 'call:reject':
      return handleCallReject(ws, msg);
    case 'call:signal':
      return handleCallSignal(ws, msg);
    case 'call:end':
      return handleCallEnd(ws, msg);
    case 'groupcall:create':
      return handleGroupCreate(ws, msg);
    case 'groupcall:invite':
      return handleGroupInvite(ws, msg);
    case 'groupcall:join':
      return handleGroupJoin(ws, msg);
    case 'groupcall:signal':
      return handleGroupSignal(ws, msg);
    case 'groupcall:leave':
      return handleGroupLeave(ws, msg);
    case 'group:create':
      return handleChatGroupCreate(ws, msg);
    case 'groupmsg:send':
      return handleGroupMsgSend(ws, msg);
    case 'group:read':
      return handleGroupRead(ws, msg);
    case 'group:addmember':
      return handleGroupAddMember(ws, msg);
    case 'group:leave':
      return handleChatGroupLeave(ws, msg);
    case 'group:remove':
      return handleGroupRemove(ws, msg);
    case 'presence:subscribe':
      return handlePresenceSubscribe(ws);
    default:
      return sendTo(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
  }
}

function handleAuth(ws, msg) {
  const payload = verifyToken(msg.token || '');
  if (!payload) return sendTo(ws, { type: 'auth:error', error: 'Invalid or expired token.' });
  const user = db.getUserById(payload.sub);
  if (!user) return sendTo(ws, { type: 'auth:error', error: 'User no longer exists.' });

  const firstSocket = !isOnline(user.id);
  ws.userId = user.id;
  addConnection(user.id, ws);
  sendTo(ws, { type: 'auth:ok', user, iceServers: config.getIceServers(user.id) });
  if (firstSocket) broadcastPresence(user.id, true);
}

function handleSendMessage(ws, msg) {
  const senderId = ws.userId;
  const recipientId = String(msg.recipientId || '');
  const body = String(msg.body || '').trim();
  if (!recipientId) throw new Error('recipientId is required.');
  if (!body) throw new Error('Message body cannot be empty.');
  if (body.length > 4000) throw new Error('Message too long (max 4000 characters).');
  if (!db.getUserById(recipientId)) throw new Error('Recipient not found.');

  const stored = db.saveMessage({ senderId, recipientId, body });
  const delivered = send(recipientId, { type: 'message:new', message: stored });
  if (delivered) {
    db.markDelivered(recipientId, senderId);
    stored.delivered = 1;
  }
  sendTo(ws, { type: 'message:sent', message: stored });
}

function handleMarkRead(ws, msg) {
  const userId = ws.userId;
  const peerId = String(msg.peerId || '');
  if (!peerId) return;
  db.markRead(userId, peerId);
  send(peerId, { type: 'message:read', byUserId: userId });
}

function handleTyping(ws, msg) {
  const userId = ws.userId;
  const peerId = String(msg.peerId || '');
  if (!peerId) return;
  send(peerId, { type: 'typing', userId, isTyping: Boolean(msg.isTyping) });
}

function handleCallInitiate(ws, msg) {
  const callerId = ws.userId;
  const calleeId = String(msg.calleeId || '');
  const kind = msg.kind === 'audio' ? 'audio' : 'video';
  const callee = db.getUserById(calleeId);
  if (!callee) throw new Error('Callee not found.');
  if (!isOnline(calleeId)) throw new Error('User is offline.');

  const callId = db.logCall({ callerId, calleeId, kind });
  activeCalls.set(callId, { callerId, calleeId });
  const caller = db.getUserById(callerId);
  send(calleeId, {
    type: 'call:incoming',
    callId,
    kind,
    caller: { id: caller.id, username: caller.username, displayName: caller.displayName },
    iceServers: config.getIceServers(calleeId),
  });
  sendTo(ws, { type: 'call:ringing', callId, calleeId, kind });
}

function handleCallAccept(ws, msg) {
  const callId = String(msg.callId || '');
  const call = activeCalls.get(callId);
  if (!call) throw new Error('Call no longer exists.');
  if (ws.userId !== call.calleeId) throw new Error('Not your call to accept.');
  send(call.callerId, { type: 'call:accepted', callId, iceServers: config.getIceServers(call.callerId) });
}

function handleCallReject(ws, msg) {
  const callId = String(msg.callId || '');
  const call = activeCalls.get(callId);
  if (!call) return;
  const reason = msg.reason || 'rejected';
  const other = ws.userId === call.callerId ? call.calleeId : call.callerId;
  db.endCall(callId, reason);
  activeCalls.delete(callId);
  send(other, { type: 'call:ended', callId, reason });
}

function handleCallSignal(ws, msg) {
  const callId = String(msg.callId || '');
  const call = activeCalls.get(callId);
  if (!call) return; // call already torn down
  const userId = ws.userId;
  const target = userId === call.callerId ? call.calleeId
    : userId === call.calleeId ? call.callerId
    : null;
  if (!target) throw new Error('Not a participant in this call.');
  send(target, { type: 'call:signal', callId, signal: msg.signal });
}

function handleCallEnd(ws, msg) {
  const callId = String(msg.callId || '');
  const call = activeCalls.get(callId);
  if (!call) return;
  db.endCall(callId, 'ended');
  activeCalls.delete(callId);
  const other = ws.userId === call.callerId ? call.calleeId : call.callerId;
  send(other, { type: 'call:ended', callId, reason: 'ended' });
}

function handlePresenceSubscribe(ws) {
  const userId = ws.userId;
  const statuses = {};
  for (const contact of db.listContacts(userId)) {
    statuses[contact.id] = isOnline(contact.id);
  }
  sendTo(ws, { type: 'presence:snapshot', statuses });
}

// ---------------------------------------------------------------------------
// Group calls (full mesh). Signaling is relayed per pair; media never touches
// the server. Offer direction is deterministic to avoid glare: the peer who
// JOINS last creates offers to everyone already in the call; existing members
// only answer.
// ---------------------------------------------------------------------------
function groupParticipantList(call, excludeId) {
  const out = [];
  for (const id of call.participants) {
    if (id === excludeId) continue;
    const u = db.getUserById(id);
    if (u) out.push(u);
  }
  return out;
}

function handleGroupCreate(ws, msg) {
  const kind = msg.kind === 'audio' ? 'audio' : 'video';
  const callId = uuidv4();
  groupCalls.set(callId, { kind, participants: new Set([ws.userId]), createdAt: Date.now() });
  sendTo(ws, { type: 'groupcall:created', callId, kind, peers: [] });
}

function handleGroupInvite(ws, msg) {
  const callId = String(msg.callId || '');
  const call = groupCalls.get(callId);
  if (!call) throw new Error('Group call not found.');
  if (!call.participants.has(ws.userId)) throw new Error('Not a participant.');
  const from = db.getUserById(ws.userId);
  const ids = Array.isArray(msg.userIds) ? msg.userIds.slice(0, 15) : [];
  for (const id of ids) {
    if (!isOnline(id)) continue;
    send(id, {
      type: 'groupcall:incoming',
      callId,
      kind: call.kind,
      from: { id: from.id, username: from.username, displayName: from.displayName },
      participantCount: call.participants.size,
      iceServers: config.getIceServers(id),
    });
  }
}

function handleGroupJoin(ws, msg) {
  const callId = String(msg.callId || '');
  const call = groupCalls.get(callId);
  if (!call) throw new Error('Group call not found or already ended.');
  const userId = ws.userId;
  const isNew = !call.participants.has(userId);
  const existing = groupParticipantList(call, userId);
  call.participants.add(userId);

  // Tell everyone already in the call that a new peer arrived. They wait for
  // the new peer's offer (no glare).
  for (const peer of existing) {
    send(peer.id, {
      type: 'groupcall:peer-joined',
      callId,
      peer: db.getUserById(userId),
      iceServers: config.getIceServers(peer.id),
    });
  }
  // The joiner gets the roster and is responsible for offering to each.
  sendTo(ws, {
    type: 'groupcall:joined',
    callId,
    kind: call.kind,
    peers: existing,
    iceServers: config.getIceServers(userId),
    isNew,
  });
}

function handleGroupSignal(ws, msg) {
  const callId = String(msg.callId || '');
  const call = groupCalls.get(callId);
  if (!call) return;
  const from = ws.userId;
  const to = String(msg.to || '');
  if (!call.participants.has(from) || !call.participants.has(to)) return;
  send(to, { type: 'groupcall:signal', callId, from, signal: msg.signal });
}

function removeFromGroupCalls(userId) {
  for (const [callId, call] of groupCalls) {
    if (!call.participants.has(userId)) continue;
    call.participants.delete(userId);
    for (const other of call.participants) {
      send(other, { type: 'groupcall:peer-left', callId, peerId: userId });
    }
    if (call.participants.size === 0) groupCalls.delete(callId);
  }
}

function handleGroupLeave(ws, msg) {
  const callId = String(msg.callId || '');
  const call = groupCalls.get(callId);
  if (!call) return;
  call.participants.delete(ws.userId);
  for (const other of call.participants) {
    send(other, { type: 'groupcall:peer-left', callId, peerId: ws.userId });
  }
  if (call.participants.size === 0) groupCalls.delete(callId);
}

// ---------------------------------------------------------------------------
// Group text chat
// ---------------------------------------------------------------------------
function handleChatGroupCreate(ws, msg) {
  const name = String(msg.name || '').trim();
  if (!name || name.length > 64) throw new Error('Group name must be 1-64 characters.');
  const memberIds = Array.isArray(msg.memberIds) ? msg.memberIds : [];
  for (const id of memberIds) {
    if (!db.getUserById(id)) throw new Error('One or more members do not exist.');
  }
  const group = db.createGroup({ name, creatorId: ws.userId, memberIds });
  for (const member of group.members) {
    send(member.id, { type: 'group:created', group });
  }
}

function handleGroupMsgSend(ws, msg) {
  const groupId = String(msg.groupId || '');
  const body = String(msg.body || '').trim();
  if (!groupId) throw new Error('groupId is required.');
  if (!body) throw new Error('Message body cannot be empty.');
  if (body.length > 4000) throw new Error('Message too long (max 4000 characters).');
  if (!db.isGroupMember(groupId, ws.userId)) throw new Error('Not a member of this group.');

  const message = db.saveGroupMessage({ groupId, senderId: ws.userId, body });
  const group = db.getGroup(groupId);
  for (const member of group.members) {
    send(member.id, { type: 'groupmsg:new', message });
  }
}

function handleGroupRead(ws, msg) {
  const groupId = String(msg.groupId || '');
  const lastMsgId = parseInt(msg.lastMsgId || '0', 10);
  if (!groupId || !db.isGroupMember(groupId, ws.userId)) return;
  db.markGroupRead(groupId, ws.userId, lastMsgId);
}

function handleGroupAddMember(ws, msg) {
  const groupId = String(msg.groupId || '');
  const userId = String(msg.userId || '');
  if (!db.isGroupMember(groupId, ws.userId)) throw new Error('Not a member of this group.');
  const added = db.addGroupMember(groupId, userId);
  const group = db.getGroup(groupId);
  const addedUser = db.getUserById(userId);
  // Broadcast the refreshed roster to every member, including the new one so
  // their client picks up the group live.
  for (const member of group.members) {
    send(member.id, { type: 'group:member-added', group, addedUser, added });
  }
}

function handleChatGroupLeave(ws, msg) {
  const groupId = String(msg.groupId || '');
  const userId = ws.userId;
  if (!db.isGroupMember(groupId, userId)) throw new Error('Not a member of this group.');
  const leavingUser = db.getUserById(userId);
  const group = db.removeGroupMember(groupId, userId);
  // Tell the leaver their client should drop the group.
  sendTo(ws, { type: 'group:left', groupId });
  // If the group still exists, push the refreshed roster to those who remain.
  if (group) {
    for (const member of group.members) {
      send(member.id, { type: 'group:member-left', group, leftUser: leavingUser });
    }
  }
}

function handleGroupRemove(ws, msg) {
  const groupId = String(msg.groupId || '');
  const targetId = String(msg.userId || '');
  const group = db.getGroup(groupId);
  if (!group) throw new Error('Group not found.');
  if (group.createdBy !== ws.userId) throw new Error('Only the group creator can remove members.');
  if (targetId === group.createdBy) throw new Error('The creator cannot be removed.');
  if (!db.isGroupMember(groupId, targetId)) throw new Error('That user is not a member.');

  const removedUser = db.getUserById(targetId);
  const refreshed = db.removeGroupMember(groupId, targetId);
  // Notify the removed user so their client drops the group.
  send(targetId, { type: 'group:removed', groupId, removedBy: ws.userId });
  if (refreshed) {
    for (const member of refreshed.members) {
      send(member.id, { type: 'group:member-removed', group: refreshed, removedUser });
    }
  }
}

module.exports = { attachWebSocketServer, isOnline };
