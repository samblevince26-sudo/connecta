// Data-layer selector. Both adapters expose the identical function interface;
// the SQLite one is synchronous and the Postgres one is async, and every call
// site `await`s the result so either works transparently.
//
// Set DB_DRIVER=postgres (plus SUPABASE_DB_URL) to run on Postgres/Supabase;
// the default 'sqlite' keeps the bundled single-file database.
const config = require('./config');

const driver = String(config.dbDriver || 'sqlite').toLowerCase();

if (driver === 'postgres' || driver === 'pg') {
  module.exports = require('./db.pg');
} else if (driver === 'sqlite') {
  module.exports = require('./db.sqlite');
} else {
  throw new Error(`Unknown DB_DRIVER "${driver}" (expected "sqlite" or "postgres").`);
}
