// Applies every SQL file in supabase/migrations (in lexical order) against the
// configured Postgres/Supabase database. Migrations are written to be idempotent
// (IF NOT EXISTS guards), so re-running is safe.
//
// Usage:  node scripts/migrate.js
// Reads SUPABASE_DB_URL / DATABASE_URL from server/.env via ../src/config.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');

// Mirror db.pg.js TLS handling: pg 8.x parses sslmode=require as verify-full and
// overrides the explicit ssl option, breaking against managed certs. Strip it and
// pass our own ssl object. PG_REJECT_UNAUTHORIZED=1 opts into full verification.
const SSLMODE_RE = /([?&])sslmode=[^&]*/i;
const wantsTls = SSLMODE_RE.test(config.databaseUrl);
const rejectUnauthorized = process.env.PG_REJECT_UNAUTHORIZED === '1';
const connectionString = config.databaseUrl.replace(SSLMODE_RE, '$1').replace(/[?&]$/, '');

if (!connectionString) {
  console.error('No database URL. Set SUPABASE_DB_URL (or DATABASE_URL) in server/.env.');
  process.exit(1);
}

const migrationsDir = path.join(__dirname, '..', '..', 'supabase', 'migrations');

async function main() {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const pool = new Pool({
    connectionString,
    ssl: wantsTls ? { rejectUnauthorized } : undefined,
    max: 1,
  });
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`Applying ${file} … `);
      await pool.query(sql);
      console.log('ok');
    }
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log('public tables:', rows.map((r) => r.table_name).join(', '));
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
