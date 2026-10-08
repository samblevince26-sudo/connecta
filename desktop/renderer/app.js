'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  serverUrl: 'http://localhost:4000',
  token: null,
  me: null,
  ws: null,
  wsReady: false,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  contacts: [],          // [{id, username, displayName, online}]
  groups: [],            // [{id, name, createdBy, members:[...]}]
  groupUnread: {},       // groupId -> unread count
  groupPreview: {},      // groupId -> last message preview text
  activeGroup: null,     // group object of the open group conversation
  presence: {},          // userId -> bool
  unread: {},            // userId -> count
  activePeer: null,      // user object of open conversation
  lastPreview: {},       // userId -> last message preview
  searchMode: 'people',  // 'people' | 'messages' — what the sidebar search targets
  reconnectTimer: null,
  typingTimer: null,
  peerTypingTimer: null,
  objectUrls: [],        // blob: URLs created for attachment media; revoked on conversation switch
  pendingAttachments: [],// uploads staged in the composer before sending
};

// Live call state.
const call = {
  pc: null,
  localStream: null,
  callId: null,
  kind: 'video',
  peer: null,
  isCaller: false,
  startedAt: null,
  timerId: null,
  incoming: null,        // pending incoming call info
};

// Group call state. Media runs either as a full mesh (one PeerConnection per
// remote participant) or, when the server hands us an SFU config, through the
// self-hosted LiveKit server (single uplink, server fans out).
const group = {
  active: false,
  callId: null,
  kind: 'video',
  localStream: null,
  peers: new Map(),      // userId -> { pc, stream, videoEl, tileEl, displayName, offeredByUs }
  incoming: null,        // pending incoming group invite
  pendingInvite: [],     // userIds to invite right after creating
  sfu: null,             // {url, room, token} from the server when LiveKit is enabled
  room: null,            // LiveKit Room instance while in SFU mode
};

function inAnyCall() { return Boolean(call.callId || group.active || call.incoming || group.incoming); }
function currentKind() { return group.active ? group.kind : call.kind; }
function currentLocalStream() { return group.active ? group.localStream : call.localStream; }

const $ = (id) => document.getElementById(id);
const el = {
  authScreen: $('auth-screen'), appScreen: $('app-screen'),
  loginForm: $('login-form'), registerForm: $('register-form'),
  serverUrl: $('server-url'), serverRow: $('server-row'), serverToggle: $('server-toggle'),
  authError: $('auth-error'),
  meName: $('me-name'), meAvatar: $('me-avatar'),
  contactList: $('contact-list'), connectionDot: $('connection-dot'),
  searchInput: $('search-input'), searchBtn: $('search-btn'), searchResults: $('search-results'),
  searchMode: $('search-mode'),
  emptyState: $('empty-state'), conversation: $('conversation'),
  peerName: $('peer-name'), peerStatus: $('peer-status'), peerAvatar: $('peer-avatar'),
  messages: $('messages'), messageInput: $('message-input'), sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'),
  typingIndicator: $('typing-indicator'),
  voiceBtn: $('voice-btn'), videoBtn: $('video-btn'),
  callOverlay: $('call-overlay'), remoteVideo: $('remote-video'), localVideo: $('local-video'),
  callStatus: $('call-status'), callTimer: $('call-timer'),
  muteBtn: $('mute-btn'), camBtn: $('cam-btn'), endCallBtn: $('end-call-btn'),
  incomingModal: $('incoming-modal'), incomingName: $('incoming-name'),
  incomingKind: $('incoming-kind'), incomingAvatar: $('incoming-avatar'),
  answerBtn: $('answer-btn'), declineBtn: $('decline-btn'),
  groupCallBtn: $('group-call-btn'), groupPickerModal: $('group-picker-modal'),
  pickerList: $('picker-list'), pickerCancel: $('picker-cancel'), pickerStart: $('picker-start'),
  remoteGrid: $('remote-grid'),
  groupList: $('group-list'), newGroupBtn: $('new-group-btn'),
  groupChatModal: $('group-chat-modal'), gcName: $('gc-name'),
  gcPickerList: $('gc-picker-list'), gcCancel: $('gc-cancel'), gcCreate: $('gc-create'),
  addMemberBtn: $('add-member-btn'), addMemberModal: $('add-member-modal'),
  addMemberList: $('add-member-list'), addMemberCancel: $('add-member-cancel'),
  leaveGroupBtn: $('leave-group-btn'), membersBtn: $('members-btn'),
  membersModal: $('members-modal'), membersList: $('members-list'),
  membersCancel: $('members-cancel'),
  toast: $('toast'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function apiBase() { return state.serverUrl.replace(/\/$/, '') + '/api'; }
function wsUrl() { return state.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'; }

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 3200);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(apiBase() + path, { ...options, headers });
  } catch {
    throw new Error(`Cannot reach a Connecta server at ${state.serverUrl}. Start the server or correct the Server address.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A static host (e.g. the published PWA shell) answers 404 with HTML
    // because it has no API; say so instead of a bare status code.
    if (res.status === 404 && !data.error) {
      throw new Error(`No Connecta API at ${state.serverUrl}. Point the Server field at your backend, e.g. http://localhost:4000.`);
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Credential persistence. In Electron this uses the OS keychain via the preload
// bridge; in a plain browser (PWA) it falls back to localStorage.
const credStore = {
  get native() { return typeof window !== 'undefined' && window.connecta; },
  async save(payload) {
    if (this.native) return this.native.saveCredentials(payload);
    localStorage.setItem('connecta.creds', JSON.stringify(payload));
    return { ok: true, encrypted: false };
  },
  async load() {
    if (this.native) return this.native.loadCredentials();
    try { return JSON.parse(localStorage.getItem('connecta.creds')) || null; }
    catch { return null; }
  },
  async clear() {
    if (this.native) return this.native.clearCredentials();
    localStorage.removeItem('connecta.creds');
    return { ok: true };
  },
  async info() {
    if (this.native) return this.native.appInfo().catch(() => null);
    return null;
  },
};

// Simple WebAudio ringtone (no asset needed).
let ringCtx = null, ringOsc = null;
function playRingtone() {
  try {
    ringCtx = ringCtx || new AudioContext();
    if (ringOsc) return;
    ringOsc = ringCtx.createOscillator();
    const gain = ringCtx.createGain();
    gain.gain.value = 0.08;
    ringOsc.type = 'sine';
    ringOsc.frequency.value = 440;
    const lfo = ringCtx.createOscillator();
    const lfoGain = ringCtx.createGain();
    lfo.frequency.value = 2; lfoGain.gain.value = 60;
    lfo.connect(lfoGain); lfoGain.connect(ringOsc.frequency);
    ringOsc.connect(gain); gain.connect(ringCtx.destination);
    ringOsc.start(); lfo.start();
    ringOsc._lfo = lfo;
  } catch { /* audio unavailable */ }
}
function stopRingtone() {
  try {
    if (ringOsc) { ringOsc.stop(); ringOsc._lfo && ringOsc._lfo.stop(); ringOsc = null; }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------
function showAuth() {
  el.appScreen.classList.add('hidden');
  el.authScreen.classList.remove('hidden');
}
function showApp() {
  el.authScreen.classList.add('hidden');
  el.appScreen.classList.remove('hidden');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    el.loginForm.classList.toggle('hidden', !isLogin);
    el.registerForm.classList.toggle('hidden', isLogin);
    el.authError.textContent = '';
  });
});

// The server address is auto-detected at boot; reveal the field only on demand.
el.serverToggle.addEventListener('click', (e) => {
  e.preventDefault();
  el.serverRow.classList.toggle('hidden');
});

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.authError.textContent = '';
  state.serverUrl = el.serverUrl.value.trim();
  try {
    const { token, user } = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('login-username').value.trim(), password: $('login-password').value }),
    });
    await afterAuth(token, user);
  } catch (err) { el.authError.textContent = err.message; }
});

el.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.authError.textContent = '';
  state.serverUrl = el.serverUrl.value.trim();
  try {
    const { token, user } = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('reg-username').value.trim(),
        displayName: $('reg-display').value.trim(),
        password: $('reg-password').value,
        email: $('reg-email').value.trim() || undefined,
      }),
    });
    await afterAuth(token, user);
  } catch (err) { el.authError.textContent = err.message; }
});

async function afterAuth(token, user) {
  state.token = token;
  state.me = user;
  el.meName.textContent = user.displayName;
  el.meAvatar.textContent = initials(user.displayName);
  showApp();
  connectWebSocket();
  await loadContacts();
  await loadGroups();
  credStore.save({ serverUrl: state.serverUrl, token, user });
}

$('logout-btn').addEventListener('click', async () => {
  if (group.active) leaveGroupCall();
  if (call.callId) teardownCall('ended');
  if (state.ws) state.ws.close();
  state.token = null; state.me = null; state.contacts = []; state.activePeer = null;
  await credStore.clear();
  el.contactList.innerHTML = '';
  closeConversation();
  showAuth();
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  });

  ws.addEventListener('message', (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    onWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.wsReady = false;
    el.connectionDot.classList.remove('connected');
    if (state.token) scheduleReconnect();
  });

  ws.addEventListener('error', () => { /* close handler will reconnect */ });
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => { if (state.token) connectWebSocket(); }, 2500);
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function onWsMessage(msg) {
  switch (msg.type) {
    case 'auth:ok':
      state.wsReady = true;
      el.connectionDot.classList.add('connected');
      if (msg.iceServers) state.iceServers = msg.iceServers;
      wsSend({ type: 'presence:subscribe' });
      break;
    case 'auth:error':
      toast(msg.error || 'Session expired', true);
      state.token = null;
      showAuth();
      break;
    case 'presence:snapshot':
      state.presence = msg.statuses || {};
      renderContacts();
      updatePeerStatus();
      break;
    case 'presence':
      state.presence[msg.userId] = msg.online;
      renderContacts();
      updatePeerStatus();
      break;
    case 'message:new':
      handleIncomingMessage(msg.message);
      break;
    case 'message:sent':
      // Echo of our own message (already rendered optimistically is avoided;
      // we render on receipt to keep single source of truth).
      appendMessage(msg.message);
      break;
    case 'message:read':
      markThreadRead(msg.byUserId);
      break;
    case 'typing':
      showPeerTyping(msg.userId, msg.isTyping);
      break;
    case 'call:incoming':
      onIncomingCall(msg);
      break;
    case 'call:ringing':
      call.callId = msg.callId;
      setCallStatus('Ringing…');
      break;
    case 'call:accepted':
      onCallAccepted(msg);
      break;
    case 'call:signal':
      onCallSignal(msg);
      break;
    case 'call:ended':
      onRemoteCallEnd(msg.reason);
      break;
    case 'groupcall:created':
      onGroupCreated(msg);
      break;
    case 'groupcall:incoming':
      onGroupIncoming(msg);
      break;
    case 'groupcall:joined':
      onGroupJoined(msg);
      break;
    case 'groupcall:peer-joined':
      onGroupPeerJoined(msg);
      break;
    case 'groupcall:signal':
      onGroupSignal(msg);
      break;
    case 'groupcall:peer-left':
      onGroupPeerLeft(msg);
      break;
    case 'group:created':
      onChatGroupCreated(msg);
      break;
    case 'groupmsg:new':
      onGroupMessage(msg.message);
      break;
    case 'group:member-added':
      onGroupMemberAdded(msg);
      break;
    case 'group:member-left':
      onGroupMemberLeft(msg);
      break;
    case 'group:member-removed':
      onGroupMemberRemoved(msg);
      break;
    case 'group:left':
      onGroupLeftOrRemoved(msg.groupId, 'You left the group.');
      break;
    case 'group:removed':
      onGroupLeftOrRemoved(msg.groupId, 'You were removed from the group.');
      break;
    case 'error':
      toast(msg.error, true);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Contacts & search
// ---------------------------------------------------------------------------
async function loadContacts() {
  const { contacts } = await api('/contacts');
  state.contacts = contacts;
  for (const c of contacts) if (c.online != null) state.presence[c.id] = c.online;
  const { unread } = await api('/conversations');
  state.unread = unread || {};
  renderContacts();
}

function renderContacts() {
  el.contactList.innerHTML = '';
  const sorted = [...state.contacts].sort((a, b) => {
    const ua = state.unread[a.id] ? 1 : 0, ub = state.unread[b.id] ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return a.displayName.localeCompare(b.displayName);
  });
  for (const c of sorted) {
    const online = Boolean(state.presence[c.id]);
    const li = document.createElement('li');
    li.className = 'contact' + (state.activePeer && state.activePeer.id === c.id ? ' active' : '');
    li.innerHTML = `
      <div class="avatar">${escapeHtml(initials(c.displayName))}</div>
      <div class="presence-dot ${online ? 'online' : ''}"></div>
      <div class="c-info">
        <div class="c-name">${escapeHtml(c.displayName)}</div>
        <div class="c-preview">${escapeHtml(state.lastPreview[c.id] || (online ? 'Online' : 'Offline'))}</div>
      </div>
      ${state.unread[c.id] ? `<span class="badge">${state.unread[c.id]}</span>` : ''}`;
    li.addEventListener('click', () => openConversation(c));
    el.contactList.appendChild(li);
  }
}

async function doSearch() {
  const q = el.searchInput.value.trim();
  if (q.length < 2) { el.searchResults.classList.add('hidden'); return; }
  if (state.searchMode === 'messages') return searchMessages(q);
  return searchPeople(q);
}

async function searchPeople(q) {
  try {
    const { users } = await api('/users/search?q=' + encodeURIComponent(q));
    el.searchResults.innerHTML = '';
    if (!users.length) {
      el.searchResults.innerHTML = '<div class="search-result"><small>No users found</small></div>';
    }
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'search-result';
      row.innerHTML = `
        <div class="sr-info">
          <div class="avatar">${escapeHtml(initials(u.displayName))}</div>
          <div><div>${escapeHtml(u.displayName)}</div><small>@${escapeHtml(u.username)}</small></div>
        </div>`;
      const btn = document.createElement('button');
      btn.className = 'btn';
      const already = state.contacts.some((c) => c.id === u.id);
      btn.textContent = already ? 'Added' : 'Add';
      btn.disabled = already;
      btn.addEventListener('click', () => addContact(u));
      row.appendChild(btn);
      el.searchResults.appendChild(row);
    }
    el.searchResults.classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

// Snippet of the matched body with the query term wrapped in <mark>.
function highlight(body, q) {
  const safe = escapeHtml(body);
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return safe.length > 90 ? safe.slice(0, 90) + '…' : safe;
  const from = Math.max(0, idx - 30);
  const slice = body.slice(from, idx + q.length + 40);
  const lead = from > 0 ? '…' : '';
  const before = escapeHtml(slice.slice(0, idx - from));
  const match = escapeHtml(slice.slice(idx - from, idx - from + q.length));
  const after = escapeHtml(slice.slice(idx - from + q.length));
  return `${lead}${before}<mark>${match}</mark>${after}`;
}

async function searchMessages(q) {
  try {
    const { results } = await api('/search/messages?q=' + encodeURIComponent(q));
    el.searchResults.innerHTML = '';
    if (!results.length) {
      el.searchResults.innerHTML = '<div class="search-result"><small>No messages found</small></div>';
    }
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'search-result msg-result';
      const isGroup = r.kind === 'group';
      const who = isGroup
        ? escapeHtml(r.groupName || 'Group')
        : escapeHtml(r.senderId === state.me.id ? (peerName(r.peerId) || 'You') : (peerName(r.senderId) || 'Unknown'));
      row.innerHTML = `
        <div class="sr-info">
          <div class="avatar">${escapeHtml(initials(isGroup ? (r.groupName || 'G') : who))}</div>
          <div class="sr-msg">
            <div class="sr-who">${who}<span class="sr-when">${fmtTime(r.createdAt)}</span></div>
            <div class="sr-body">${highlight(r.body, q)}</div>
          </div>
        </div>`;
      row.addEventListener('click', () => jumpToResult(r));
      el.searchResults.appendChild(row);
    }
    el.searchResults.classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

function peerName(id) {
  const c = state.contacts.find((x) => x.id === id);
  return c ? c.displayName : (id === state.me.id ? 'You' : '');
}

// Opens the conversation/group that contains the match, then scrolls to it.
async function jumpToResult(r) {
  el.searchResults.classList.add('hidden');
  el.searchInput.value = '';
  try {
    if (r.kind === 'group') {
      const g = state.groups.find((x) => x.id === r.groupId);
      if (!g) { toast('That group is no longer available.', true); return; }
      await openGroupConversation(g);
    } else {
      const peer = state.contacts.find((x) => x.id === r.peerId);
      if (!peer) { toast('Open this conversation from your contact list first.', true); return; }
      await openConversation(peer);
    }
    revealMessage(r.id);
  } catch (err) { toast(err.message, true); }
}

// Scrolls a rendered message into view and briefly highlights it.
function revealMessage(id) {
  const node = el.messages.querySelector(`[data-id="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('highlight');
  setTimeout(() => node.classList.remove('highlight'), 1600);
}

function setSearchMode(mode) {
  state.searchMode = mode;
  const messages = mode === 'messages';
  el.searchMode.textContent = messages ? '💬' : '👤';
  el.searchMode.title = messages ? 'Searching: messages' : 'Searching: people';
  el.searchInput.placeholder = messages ? 'Search your messages…' : 'Find people to add…';
  el.searchResults.classList.add('hidden');
  if (el.searchInput.value.trim().length >= 2) doSearch();
  else el.searchInput.focus();
}

async function addContact(user) {
  try {
    await api('/contacts', { method: 'POST', body: JSON.stringify({ userId: user.id }) });
    toast(`Added ${user.displayName}`);
    el.searchResults.classList.add('hidden');
    el.searchInput.value = '';
    await loadContacts();
  } catch (err) { toast(err.message, true); }
}

el.searchBtn.addEventListener('click', doSearch);
el.searchMode.addEventListener('click', () => setSearchMode(state.searchMode === 'messages' ? 'people' : 'messages'));
el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ---------------------------------------------------------------------------
// Conversation & messaging
// ---------------------------------------------------------------------------
async function openConversation(user) {
  state.activePeer = user;
  state.activeGroup = null;
  el.voiceBtn.classList.remove('hidden');
  el.videoBtn.classList.remove('hidden');
  el.addMemberBtn.classList.add('hidden');
  el.leaveGroupBtn.classList.add('hidden');
  el.membersBtn.classList.add('hidden');
  el.emptyState.classList.add('hidden');
  el.conversation.classList.remove('hidden');
  el.peerName.textContent = user.displayName;
  el.peerAvatar.textContent = initials(user.displayName);
  updatePeerStatus();
  renderContacts();
  renderGroups();

  revokeObjectUrls();
  el.messages.innerHTML = '';
  try {
    const { messages } = await api(`/messages/${user.id}`);
    for (const m of messages) appendMessage(m);
    scrollToBottom();
    // Mark as read.
    state.unread[user.id] = 0;
    renderContacts();
    wsSend({ type: 'message:read', peerId: user.id });
  } catch (err) { toast(err.message, true); }

  const canCall = Boolean(state.presence[user.id]);
  el.voiceBtn.disabled = !canCall;
  el.videoBtn.disabled = !canCall;
  el.messageInput.focus();
}

function closeConversation() {
  state.activePeer = null;
  state.activeGroup = null;
  el.conversation.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  renderGroups();
}

function updatePeerStatus() {
  if (!state.activePeer) return;
  const online = Boolean(state.presence[state.activePeer.id]);
  el.peerStatus.textContent = online ? 'Online' : 'Offline';
  el.peerStatus.className = 'conv-status' + (online ? ' online' : '');
  el.voiceBtn.disabled = !online;
  el.videoBtn.disabled = !online;
}

// ---------------------------------------------------------------------------
// Attachments (media / file sharing)
// ---------------------------------------------------------------------------
function authHeaders(extra = {}) {
  const h = { ...extra };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

function revokeObjectUrls() {
  for (const u of state.objectUrls) { try { URL.revokeObjectURL(u); } catch (_) { /* noop */ } }
  state.objectUrls = [];
}

// Fetches an upload's bytes with the auth token (tokens never appear in URLs)
// and returns a tracked blob: URL for use as a media src.
async function fetchObjectUrl(id) {
  const res = await fetch(apiBase() + '/uploads/' + encodeURIComponent(id), { headers: authHeaders() });
  if (!res.ok) throw new Error('Could not load attachment.');
  const url = URL.createObjectURL(await res.blob());
  state.objectUrls.push(url);
  return url;
}

function hydrateMedia(node, id) {
  fetchObjectUrl(id)
    .then((url) => { node.src = url; })
    .catch(() => {
      const err = document.createElement('div');
      err.className = 'attachment-error';
      err.textContent = 'Could not load attachment.';
      node.replaceWith(err);
    });
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Builds the DOM node for a message attachment. Images/video/audio render
// inline and hydrate lazily; everything else becomes a download button.
function attachmentNode(att) {
  const kind = (att.mime || '').split('/')[0];
  const wrap = document.createElement('div');
  wrap.className = 'attachment ' + kind;

  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    const tag = kind === 'image' ? 'img' : kind;
    const media = document.createElement(tag);
    media.className = 'attachment-media';
    if (kind === 'image') media.alt = att.name || 'image';
    else { media.controls = true; media.preload = 'metadata'; }
    wrap.appendChild(media);
    hydrateMedia(media, att.id);
  }

  const meta = document.createElement('div');
  meta.className = 'attachment-meta';
  const name = document.createElement('span');
  name.className = 'attachment-name';
  name.textContent = att.name || 'file';
  const size = document.createElement('span');
  size.className = 'attachment-size';
  size.textContent = humanSize(att.size);
  meta.appendChild(name);
  meta.appendChild(size);

  if (kind !== 'image') {
    const dl = document.createElement('button');
    dl.className = 'attachment-dl';
    dl.type = 'button';
    dl.textContent = 'Download';
    dl.addEventListener('click', () => downloadAttachment(att));
    meta.appendChild(dl);
  }
  wrap.appendChild(meta);
  return wrap;
}

async function downloadAttachment(att) {
  try {
    const url = await fetchObjectUrl(att.id);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (_) {
    toast('Download failed.', true);
  }
}

// Uploads a File (raw body, mime preserved) and returns the canonical upload
// record {id,name,mime,size}.
async function uploadFile(file) {
  const res = await fetch(apiBase() + '/uploads?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': file.type || 'application/octet-stream' }),
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.upload;
}

function previewText(m) {
  if (m.body) return m.body;
  if (m.attachment) return '📎 ' + (m.attachment.name || 'file');
  return '';
}

// Uploads each selected file and sends it as a message. Any text in the
// composer becomes the caption of the first attachment.
async function sendFiles(files) {
  if (!files || !files.length) return;
  if (!state.activePeer && !state.activeGroup) { toast('Open a conversation first.', true); return; }
  const caption = el.messageInput.value.trim();
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    try {
      toast(`Uploading ${file.name}…`);
      const upload = await uploadFile(file);
      const body = i === 0 ? caption : '';
      if (state.activeGroup) {
        wsSend({ type: 'groupmsg:send', groupId: state.activeGroup.id, body, attachment: { id: upload.id } });
      } else {
        wsSend({ type: 'message:send', recipientId: state.activePeer.id, body, attachment: { id: upload.id } });
      }
    } catch (err) {
      toast(err.message || 'Upload failed.', true);
    }
  }
  el.messageInput.value = '';
  el.messageInput.style.height = 'auto';
}

function appendMessage(m) {
  const div = document.createElement('div');
  const mine = m.senderId === state.me.id;
  div.className = 'msg ' + (mine ? 'me' : 'them');
  div.dataset.id = m.id;
  const bodyHtml = m.body ? escapeHtml(m.body) : '';
  div.innerHTML = `${bodyHtml}<span class="time">${fmtTime(m.createdAt)}</span>`;
  if (m.attachment) div.insertBefore(attachmentNode(m.attachment), div.firstChild);
  el.messages.appendChild(div);
  scrollToBottom();
  const peerId = mine ? m.recipientId : m.senderId;
  state.lastPreview[peerId] = (mine ? 'You: ' : '') + previewText(m);
  renderContacts();
}

function scrollToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }

async function handleIncomingMessage(m) {
  // A first-time sender was added on their side, so they are missing from the
  // local contact list; refresh or the thread, unread badge and name stay blank.
  if (!state.contacts.some((c) => c.id === m.senderId)) {
    await loadContacts().catch(() => {});
  }
  appendMessage(m);
  if (state.activePeer && state.activePeer.id === m.senderId) {
    wsSend({ type: 'message:read', peerId: m.senderId });
  } else {
    state.unread[m.senderId] = (state.unread[m.senderId] || 0) + 1;
    renderContacts();
    toast(`New message from ${senderName(m.senderId)}`);
  }
}

function senderName(id) {
  const c = state.contacts.find((x) => x.id === id);
  return c ? c.displayName : 'Unknown';
}

function markThreadRead(peerId) {
  // The peer read our messages; no visible change required beyond previews.
  if (state.activePeer && state.activePeer.id === peerId) {
    // could show a "read" affordance here
  }
}

function sendMessage() {
  const body = el.messageInput.value.trim();
  if (!body) return;
  if (state.activeGroup) {
    wsSend({ type: 'groupmsg:send', groupId: state.activeGroup.id, body });
  } else if (state.activePeer) {
    wsSend({ type: 'message:send', recipientId: state.activePeer.id, body });
    wsSend({ type: 'typing', peerId: state.activePeer.id, isTyping: false });
  } else {
    return;
  }
  el.messageInput.value = '';
  el.messageInput.style.height = 'auto';
}

el.sendBtn.addEventListener('click', sendMessage);
el.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
el.messageInput.addEventListener('input', () => {
  el.messageInput.style.height = 'auto';
  el.messageInput.style.height = Math.min(el.messageInput.scrollHeight, 120) + 'px';
  if (!state.activePeer) return;
  wsSend({ type: 'typing', peerId: state.activePeer.id, isTyping: true });
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(
    () => wsSend({ type: 'typing', peerId: state.activePeer.id, isTyping: false }), 1200
  );
});

el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const files = Array.from(el.fileInput.files || []);
  el.fileInput.value = '';
  if (files.length) sendFiles(files);
});

function showPeerTyping(userId, isTyping) {
  if (!state.activePeer || state.activePeer.id !== userId) return;
  clearTimeout(state.peerTypingTimer);
  if (isTyping) {
    el.typingIndicator.textContent = `${senderName(userId)} is typing…`;
    state.peerTypingTimer = setTimeout(() => { el.typingIndicator.textContent = ''; }, 3000);
  } else {
    el.typingIndicator.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// WebRTC calls
// ---------------------------------------------------------------------------
function rtcConfig() { return { iceServers: state.iceServers }; }

async function getMedia(kind) {
  const constraints = kind === 'audio'
    ? { audio: true, video: false }
    : { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
  return navigator.mediaDevices.getUserMedia(constraints);
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(rtcConfig());
  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: 'call:signal', callId: call.callId, signal: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    el.remoteVideo.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { startCall(); }
    else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (call.callId) teardownCall('ended');
    }
  };
  return pc;
}

async function startOutgoingCall(kind) {
  if (!state.activePeer) return;
  if (inAnyCall()) { toast('Already in a call', true); return; }
  if (!state.presence[state.activePeer.id]) { toast('User is offline', true); return; }

  try {
    call.localStream = await getMedia(kind);
  } catch {
    toast('Camera/microphone access denied', true);
    return;
  }
  call.kind = kind;
  call.peer = state.activePeer;
  call.isCaller = true;
  openCallOverlay();
  setCallStatus('Calling ' + call.peer.displayName + '…');

  wsSend({ type: 'call:initiate', calleeId: call.peer.id, kind });
}

async function onCallAccepted(msg) {
  call.callId = msg.callId;
  if (msg.iceServers) state.iceServers = msg.iceServers;
  call.pc = createPeerConnection();
  for (const track of call.localStream.getTracks()) call.pc.addTrack(track, call.localStream);
  el.localVideo.srcObject = call.localStream;
  el.localVideo.classList.toggle('hidden', call.kind === 'audio');

  const offer = await call.pc.createOffer();
  await call.pc.setLocalDescription(offer);
  wsSend({ type: 'call:signal', callId: call.callId, signal: { sdp: call.pc.localDescription } });
  setCallStatus('Connecting…');
}

function onIncomingCall(msg) {
  if (inAnyCall()) {
    wsSend({ type: 'call:reject', callId: msg.callId, reason: 'busy' });
    return;
  }
  call.incoming = msg;
  el.incomingName.textContent = msg.caller.displayName;
  el.incomingKind.textContent = msg.kind === 'audio' ? 'Voice call' : 'Video call';
  el.incomingAvatar.textContent = initials(msg.caller.displayName);
  el.incomingModal.classList.remove('hidden');
  playRingtone();
}

el.declineBtn.addEventListener('click', () => {
  if (group.incoming) { clearGroupIncoming(); return; }
  if (call.incoming) wsSend({ type: 'call:reject', callId: call.incoming.callId, reason: 'rejected' });
  clearIncoming();
});

el.answerBtn.addEventListener('click', async () => {
  if (group.incoming) { await answerGroup(); return; }
  const inc = call.incoming;
  if (!inc) return;
  stopRingtone();
  el.incomingModal.classList.add('hidden');
  try {
    call.localStream = await getMedia(inc.kind);
  } catch {
    toast('Camera/microphone access denied', true);
    wsSend({ type: 'call:reject', callId: inc.callId, reason: 'rejected' });
    clearIncoming();
    return;
  }
  call.callId = inc.callId;
  call.kind = inc.kind;
  call.peer = inc.caller;
  call.isCaller = false;
  if (inc.iceServers) state.iceServers = inc.iceServers;
  call.incoming = null;

  call.pc = createPeerConnection();
  for (const track of call.localStream.getTracks()) call.pc.addTrack(track, call.localStream);
  el.localVideo.srcObject = call.localStream;
  el.localVideo.classList.toggle('hidden', call.kind === 'audio');

  openCallOverlay();
  setCallStatus('Connecting…');
  wsSend({ type: 'call:accept', callId: call.callId });
});

function clearIncoming() {
  call.incoming = null;
  stopRingtone();
  el.incomingModal.classList.add('hidden');
}

async function onCallSignal(msg) {
  if (!call.pc || msg.callId !== call.callId) return;
  const { sdp, candidate } = msg.signal || {};
  try {
    if (sdp) {
      await call.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      // If we're the callee and just got the offer, send our answer.
      if (sdp.type === 'offer' && !call.isCaller) {
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        wsSend({ type: 'call:signal', callId: call.callId, signal: { sdp: call.pc.localDescription } });
      }
    } else if (candidate) {
      await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Signal handling error', err);
  }
}

function onRemoteCallEnd(reason) {
  const label = reason === 'rejected' ? 'Call declined'
    : reason === 'busy' ? 'User is busy'
    : reason === 'ended' ? 'Call ended' : 'Call ended';
  teardownCall(label);
}

function openCallOverlay() {
  el.callOverlay.classList.remove('hidden');
  el.callTimer.classList.add('hidden');
  el.muteBtn.classList.remove('off');
  el.camBtn.classList.remove('off');
  el.muteBtn.textContent = '🎙';
  el.camBtn.textContent = '📹';
  el.camBtn.disabled = currentKind() === 'audio';
  if (group.active) {
    el.remoteVideo.classList.add('hidden');
    el.remoteGrid.classList.remove('hidden');
  } else {
    el.remoteGrid.classList.add('hidden');
    el.remoteGrid.innerHTML = '';
    if (currentKind() === 'audio') el.remoteVideo.classList.add('hidden');
    else el.remoteVideo.classList.remove('hidden');
  }
}

function setCallStatus(text) { el.callStatus.textContent = text; }

function startCall() {
  call.startedAt = Date.now();
  if (!group.active) {
    setCallStatus(call.peer ? 'In call with ' + call.peer.displayName : 'Connected');
  }
  el.callTimer.classList.remove('hidden');
  clearInterval(call.timerId);
  call.timerId = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    el.callTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function teardownCall(statusText) {
  if (call.callId) {
    // Notify the peer we're hanging up (server no-ops if the call is already gone).
    wsSend({ type: 'call:end', callId: call.callId });
  }
  clearInterval(call.timerId);
  if (call.pc) { try { call.pc.close(); } catch {} }
  if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
  el.remoteVideo.srcObject = null;
  el.localVideo.srcObject = null;
  el.remoteGrid.innerHTML = '';
  el.remoteGrid.classList.add('hidden');
  el.callOverlay.classList.add('hidden');
  call.pc = null; call.localStream = null; call.callId = null;
  call.peer = null; call.isCaller = false; call.startedAt = null;
  clearIncoming();
  if (statusText) toast(statusText);
}

el.endCallBtn.addEventListener('click', () => {
  if (group.active) leaveGroupCall();
  else teardownCall('Call ended');
});

el.muteBtn.addEventListener('click', () => {
  const stream = currentLocalStream();
  if (!stream) return;
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.muteBtn.classList.toggle('off', !track.enabled);
  el.muteBtn.textContent = track.enabled ? '🎙' : '🔇';
});

el.camBtn.addEventListener('click', () => {
  const stream = currentLocalStream();
  if (!stream || currentKind() === 'audio') return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  el.camBtn.classList.toggle('off', !track.enabled);
  el.camBtn.textContent = track.enabled ? '📹' : '🚫';
});

el.voiceBtn.addEventListener('click', () => startOutgoingCall('audio'));
el.videoBtn.addEventListener('click', () => startOutgoingCall('video'));

// ---------------------------------------------------------------------------
// Group calls (full mesh)
// ---------------------------------------------------------------------------
function openGroupPicker() {
  if (inAnyCall()) { toast('Already in a call', true); return; }
  renderPickerList();
  el.groupPickerModal.classList.remove('hidden');
}

function closeGroupPicker() { el.groupPickerModal.classList.add('hidden'); }

function renderPickerList() {
  el.pickerList.innerHTML = '';
  if (!state.contacts.length) {
    el.pickerList.innerHTML = '<li><small style="color:var(--text-dim)">Add contacts first to start a group call.</small></li>';
    return;
  }
  for (const c of state.contacts) {
    const online = Boolean(state.presence[c.id]);
    const li = document.createElement('li');
    li.className = online ? '' : 'offline';
    li.innerHTML = `
      <input type="checkbox" value="${escapeHtml(c.id)}" ${online ? '' : 'disabled'} />
      <div class="avatar">${escapeHtml(initials(c.displayName))}</div>
      <span>${escapeHtml(c.displayName)}</span>`;
    li.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        const cb = li.querySelector('input');
        if (!cb.disabled) cb.checked = !cb.checked;
      }
    });
    el.pickerList.appendChild(li);
  }
}

function startGroupCallFromPicker() {
  const ids = [...el.pickerList.querySelectorAll('input:checked')].map((i) => i.value);
  if (!ids.length) { toast('Select at least one person', true); return; }
  const kind = document.querySelector('input[name="gkind"]:checked').value;
  closeGroupPicker();
  group.pendingInvite = ids;
  group.kind = kind;
  wsSend({ type: 'groupcall:create', kind });
}

async function onGroupCreated(msg) {
  group.callId = msg.callId;
  group.kind = msg.kind;
  try {
    group.localStream = await getMedia(group.kind);
  } catch {
    toast('Camera/microphone access denied', true);
    resetGroup();
    return;
  }
  group.active = true;
  group.sfu = msg.sfu || null;
  openCallOverlay();
  el.localVideo.srcObject = group.localStream;
  el.localVideo.classList.toggle('hidden', group.kind === 'audio');
  setCallStatus('Waiting for others to join…');
  startCall();
  if (group.sfu) await connectSfu();
  wsSend({ type: 'groupcall:invite', callId: group.callId, userIds: group.pendingInvite });
}

function onGroupIncoming(msg) {
  if (inAnyCall()) return;
  group.incoming = msg;
  el.incomingName.textContent = `${msg.from.displayName} invited you`;
  el.incomingKind.textContent = `Group ${msg.kind === 'audio' ? 'voice' : 'video'} call`;
  el.incomingAvatar.textContent = initials(msg.from.displayName);
  el.incomingModal.classList.remove('hidden');
  playRingtone();
}

function clearGroupIncoming() {
  group.incoming = null;
  stopRingtone();
  el.incomingModal.classList.add('hidden');
}

async function answerGroup() {
  const inc = group.incoming;
  if (!inc) return;
  stopRingtone();
  el.incomingModal.classList.add('hidden');
  try {
    group.localStream = await getMedia(inc.kind);
  } catch {
    toast('Camera/microphone access denied', true);
    clearGroupIncoming();
    return;
  }
  group.callId = inc.callId;
  group.kind = inc.kind;
  group.active = true;
  group.incoming = null;
  group.sfu = inc.sfu || null;
  if (inc.iceServers) state.iceServers = inc.iceServers;
  openCallOverlay();
  el.localVideo.srcObject = group.localStream;
  el.localVideo.classList.toggle('hidden', group.kind === 'audio');
  setCallStatus('Joining…');
  wsSend({ type: 'groupcall:join', callId: group.callId });
}

// The peer who joins last offers to everyone already present; existing members
// only answer. This deterministic rule prevents offer/answer glare.
async function onGroupJoined(msg) {
  group.callId = msg.callId;
  group.kind = msg.kind;
  group.active = true;
  group.sfu = msg.sfu || group.sfu || null;
  if (msg.iceServers) state.iceServers = msg.iceServers;
  openCallOverlay();
  el.localVideo.srcObject = group.localStream;
  el.localVideo.classList.toggle('hidden', group.kind === 'audio');
  startCall();
  if (group.sfu) {
    await connectSfu();
    setCallStatus(`Group call · ${group.room.numParticipants + 1} people`);
    return;
  }
  for (const peer of msg.peers || []) {
    addGridTile(peer.id, peer.displayName);
    await offerTo(peer);
  }
  setCallStatus(`Group call · ${group.peers.size + 1} people`);
}

function onGroupPeerJoined(msg) {
  if (!group.active || msg.callId !== group.callId) return;
  if (sfuActive()) {
    // LiveKit's ParticipantConnected/TrackSubscribed own the tiles in SFU mode.
    setCallStatus(`Group call · ${group.room.numParticipants + 1} people`);
    return;
  }
  addGridTile(msg.peer.id, msg.peer.displayName);
  ensureGroupPc(msg.peer.id, msg.peer.displayName); // wait for their offer
  setCallStatus(`Group call · ${group.peers.size + 1} people`);
}

function ensureGroupPc(peerId, displayName) {
  if (group.peers.has(peerId)) return group.peers.get(peerId);
  const entry = { pc: null, stream: null, videoEl: null, tileEl: null, displayName, offeredByUs: false };
  const tile = groupTileFor(peerId);
  if (tile) { entry.tileEl = tile; entry.videoEl = tile.querySelector('video'); }
  const pc = new RTCPeerConnection(rtcConfig());
  entry.pc = pc;
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({ type: 'groupcall:signal', callId: group.callId, to: peerId, signal: { candidate: e.candidate } });
    }
  };
  pc.ontrack = (e) => {
    entry.stream = e.streams[0];
    if (entry.videoEl) entry.videoEl.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) removeGroupPeer(peerId);
  };
  if (group.localStream) {
    for (const track of group.localStream.getTracks()) pc.addTrack(track, group.localStream);
  }
  group.peers.set(peerId, entry);
  return entry;
}

function groupTileFor(peerId) {
  return el.remoteGrid.querySelector(`.grid-tile[data-peer="${peerId}"]`);
}

function addGridTile(peerId, displayName) {
  if (groupTileFor(peerId)) return;
  const tile = document.createElement('div');
  tile.className = 'grid-tile' + (group.kind === 'audio' ? ' audio-only' : '');
  tile.dataset.peer = peerId;
  tile.dataset.initials = initials(displayName);
  tile.innerHTML = `<video autoplay playsinline></video><span class="tile-label">${escapeHtml(displayName)}</span>`;
  el.remoteGrid.appendChild(tile);
}

async function offerTo(peer) {
  const entry = ensureGroupPc(peer.id, peer.displayName);
  entry.offeredByUs = true;
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  wsSend({ type: 'groupcall:signal', callId: group.callId, to: peer.id, signal: { sdp: entry.pc.localDescription } });
}

async function onGroupSignal(msg) {
  if (!group.active || msg.callId !== group.callId) return;
  if (sfuActive()) return; // SFU mode: LiveKit owns all media signaling.
  const fromId = msg.from;
  const entry = ensureGroupPc(fromId, senderName(fromId));
  const { sdp, candidate } = msg.signal || {};
  try {
    if (sdp) {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (sdp.type === 'offer' && !entry.offeredByUs) {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        wsSend({ type: 'groupcall:signal', callId: group.callId, to: fromId, signal: { sdp: entry.pc.localDescription } });
      }
    } else if (candidate) {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Group signal error', err);
  }
}

function onGroupPeerLeft(msg) {
  if (!group.active || msg.callId !== group.callId) return;
  removeGroupPeer(msg.peerId);
  setCallStatus(`Group call · ${group.peers.size + 1} people`);
  toast(`${senderName(msg.peerId)} left the call`);
}

function removeGroupPeer(peerId) {
  const entry = group.peers.get(peerId);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  if (entry.tileEl) entry.tileEl.remove();
  group.peers.delete(peerId);
}

function leaveGroupCall() {
  if (group.callId) wsSend({ type: 'groupcall:leave', callId: group.callId });
  disconnectSfu();
  for (const peerId of [...group.peers.keys()]) removeGroupPeer(peerId);
  if (group.localStream) group.localStream.getTracks().forEach((t) => t.stop());
  el.localVideo.srcObject = null;
  el.remoteGrid.innerHTML = '';
  el.remoteGrid.classList.add('hidden');
  el.callOverlay.classList.add('hidden');
  clearInterval(call.timerId);
  resetGroup();
  toast('Left group call');
}

function resetGroup() {
  group.active = false;
  group.callId = null;
  group.kind = 'video';
  group.localStream = null;
  group.peers.clear();
  group.incoming = null;
  group.pendingInvite = [];
  group.sfu = null;
  group.room = null;
}

// ---------------------------------------------------------------------------
// Group calls over the LiveKit SFU
// ---------------------------------------------------------------------------
// When the server supplies an SFU config we connect ONE LiveKit Room instead of
// building a WebRTC mesh. The SFU fans media out, so call cost stays flat as the
// room grows past the ~6-person mesh limit. Participant identity is the Connecta
// user id, which lets us reuse the existing grid tiles.
function sfuActive() { return Boolean(group.sfu && group.room); }

async function connectSfu() {
  const { Room, RoomEvent } = window.LivekitClient;
  const room = new Room({ adaptiveStream: true, dynacast: true });
  group.room = room;

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const peerId = participant.identity;
    addGridTile(peerId, participant.name || senderName(peerId));
    const tile = groupTileFor(peerId);
    const videoEl = tile && tile.querySelector('video');
    if (videoEl && track.kind === 'video') videoEl.srcObject = new MediaStream([track]);
    if (track.kind === 'audio') track.attach();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach(); });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    addGridTile(p.identity, p.name || senderName(p.identity));
    setCallStatus(`Group call · ${room.numParticipants + 1} people`);
  });

  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    removeGroupPeer(p.identity);
    setCallStatus(`Group call · ${room.numParticipants + 1} people`);
  });

  room.on(RoomEvent.Disconnected, () => {
    if (group.active) leaveGroupCall();
  });

  await room.connect(group.sfu.url, group.sfu.token);

  // Publish the tracks we already captured via getUserMedia.
  if (group.localStream) {
    for (const track of group.localStream.getTracks()) {
      await room.localParticipant.publishTrack(track);
    }
  }
  // Render anyone already in the room.
  room.remoteParticipants.forEach((p) => {
    addGridTile(p.identity, p.name || senderName(p.identity));
    p.trackPublications.forEach((pub) => {
      if (pub.isSubscribed && pub.track && pub.track.kind === 'video') {
        const tile = groupTileFor(p.identity);
        const videoEl = tile && tile.querySelector('video');
        if (videoEl) videoEl.srcObject = new MediaStream([pub.track]);
      }
    });
  });
  setCallStatus(`Group call · ${room.numParticipants + 1} people`);
}

function disconnectSfu() {
  if (group.room) {
    try { group.room.disconnect(); } catch { /* already closed */ }
  }
  group.room = null;
}

el.groupCallBtn.addEventListener('click', openGroupPicker);
el.pickerCancel.addEventListener('click', closeGroupPicker);
el.pickerStart.addEventListener('click', startGroupCallFromPicker);

// ---------------------------------------------------------------------------
// Group text chat
// ---------------------------------------------------------------------------
async function loadGroups() {
  const { groups, unread } = await api('/groups');
  state.groups = groups;
  state.groupUnread = unread || {};
  renderGroups();
}

function renderGroups() {
  el.groupList.innerHTML = '';
  for (const g of state.groups) {
    const li = document.createElement('li');
    const active = state.activeGroup && state.activeGroup.id === g.id;
    li.className = 'contact' + (active ? ' active' : '');
    li.innerHTML = `
      <div class="avatar">${escapeHtml(initials(g.name))}</div>
      <div class="c-info">
        <div class="c-name">${escapeHtml(g.name)}</div>
        <div class="c-preview">${escapeHtml(state.groupPreview[g.id] || `${g.members.length} members`)}</div>
      </div>
      ${state.groupUnread[g.id] ? `<span class="badge">${state.groupUnread[g.id]}</span>` : ''}`;
    li.addEventListener('click', () => openGroupConversation(g));
    el.groupList.appendChild(li);
  }
}

async function openGroupConversation(group) {
  state.activeGroup = group;
  state.activePeer = null;
  el.voiceBtn.classList.add('hidden');
  el.videoBtn.classList.add('hidden');
  el.addMemberBtn.classList.remove('hidden');
  el.leaveGroupBtn.classList.remove('hidden');
  el.membersBtn.classList.remove('hidden');
  el.emptyState.classList.add('hidden');
  el.conversation.classList.remove('hidden');
  el.peerName.textContent = group.name;
  el.peerAvatar.textContent = initials(group.name);
  el.peerStatus.textContent = `${group.members.length} members`;
  el.peerStatus.className = 'conv-status';
  renderContacts();
  renderGroups();

  revokeObjectUrls();
  el.messages.innerHTML = '';
  try {
    const { messages } = await api(`/groups/${group.id}/messages`);
    for (const m of messages) appendGroupMessage(m);
    scrollToBottom();
    state.groupUnread[group.id] = 0;
    renderGroups();
    if (messages.length) {
      wsSend({ type: 'group:read', groupId: group.id, lastMsgId: messages[messages.length - 1].id });
    }
  } catch (err) { toast(err.message, true); }
  el.messageInput.focus();
}

function appendGroupMessage(m) {
  const mine = m.senderId === state.me.id;
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'me' : 'them');
  div.dataset.id = m.id;
  const label = mine ? '' : `<span class="sender">${escapeHtml(senderName(m.senderId))}</span>`;
  const bodyHtml = m.body ? escapeHtml(m.body) : '';
  div.innerHTML = `${label}${bodyHtml}<span class="time">${fmtTime(m.createdAt)}</span>`;
  if (m.attachment) div.insertBefore(attachmentNode(m.attachment), div.querySelector('.time'));
  el.messages.appendChild(div);
  scrollToBottom();
  state.groupPreview[m.groupId] = (mine ? 'You: ' : senderName(m.senderId) + ': ') + previewText(m);
  renderGroups();
}

function onGroupMessage(m) {
  if (state.activeGroup && state.activeGroup.id === m.groupId) {
    appendGroupMessage(m);
    wsSend({ type: 'group:read', groupId: m.groupId, lastMsgId: m.id });
  } else {
    state.groupPreview[m.groupId] = senderName(m.senderId) + ': ' + m.body;
    if (m.senderId !== state.me.id) {
      state.groupUnread[m.groupId] = (state.groupUnread[m.groupId] || 0) + 1;
      toast(`New message in ${groupName(m.groupId)}`);
    }
    renderGroups();
  }
}

function groupName(id) {
  const g = state.groups.find((x) => x.id === id);
  return g ? g.name : 'a group';
}

function onChatGroupCreated(msg) {
  if (!state.groups.some((g) => g.id === msg.group.id)) state.groups.push(msg.group);
  renderGroups();
  toast(`Group "${msg.group.name}" ready`);
}

function openGroupChatModal() {
  el.gcName.value = '';
  renderGcPicker();
  el.groupChatModal.classList.remove('hidden');
}
function closeGroupChatModal() { el.groupChatModal.classList.add('hidden'); }

function renderGcPicker() {
  el.gcPickerList.innerHTML = '';
  if (!state.contacts.length) {
    el.gcPickerList.innerHTML = '<li><small style="color:var(--text-dim)">Add contacts first to create a group.</small></li>';
    return;
  }
  for (const c of state.contacts) {
    const li = document.createElement('li');
    li.innerHTML = `
      <input type="checkbox" value="${escapeHtml(c.id)}" />
      <div class="avatar">${escapeHtml(initials(c.displayName))}</div>
      <span>${escapeHtml(c.displayName)}</span>`;
    li.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        const cb = li.querySelector('input');
        cb.checked = !cb.checked;
      }
    });
    el.gcPickerList.appendChild(li);
  }
}

function createGroupChat() {
  const name = el.gcName.value.trim();
  if (!name) { toast('Give the group a name', true); return; }
  const ids = [...el.gcPickerList.querySelectorAll('input:checked')].map((i) => i.value);
  if (!ids.length) { toast('Select at least one member', true); return; }
  wsSend({ type: 'group:create', name, memberIds: ids });
  closeGroupChatModal();
}

el.newGroupBtn.addEventListener('click', openGroupChatModal);
el.gcCancel.addEventListener('click', closeGroupChatModal);
el.gcCreate.addEventListener('click', createGroupChat);

// ---------------------------------------------------------------------------
// Add members to an existing group
// ---------------------------------------------------------------------------
function openAddMemberModal() {
  if (!state.activeGroup) return;
  renderAddMemberList();
  el.addMemberModal.classList.remove('hidden');
}
function closeAddMemberModal() { el.addMemberModal.classList.add('hidden'); }

function renderAddMemberList() {
  const group = state.activeGroup;
  el.addMemberList.innerHTML = '';
  if (!group) return;
  const candidates = state.contacts.filter(
    (c) => !group.members.some((m) => m.id === c.id)
  );
  if (!candidates.length) {
    el.addMemberList.innerHTML = '<li><small style="color:var(--text-dim)">All your contacts are already in this group.</small></li>';
    return;
  }
  for (const c of candidates) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="avatar">${escapeHtml(initials(c.displayName))}</div>
      <span>${escapeHtml(c.displayName)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Add';
    btn.addEventListener('click', () => {
      wsSend({ type: 'group:addmember', groupId: group.id, userId: c.id });
    });
    li.appendChild(btn);
    el.addMemberList.appendChild(li);
  }
}

function onGroupMemberAdded(msg) {
  const idx = state.groups.findIndex((g) => g.id === msg.group.id);
  if (idx >= 0) state.groups[idx] = msg.group;
  else state.groups.push(msg.group);
  if (state.activeGroup && state.activeGroup.id === msg.group.id) {
    state.activeGroup = msg.group;
    el.peerStatus.textContent = `${msg.group.members.length} members`;
    renderAddMemberList();
  }
  renderGroups();
  if (msg.added && msg.addedUser) {
    toast(`${msg.addedUser.displayName} added to ${msg.group.name}`);
  }
}

el.addMemberBtn.addEventListener('click', openAddMemberModal);
el.addMemberCancel.addEventListener('click', closeAddMemberModal);

// ---------------------------------------------------------------------------
// Leave group / manage members (removal is creator-only)
// ---------------------------------------------------------------------------
function isGroupCreator(group) {
  return Boolean(group) && group.createdBy === state.me.id;
}

function refreshRoster(group) {
  const idx = state.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) state.groups[idx] = group;
  if (state.activeGroup && state.activeGroup.id === group.id) {
    state.activeGroup = group;
    el.peerStatus.textContent = `${group.members.length} members`;
    if (!el.membersModal.classList.contains('hidden')) renderMembersList();
    if (!el.addMemberModal.classList.contains('hidden')) renderAddMemberList();
  }
  renderGroups();
}

function openMembersModal() {
  if (!state.activeGroup) return;
  renderMembersList();
  el.membersModal.classList.remove('hidden');
}
function closeMembersModal() { el.membersModal.classList.add('hidden'); }

function renderMembersList() {
  const group = state.activeGroup;
  el.membersList.innerHTML = '';
  if (!group) return;
  const creator = isGroupCreator(group);
  for (const m of group.members) {
    const li = document.createElement('li');
    const isSelf = m.id === state.me.id;
    const role = m.id === group.createdBy ? ' · Creator' : '';
    li.innerHTML = `
      <div class="avatar">${escapeHtml(initials(m.displayName))}</div>
      <span>${escapeHtml(m.displayName)}${isSelf ? ' (you)' : ''}${role}</span>`;
    // Only the creator can remove others; nobody can remove the creator or self.
    if (creator && !isSelf && m.id !== group.createdBy) {
      const btn = document.createElement('button');
      btn.className = 'btn danger';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => {
        wsSend({ type: 'group:remove', groupId: group.id, userId: m.id });
      });
      li.appendChild(btn);
    }
    el.membersList.appendChild(li);
  }
}

function leaveGroup() {
  const group = state.activeGroup;
  if (!group) return;
  if (!confirm(`Leave "${group.name}"?`)) return;
  wsSend({ type: 'group:leave', groupId: group.id });
}

function onGroupMemberLeft(msg) {
  refreshRoster(msg.group);
  if (msg.leftUser && msg.leftUser.id !== state.me.id) {
    toast(`${msg.leftUser.displayName} left ${msg.group.name}`);
  }
}

function onGroupMemberRemoved(msg) {
  refreshRoster(msg.group);
  if (msg.removedUser && msg.removedUser.id !== state.me.id) {
    toast(`${msg.removedUser.displayName} was removed from ${msg.group.name}`);
  }
}

// The local user left or was removed: drop the group entirely from this client.
function onGroupLeftOrRemoved(groupId, message) {
  const idx = state.groups.findIndex((g) => g.id === groupId);
  if (idx >= 0) state.groups.splice(idx, 1);
  delete state.groupUnread[groupId];
  delete state.groupPreview[groupId];
  closeMembersModal();
  closeAddMemberModal();
  if (state.activeGroup && state.activeGroup.id === groupId) closeConversation();
  renderGroups();
  toast(message);
}

el.membersBtn.addEventListener('click', openMembersModal);
el.membersCancel.addEventListener('click', closeMembersModal);
el.leaveGroupBtn.addEventListener('click', leaveGroup);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function hasConnectaApi(origin) {
  try {
    const res = await fetch(origin.replace(/\/$/, '') + '/health');
    return res.ok;
  } catch {
    return false;
  }
}

async function boot() {
  // When served by the backend over http(s) (the PWA), talk to the same origin
  // by default. A static host (e.g. the published shell) has no API, so keep
  // the configurable default or a saved server instead of the page origin.
  if (location.protocol.startsWith('http') && await hasConnectaApi(window.location.origin)) {
    state.serverUrl = window.location.origin;
    el.serverUrl.value = state.serverUrl;
  }

  const info = await credStore.info();
  if (info && info.version) document.title = `Connecta ${info.version}`;

  const creds = await credStore.load().catch(() => null);
  if (creds && creds.token) {
    state.serverUrl = creds.serverUrl || state.serverUrl;
    state.token = creds.token;
    el.serverUrl.value = state.serverUrl;
    try {
      const { user } = await api('/me');
      await afterAuth(creds.token, user);
      return;
    } catch {
      state.token = null;
      await credStore.clear();
    }
  }
  showAuth();
}

boot();
