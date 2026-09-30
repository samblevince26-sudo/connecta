# Connecta

A global text, video and voice calling application. Sign in, add friends, chat in
real time, and place 1-to-1 video or voice calls — all from an installable desktop app.

```
connecta/
├── server/     Node.js backend: auth, SQLite persistence, REST + WebSocket signaling
├── desktop/    Electron desktop client: chat UI + WebRTC calls
├── web/        Installable web PWA (manifest, service worker, icons)
└── coturn/     TURN relay config (turnserver.conf) for NAT traversal
```

The **client UI is shared**: `desktop/renderer/app.js` + `styles.css` power both the
Electron app and the web PWA (the server serves them at `/assets`). In Electron the
session token is stored in the OS keychain; in the browser it falls back to
`localStorage`.

## How it works

- **Auth** — register/login with a username + password. Passwords are hashed with
  bcrypt; sessions use signed JWTs. The desktop app stores the token encrypted with
  the OS keychain (DPAPI / Keychain / libsecret).
- **Persistence** — users, contacts, messages and call logs live in SQLite
  (`better-sqlite3`). Swap in Postgres for horizontal scale (see below).
- **Real-time messaging** — a WebSocket connection per client delivers messages,
  typing indicators, read state and presence instantly.
- **Group text chat** — named multi-party conversations with member rosters,
  persistent history, per-member unread badges, and live delivery to every
  online member. Members can be added after creation; any member may leave, and
  the creator can remove others. Roster changes propagate live, and a group is
  deleted automatically once its last member leaves.
- **Calls** — media flows peer-to-peer over WebRTC. The server only relays
  signaling (SDP offers/answers and ICE candidates); audio/video never touches it.
  A public STUN server is used by default; a TURN server is required for calls that
  must cross strict NAT/firewalls.
- **Group calls** — by default full-mesh WebRTC: each participant opens a
  PeerConnection to every other participant, so no media server is needed. Offer
  direction is deterministic (the newest joiner offers to everyone already present)
  to avoid signaling glare. Comfortable up to ~5–6 people. When a **LiveKit SFU** is
  configured (see "Large group calls — LiveKit SFU" below) the server automatically
  hands each participant a room token and the clients publish/subscribe through the
  SFU instead, so large rooms scale to dozens of people with one upstream per client.

---

## Prerequisites

- **Node.js 18+** (LTS recommended) — https://nodejs.org
- A webcam/microphone for calls (optional for text-only use).

> Note: on first install, `better-sqlite3` compiles a small native module. If the
> build tools are missing, Windows will prompt to install them, or run:
> `npm install --global windows-build-tools` (older Node) / install
> "Desktop development with C++" via Visual Studio Build Tools.

---

## Quick start (one command)

From the project root, with **Node 18+** installed:

```bash
npm run setup     # installs server + desktop dependencies (first time only)
npm run dev       # starts the backend, waits for it, then opens the desktop app
```

`npm run dev` also makes the web PWA available at http://localhost:4000. To run
the backend + PWA only (no Electron), use:

```bash
npm run dev:web
```

The launcher auto-copies `server/.env.example` to `server/.env` on first run —
edit `JWT_SECRET` there before deploying. Press Ctrl+C to stop everything.
The manual, per-component steps are below if you prefer them.

---

## 1. Run the server

```bash
cd server
cp .env.example .env      # then edit JWT_SECRET to a long random string
npm install
npm start
```

You should see:

```
Connecta server listening on http://0.0.0.0:4000
WebSocket signaling at ws://0.0.0.0:4000/ws
```

Health check: open http://localhost:4000/health

## 2. Run the desktop app

In a **second terminal**:

```bash
cd desktop
npm install
npm start
```

The app opens. Leave the server field as `http://localhost:4000` (or point it at
your deployed server), then:

1. **Create account** on the first machine.
2. On a second machine/account, sign in, **search** for the first user, click **Add**.
3. Open the conversation and start texting, or click 🎙 (voice) / 📹 (video) to call.

### Testing calls on one machine

Open two app windows using different OS user accounts, or run one instance from
`desktop/` and a second from a copy of the folder, signing in as two different users.

## 2b. Or use the web PWA (no install needed)

The server also serves an installable Progressive Web App from the same codebase.
With the server running (step 1), open in any modern browser:

```
http://localhost:4000
```

- Sign in / create an account exactly as in the desktop app.
- **Install it:** in Chrome/Edge click the install icon in the address bar (or
  "Install app"); on iOS Safari use Share → "Add to Home Screen". The manifest and
  service worker make it launch full-screen and work offline for the app shell.
- The PWA talks to the same origin by default, so hosting it on your deployed
  server (with TLS) is all that's needed for a worldwide web client.

> Real-time messaging and calls still require a network connection; the service
> worker only caches the app shell so the app opens offline and reconnects.

## 3. Build an installer

```bash
cd desktop
npm run dist:win     # Windows NSIS installer (.exe)
npm run dist:mac     # macOS .dmg
npm run dist:linux   # Linux AppImage
```

Installers are written to `desktop/dist/`.

---

## Environment variables (server)

| Variable       | Default                        | Purpose                                   |
|----------------|--------------------------------|-------------------------------------------|
| `PORT`         | `4000`                         | HTTP/WebSocket port                       |
| `HOST`         | `0.0.0.0`                      | Bind address                              |
| `JWT_SECRET`   | *(dev only)*                   | **Required in production** — signing key  |
| `JWT_EXPIRES_IN` | `7d`                         | Token lifetime                            |
| `DB_FILE`      | `./data/connecta.sqlite`       | SQLite database path                      |
| `TURN_HOST`    | *(unset)*                      | Public address of your coturn server      |
| `TURN_SECRET`  | *(unset)*                      | Shared secret with coturn (see below)     |
| `TURN_TTL`     | `86400`                        | Lifetime of minted TURN creds (seconds)   |
| `ICE_SERVERS`  | *(public STUN only)*           | Static ICE list (managed TURN providers)  |
| `LIVEKIT_URL`  | *(unset)*                      | LiveKit SFU URL, e.g. `ws://127.0.0.1:7880` |
| `LIVEKIT_API_KEY` | *(unset)*                     | LiveKit API key (paired with the server)  |
| `LIVEKIT_API_SECRET` | *(unset)*                  | LiveKit API secret — used to mint room JWTs |

---

## Large group calls — LiveKit SFU

Small group calls are full-mesh and need nothing extra. For **large** rooms
(>~6 people) each client would otherwise open N−1 upstreams, which melts CPU and
uplink. When a [LiveKit](https://livekit.io) SFU is configured, the server mints a
per-participant room token and the clients publish one upstream and subscribe to
everyone through the SFU. This is **opt-in**: if `LIVEKIT_*` is unset, group calls
fall back to full mesh automatically.

### 1. Run a self-hosted LiveKit server

Download the `livekit-server` binary for your platform from
https://github.com/livekit/livekit/releases and start it with a config. A minimal
local config (`server/data/livekit.yaml`, gitignored) looks like:

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 7882
  port_range_end: 7902
  node_ip: "127.0.0.1"
  use_external_ip: false
logging:
  level: info
```

Start it (Windows example; use your own key/secret pair):

```bash
server/bin/livekit-server.exe --config server/data/livekit.yaml \
  --keys "APIkey: supersecretatleast32characterslong"
```

For production, set `use_external_ip: true`, open the UDP port range on your
firewall, terminate TLS, and serve LiveKit over `wss://`.

### 2. Point the Connecta server at it

Add to `server/.env` (values must match the `--keys` pair above):

```
LIVEKIT_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=APIkey
LIVEKIT_API_SECRET=supersecretatleast32characterslong
```

Restart the server. When all three are set, group-call signaling
(`groupcall:created` / `groupcall:joined`) carries an `sfu` object
(`{ url, room, token }`) and clients switch to the SFU path.

### 3. Client CSP note

The LiveKit client connects to the SFU over `ws://`/`wss://` and validates over
`http(s)://`. If you point at an SFU other than `localhost:7880`, add that origin to
the `connect-src` of the Content-Security-Policy in **both**
`desktop/renderer/index.html` and `web/index.html`, or the browser will block the
connection. The `localhost`/`127.0.0.1` origins on port 7880 are already allowed.

> **Verification status:** the server-side integration (token minting + signaling
> payloads) is covered by `server/test/sfu.test.js`, and the client's signaling
> connect to a local LiveKit server has been exercised in-browser. The multi-party
> **media plane** (actual audio/video flowing through the SFU) has not been verified
> in this repo's headless environment — test it with two real browser windows.

---

## TURN relay (coturn) — making calls work everywhere

Peer-to-peer WebRTC fails for users behind symmetric NAT or strict firewalls
(~10–20% of real peers). A TURN relay fixes this. Connecta uses coturn's
**shared-secret / REST scheme**: the server mints short-lived HMAC-SHA1
credentials per user (`username = "<expiry>:<userId>"`,
`credential = base64(HMAC-SHA1(secret, username))`) and ships them in the ICE
server list. No permanent TURN password ever reaches a client.

### Run the whole stack with Docker (recommended)

```bash
cp .env.example .env        # fill JWT_SECRET, TURN_SECRET, TURN_HOST, TURN_EXTERNAL_IP
docker compose up -d --build
```

This starts:
- **app** — the Connecta server + web PWA on port 4000
- **coturn** — the TURN relay with host networking (needs its full UDP range)

`TURN_HOST` must be the **publicly reachable** address of the coturn machine
(clients connect to it directly). `TURN_SECRET` must match between the app env
and coturn — the compose file injects the same value into both.

### Bare-metal / manual coturn

```bash
turnserver -c coturn/turnserver.conf \
  --static-auth-secret=<same as TURN_SECRET> \
  --realm=connecta.example.com \
  --external-ip=<your public IP>
```

Then set `TURN_HOST` and `TURN_SECRET` in `server/.env` and restart the server.
Open UDP 3478 and 49152–65535 (and TCP 3478/5349 if using `turn:`/`turns:` over
TCP/TLS) on your firewall.

### Using a managed TURN instead

If you'd rather not run coturn, leave `TURN_*` unset and provide a static list:

```
ICE_SERVERS=turn:provider.example:3478?user=KEY&pass=TOKEN
```

---

## Going global — production checklist

The codebase is production-shaped, but a worldwide deployment needs infrastructure
that lives outside this repo:

1. **Hosting** — deploy `server/` to a VM or container (Fly.io, Railway, Render,
   AWS/GCP). Terminate TLS so clients connect via `https://` + `wss://`.
2. **Database** — for multiple server instances, replace SQLite with Postgres:
   swap `db.js` to use `pg` and port the queries (the schema maps 1:1). SQLite is
   fine for a single-node deployment.
3. **TURN relay** — run the bundled coturn (see "TURN relay (coturn)" above) or use a
   managed TURN and set `ICE_SERVERS`. Without TURN, calls fail for users behind
   symmetric NAT / corporate firewalls (~10–20% of real-world peers).
4. **Scaling calls** — 1-to-1 and small group calls are peer-to-peer (full mesh) and
   need no media server. For **large** rooms (>~6 people) a LiveKit SFU integration is
   already built in — run a self-hosted LiveKit server and set `LIVEKIT_*` (see "Large
   group calls — LiveKit SFU"), and each client sends one upstream stream instead of N−1.
5. **Code signing** — sign Windows (EV cert) and macOS (Developer ID + notarization)
   installers so users aren't shown security warnings.
6. **Secrets** — set a strong `JWT_SECRET`, store it in your host's secret manager,
   and run with `NODE_ENV=production`.
7. **Hardening** — add rate limiting (`express-rate-limit`) on auth endpoints, and
   put the WebSocket behind the same origin to simplify CSP.

---

## Security notes

- Passwords: bcrypt, cost 12. Never stored or logged in plaintext.
- Transport: use TLS (`https`/`wss`) in production; media is encrypted by WebRTC (DTLS-SRTP) by design.
- SQL: all queries are parameterized — no string interpolation.
- Client: Electron runs with `contextIsolation` on and `nodeIntegration` off; the
  renderer talks to the main process only through the `preload` bridge.

## Troubleshooting

- **Call connects then drops / never connects** → you almost certainly need a TURN
  server. Set `ICE_SERVERS`.
- **No camera/mic prompt** → grant permission in your OS privacy settings; the app
  requests `media` permission automatically.
- **`better-sqlite3` install fails** → install C++ build tools (see Prerequisites).
- **App can't reach server** → check the Server field matches your URL and that the
  server is running; for remote servers use `https://` and add the origin to the CSP
  in `desktop/renderer/index.html`.
