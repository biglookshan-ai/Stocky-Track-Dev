// Per-shop offline access token cache (obtained via token exchange).
// The durable copy is encrypted in Postgres so stateless Railway deploys do not
// pause webhook processing. DATA_DIR remains a best-effort local cache.
// SHOPIFY_ADMIN_TOKEN, if set, overrides everything (single fixed token).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.js';

const DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const FILE = path.join(DIR, 'tokens.json');
let map = null;

function load() {
  if (map) return map;
  try { map = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { map = {}; }
  return map;
}
function save() {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(map)); }
  catch (e) { console.error('token persist failed (set DATA_DIR to a Railway volume):', e.message); }
}

function keyFor(secret) {
  if (!secret) throw new Error('SHOPIFY_API_SECRET not set');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptToken(token, secret = process.env.SHOPIFY_API_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, encrypted].map((part) =>
    Buffer.isBuffer(part) ? part.toString('base64url') : part).join(':');
}

export function decryptToken(value, secret = process.env.SHOPIFY_API_SECRET) {
  const [version, iv, tag, encrypted] = String(value || '').split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('invalid stored token');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFor(secret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export async function getToken(shop) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const cached = load()[shop];
  if (cached) return cached;
  const stored = await q(
    `SELECT offline_token_ciphertext
     FROM shops WHERE shop_domain=$1`,
    [shop],
  ).catch(() => ({ rows: [] }));
  const ciphertext = stored.rows[0]?.offline_token_ciphertext;
  if (!ciphertext) return null;
  const token = decryptToken(ciphertext);
  map[shop] = token;
  save();
  return token;
}

export async function setToken(shop, token) {
  load();
  map[shop] = token;
  save();
  await q(
    `INSERT INTO shops (shop_domain, offline_token_ciphertext, token_updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (shop_domain) DO UPDATE SET
       offline_token_ciphertext=EXCLUDED.offline_token_ciphertext,
       token_updated_at=now()`,
    [shop, encryptToken(token)],
  );
}

export async function clearToken(shop) {
  load();
  delete map[shop];
  save();
  await q(
    `UPDATE shops SET offline_token_ciphertext=NULL, token_updated_at=now()
     WHERE shop_domain=$1`,
    [shop],
  );
}
