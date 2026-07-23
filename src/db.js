// Postgres pool + file-based migrations. Unlike search-panel's analytics DB,
// the database here is mandatory: the ledger IS the product. Fail hard if
// DATABASE_URL is missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export let pool = null;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set — the ledger requires Postgres');
  const useSsl = process.env.PGSSLMODE === 'require' || /sslmode=require/i.test(url);
  pool = new pg.Pool({ connectionString: url, max: 8, ssl: useSsl ? { rejectUnauthorized: false } : false });
  await migrate();
  console.log('[db] connected, migrations applied');
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [f]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`[db] migrated ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${f} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

export function q(text, params) {
  return pool.query(text, params);
}

// Simple JSON state store (cursors, job locks, last-run times).
export async function getState(key) {
  const r = await q('SELECT value FROM sync_state WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}
export async function setState(key, value) {
  await q(`INSERT INTO sync_state (key, value, ts) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, ts = now()`, [key, JSON.stringify(value)]);
}

// Session-scoped advisory locks disappear automatically if a process restarts.
// A dedicated client must be held for the whole job because advisory locks are
// attached to the Postgres session, not to an individual query.
export async function withLock(name, _maxAgeMs, fn) {
  const client = await pool.connect();
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [name],
    );
    if (!lock.rows[0].locked) return { skipped: true };
    return { skipped: false, result: await fn() };
  } finally {
    await client.query(
      'SELECT pg_advisory_unlock(hashtext($1))',
      [name],
    ).catch(() => {});
    client.release();
  }
}
