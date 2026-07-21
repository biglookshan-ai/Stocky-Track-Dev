// Per-shop offline access token cache (obtained via token exchange).
// Persisted to DATA_DIR (mount a Railway volume so it survives redeploys).
// SHOPIFY_ADMIN_TOKEN, if set, overrides everything (single fixed token).
import fs from 'node:fs';
import path from 'node:path';

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

export function getToken(shop) {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  return load()[shop] || null;
}
export function setToken(shop, token) {
  load();
  map[shop] = token;
  save();
}
export function clearToken(shop) {
  load();
  delete map[shop];
  save();
}
