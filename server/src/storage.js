// Local-disk file storage for message attachments.
//
// Files are written under config.uploadDir with an unguessable 128-bit hex id as
// the filename (no client-supplied extension, so the stored name can never carry
// a path). Metadata (owner, original name, mime, size) lives in the `uploads`
// table; this module only touches the filesystem.
//
// To move to object storage (e.g. Supabase Storage) later, reimplement these
// five functions — the routes and DB layer don't change.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(config.uploadDir, { recursive: true });

const ID_RE = /^[a-f0-9]{32}$/;

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

// Guards against path traversal: only our own hex ids ever reach the disk.
function pathFor(id) {
  if (!ID_RE.test(String(id))) throw new Error('Invalid upload id.');
  return path.join(config.uploadDir, id);
}

async function write(id, buffer) {
  await fsp.writeFile(pathFor(id), buffer);
}

function readStream(id) {
  return fs.createReadStream(pathFor(id));
}

async function remove(id) {
  try { await fsp.unlink(pathFor(id)); } catch { /* already gone */ }
}

module.exports = { newId, write, readStream, remove, pathFor, isValidId: (id) => ID_RE.test(String(id)) };
