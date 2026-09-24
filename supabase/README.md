# Connecta on Supabase

This folder holds what you need to run Connecta's data layer on Supabase
(Postgres + Auth + Row Level Security) instead of the bundled SQLite file.

**What's here now**
- `migrations/0001_init.sql` — the full Postgres schema (tables, indexes) that
  mirrors `server/src/db.js` 1:1, plus RLS policies so a direct browser/mobile
  client can only ever see its own data.

**What is NOT done yet (read this before you expect the app to use it)**
- The Node backend still talks to **SQLite** through a synchronous
  `better-sqlite3` adapter. Pointing it at Supabase means an **async rewrite**:
  every `db.*` call becomes a promise (`pg` or `@supabase/supabase-js`), and
  `routes.js` / `ws.js` must `await` them. That is a real migration, not a
  config flip — it is scoped in section 4 below.
- A **hosted** Supabase project (the cloud dashboard where you'd "manage the
  app") requires **your own Supabase account** — I can't create a cloud project
  for you. What I *can* do is everything below that lives in this repo.

---

## 1. Run Supabase locally with Docker (recommended first step)

Supabase ships an official self-host stack (Postgres, GoTrue auth, PostgREST,
Realtime, Storage, Kong gateway, Studio dashboard). Use it rather than
hand-rolling one:

```bash
# Prereqs: Docker Desktop + the Supabase CLI
npm install -g supabase

# In the repo root
supabase init            # creates supabase/config.toml (accept defaults)
supabase start           # boots the whole stack in Docker (first run pulls images)
```

`supabase start` prints your local Studio URL (http://127.0.0.1:54323), the
anon key, and the service_role key. It automatically applies everything in
`supabase/migrations/`, so `0001_init.sql` is loaded for you.

To (re)apply migrations against the local stack manually:

```bash
supabase db reset        # drops + recreates, re-runs migrations & seeds
```

Stop / clean up:

```bash
supabase stop            # add --no-backup to discard local data
```

> Note: `supabase init` generates `config.toml`; I left it out of the repo so
> the CLI can create the version that matches your installed CLI.

---

## 2. Use a hosted Supabase project

1. Create a project at https://supabase.com/dashboard (your account).
2. Open **SQL Editor**, paste the contents of `migrations/0001_init.sql`, run it
   — or connect the CLI:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
3. Grab the connection strings from **Project Settings → Database / API**:
   - `SUPABASE_DB_URL` — the direct Postgres URI (`postgresql://postgres:...`).
   - `SUPABASE_SERVICE_ROLE_KEY` — server-side key (bypasses RLS).
   - `SUPABASE_ANON_KEY` — only if a client talks to Supabase directly.

---

## 3. Environment wiring

Add these to `server/.env` (they are **not** read by the app yet — see §4):

```env
# Postgres / Supabase (replaces DB_FILE once the pg adapter is enabled)
SUPABASE_DB_URL=postgresql://postgres:POSTGRES_PASSWORD@db.<ref>.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=eyJ...        # server-side, bypasses RLS
DB_DRIVER=sqlite                        # sqlite | postgres  (switch after §4)
```

Never commit real keys — `.env` is already gitignored.

---

## 4. Scope of wiring the backend to Postgres (the actual migration)

When you're ready to switch the app over, this is the work, in order:

1. **Add a driver switch** in `server/src/config.js` reading `DB_DRIVER`.
2. **Write `server/src/db.pg.js`** implementing the exact same exported
   functions as `db.js` (`createUser`, `verifyCredentials`, `saveMessage`,
   `getThread`, `createGroup`, `saveGroupMessage`, …) but **async**, using a
   `pg` Pool against `SUPABASE_DB_URL`. `module.exports = require(driver ===
   'postgres' ? './db.pg' : './db')`.
3. **Make call sites await** — `routes.js` handlers and every `ws.js` message
   handler that touches `db`. Express handlers go `async`; WS handlers already
   run in async callbacks, so it's mostly adding `await`.
4. **Types**: `bigint` ids come back from `pg` as strings — cast to Number where
   the client expects numeric message ids (or switch the column to `serial`).
5. **Auth choice**: keep the existing bcrypt/JWT (server owns `users`), or move
   to Supabase Auth (users.id = auth.users.id, GoTrue issues the JWT). Keeping
   your auth is far less work and the RLS policies here are written to also work
   if you later adopt Supabase Auth.
6. **Tests**: `server/test/*` currently boot the SQLite server on a temp DB.
   Add a Postgres variant (e.g. run against the local `supabase start` DB) or
   keep SQLite for unit tests and add a thin integration test for `db.pg.js`.

Estimated size: a focused rewrite of one module + mechanical `await` edits
across `routes.js` and `ws.js`. The SQLite app keeps working untouched until you
flip `DB_DRIVER`.

---

## 5. Which Postgres features buy you

- **Multi-instance**: SQLite is single-writer; Postgres lets you run several
  app replicas behind a load balancer (needed for scale / Lane A teams).
- **Realtime**: Supabase Realtime can push DB changes to clients directly —
  an alternative to your custom WS fan-out for chat (calls still need your WS
  signaling for WebRTC offer/answer).
- **Managed backups, PITR, dashboard** — the "manage the app" surface you asked
  for: browse rows, run SQL, see auth users, all from Studio.
