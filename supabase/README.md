# Connecta on Supabase

This folder holds what you need to run Connecta's data layer on Supabase
(Postgres + Auth + Row Level Security) instead of the bundled SQLite file.

**What's here now**
- `migrations/0001_init.sql` — the full Postgres schema (tables, indexes) that
  mirrors `server/src/db.js` 1:1, plus RLS policies so a direct browser/mobile
  client can only ever see its own data.
- **The backend can now run on Postgres.** Set `DB_DRIVER=postgres` +
  `SUPABASE_DB_URL` and the same server uses `server/src/db.pg.js` (an async
  `pg` adapter) instead of SQLite. See §4.

**What is NOT done / not verified here**
- The Postgres adapter is written, syntax-checked, and wired through the driver
  selector, and its integration test (`server/test/db.pg.test.js`) covers the
  full round-trip — but that test is **skipped by default** and was **not run
  against a live database** in the environment where it was written (no Docker /
  Postgres available). Run it yourself before trusting it in production:
  ```bash
  supabase start   # or any Postgres with migrations/0001_init.sql applied
  cd server
  TEST_PG_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    node --test test/db.pg.test.js
  ```
- A **hosted** Supabase project (the cloud dashboard where you'd "manage the
  app") requires **your own Supabase account** — it can't be created for you.
  Everything that lives in this repo is provided.

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
# Postgres / Supabase. Set DB_DRIVER=postgres to use it instead of DB_FILE.
SUPABASE_DB_URL=postgresql://postgres:POSTGRES_PASSWORD@db.<ref>.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=eyJ...        # only if a client talks to Supabase directly
DB_DRIVER=postgres                      # sqlite | postgres
```

`SUPABASE_DB_URL` should include `?sslmode=require` for hosted Supabase; the
adapter enables TLS automatically when it sees that. Never commit real keys —
`.env` is already gitignored.

---

## 4. How the Postgres backend is wired (implemented)

The migration is done — the server runs on either driver with no code changes:

1. **Driver switch** — `server/src/config.js` reads `DB_DRIVER` (`sqlite` |
   `postgres`) and `SUPABASE_DB_URL` (falls back to `DATABASE_URL`). It throws
   early if `postgres` is selected without a URL.
2. **Selector** — `server/src/db.js` lazily requires `./db.sqlite` or `./db.pg`
   based on the driver, so the unused adapter (and `better-sqlite3`'s native
   binding, or `pg`) is never loaded.
3. **Async adapter** — `server/src/db.pg.js` implements the exact same exported
   functions as the SQLite adapter, but async, using a `pg` Pool. Shape parity is
   enforced: `bigint` ids and `COUNT(*)` are coerced to `Number`, boolean
   `delivered`/`read` are returned as `0`/`1`, and unique-violations are
   re-thrown with a `UNIQUE` message so `routes.js` still returns HTTP 409.
4. **Awaited call sites** — every `db.*` call in `routes.js` and `ws.js` is now
   `await`ed. Express handlers are `async`; the WS message dispatcher wraps
   `handleMessage` in a promise chain so async rejections still produce the
   `{type:'error'}` reply. Awaiting a synchronous SQLite return value is a
   no-op, so one code path serves both drivers.
5. **Auth unchanged** — the server still owns `users` with bcrypt + its own JWT.
   The RLS policies in the migration are written to also work if you later adopt
   Supabase Auth (`users.id = auth.users.id`).
6. **Shutdown** — `index.js` `stop()` calls `db.close()`, which drains the pg
   Pool (or closes the SQLite handle) so the process exits cleanly.
7. **Tests** — `server/test/db.pg.test.js` round-trips users, contacts,
   messages, groups, and calls against a live Postgres. It **skips** unless
   `TEST_PG_URL` is set, keeping the default `npm test` on ephemeral SQLite.

To flip a deployment to Postgres: apply `migrations/0001_init.sql`, then set
`DB_DRIVER=postgres` and `SUPABASE_DB_URL` in `server/.env` and restart. Run the
integration test above first — it has not yet been executed against a real DB.

---

## 5. Which Postgres features buy you

- **Multi-instance**: SQLite is single-writer; Postgres lets you run several
  app replicas behind a load balancer (needed for scale / Lane A teams).
- **Realtime**: Supabase Realtime can push DB changes to clients directly —
  an alternative to your custom WS fan-out for chat (calls still need your WS
  signaling for WebRTC offer/answer).
- **Managed backups, PITR, dashboard** — the "manage the app" surface you asked
  for: browse rows, run SQL, see auth users, all from Studio.
