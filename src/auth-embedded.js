// Embedded-app auth: verify the App Bridge session token (a JWT signed with the
// app secret), then OAuth 2.0 Token Exchange to get an offline Admin API token.
// Same pattern as search-panel-dev. Additionally resolves the acting staff row
// (payload.sub = Shopify admin user id) so every write can be attributed.
import crypto from 'node:crypto';
import { getToken, setToken } from './token-store.js';
import { q } from './db.js';

const KEY = process.env.SHOPIFY_API_KEY;
const SECRET = process.env.SHOPIFY_API_SECRET;

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Returns { shop, payload } or throws.
export function verifySessionToken(token) {
  if (!SECRET || !KEY) throw new Error('SHOPIFY_API_KEY / SHOPIFY_API_SECRET not set');
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed session token');
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
  const payload = JSON.parse(b64urlToBuf(p).toString());
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error('session token expired');
  if (payload.nbf && now < payload.nbf - 5) throw new Error('session token not yet valid');
  if (payload.aud !== KEY) throw new Error('aud mismatch');
  const shop = String(payload.dest || '').replace(/^https?:\/\//, '');
  if (!/^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop)) throw new Error('bad dest/shop');
  return { shop, payload };
}

// Get an offline access token for the shop (cached), via token exchange.
export async function getAccessToken(shop, sessionToken) {
  const cached = getToken(shop);
  if (cached) return cached;
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: KEY,
      client_secret: SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(j)}`);
  setToken(shop, j.access_token);
  return j.access_token;
}

// Upsert-and-return the staff row for the admin user in the session token.
async function resolveStaff(payload) {
  const uid = payload.sub ? String(payload.sub) : null;
  if (!uid) return null;
  const r = await q(
    `INSERT INTO staff (shopify_user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (shopify_user_id) DO UPDATE SET shopify_user_id = EXCLUDED.shopify_user_id
     RETURNING id, display_name, role`,
    [uid, `user ${uid}`]  // display name is edited later in Settings → 员工映射
  );
  return r.rows[0] || null;
}

// Express middleware: Authorization: Bearer <session token>
// → req.ctx = { shop, token, staff }
export function requireSession() {
  return async (req, res, next) => {
    try {
      const h = req.headers.authorization || '';
      const sessionToken = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!sessionToken) return res.status(401).json({ error: 'Missing session token', needsAuth: true });
      const { shop, payload } = verifySessionToken(sessionToken);
      const token = process.env.SHOPIFY_ADMIN_TOKEN || await getAccessToken(shop, sessionToken);
      const staff = await resolveStaff(payload).catch(() => null);
      req.ctx = { shop, token, staff };
      next();
    } catch (e) {
      res.status(401).json({ error: String(e.message || e), needsAuth: true });
    }
  };
}
