// LiveKit SFU integration.
//
// The self-hosted livekit-server process owns all media routing; this module's
// only job is to mint short-lived participant JWTs so the app server stays the
// single source of auth. Room name = group call id, identity = user id, so the
// client can map LiveKit participants back to Connecta users.

const { AccessToken } = require('livekit-server-sdk');
const config = require('./config');

const enabled = config.livekit.enabled;

function mintToken(roomName, userId, displayName) {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: userId,
    name: displayName || userId,
    ttl: '6h',
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token.toJwt();
}

// The payload handed to a client so it can connect straight to the SFU.
async function clientConfig(roomName, userId, displayName) {
  return {
    url: config.livekit.url,
    room: roomName,
    token: await mintToken(roomName, userId, displayName),
  };
}

module.exports = { enabled, mintToken, clientConfig };
