// Shopify Admin GraphQL client with throttle-aware retry and idempotency keys.
// ctx = { shop, token } — per-request from the session token, or built from the
// stored offline token for background jobs (see offlineCtx).
import crypto from 'node:crypto';
import { getToken } from './token-store.js';

const VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

// Background jobs (webhook processing, snapshots) have no session token; they
// use the offline token cached at install time. SHOP env pins the store.
export function offlineCtx(shopOverride = null) {
  const shop = shopOverride || process.env.SHOP;
  if (!shop) throw new Error('SHOP not set');
  const token = getToken(shop);
  if (!token) throw new Error(`no offline token for ${shop} yet — open the app in Shopify admin once`);
  return { shop, token };
}

export async function graphql(ctx, query, variables = {}, { retries = 8 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${ctx.shop}/admin/api/${VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ctx.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('Retry-After') || 2) * 1000;
      await sleep(wait);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(json)}`);
    const throttled = (json.errors || []).some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < retries) {
      const errorCost = (json.errors || []).find((e) => e.extensions?.cost)?.extensions?.cost;
      const cost = json.extensions?.cost || errorCost;
      const resetAt = cost?.windowResetAt ? +new Date(cost.windowResetAt) : NaN;
      let wait = Number.isFinite(resetAt) ? resetAt - Date.now() + 1000 : 2000;
      if (cost?.throttleStatus?.restoreRate) {
        const deficit = Math.max(0, cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable);
        wait = Math.max(wait, Math.ceil(deficit / cost.throttleStatus.restoreRate * 1000));
      }
      await sleep(Math.min(60000, Math.max(1000, wait)));
      continue;
    }
    if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2026-04 requires an idempotency key on inventory mutations:
//   mutation ... @idempotent(key: "...")
export function idempotencyKey() {
  return crypto.randomUUID();
}

export function gidNum(gid) {
  return String(gid || '').split('/').pop();
}
