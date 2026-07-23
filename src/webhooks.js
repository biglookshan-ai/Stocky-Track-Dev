// Webhook intake + background processing.
// Intake is dumb and fast: verify HMAC, archive the raw payload (idempotent on
// X-Shopify-Webhook-Id), return 200. All real work happens in processPending(),
// driven by the scheduler — the appproxy lesson: write to DB first, do
// everything else in the background.
import crypto from 'node:crypto';
import { q } from './db.js';
import { recordLevelUpdate, upsertCurrentLevel } from './ledger.js';
import { INVENTORY_STATES, upsertProductFromWebhook } from './catalog.js';
import { graphql, offlineCtx } from './shopify.js';

const SECRET = () => process.env.SHOPIFY_API_SECRET || '';

export function verifyHmac(rawBody, hmacHeader) {
  const digest = crypto.createHmac('sha256', SECRET()).update(rawBody).digest('base64');
  const a = Buffer.from(digest), b = Buffer.from(hmacHeader || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express handler for POST /webhooks (all topics share one endpoint).
export async function receive(req, res) {
  try {
    if (!verifyHmac(req.rawBody, req.headers['x-shopify-hmac-sha256'])) {
      return res.status(401).send('bad hmac');
    }
    await q(
      `INSERT INTO webhook_events (webhook_id, topic, shop_domain, payload)
       VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (webhook_id) DO NOTHING`,
      [
        req.headers['x-shopify-webhook-id'] || crypto.randomUUID(),
        req.headers['x-shopify-topic'] || 'unknown',
        req.headers['x-shopify-shop-domain'] || '',
        req.rawBody.toString('utf8'),
      ]
    );
    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhooks] intake failed:', e.message);
    // 500 → Shopify retries; the ON CONFLICT makes retries safe.
    res.status(500).send('error');
  }
}

// Process unhandled events oldest-first. Called by the scheduler.
export async function processPending(limit = 200) {
  const rows = await q(
    `SELECT id, topic, shop_domain, payload FROM webhook_events
     WHERE processed_at IS NULL ORDER BY id ASC LIMIT $1`, [limit]);
  let done = 0;
  for (const ev of rows.rows) {
    try {
      await handle(ev.topic, ev.payload, ev.shop_domain);
      await q('UPDATE webhook_events SET processed_at = now(), error = NULL WHERE id = $1', [ev.id]);
      done++;
    } catch (e) {
      // Leave unprocessed for retry, but record the error; a poisoned event
      // will be retried each tick until fixed — visible on /api/status.
      await q('UPDATE webhook_events SET error = $2 WHERE id = $1', [ev.id, String(e.message || e).slice(0, 500)]);
      console.error(`[webhooks] process ${ev.topic} #${ev.id} failed:`, e.message);
    }
  }
  return done;
}

async function handle(topic, p, shopDomain) {
  switch (topic) {
    case 'inventory_levels/update': {
      const item = await q(
        `SELECT id FROM items WHERE shopify_inventory_item_gid = $1`,
        [`gid://shopify/InventoryItem/${p.inventory_item_id}`]);
      const loc = await q(
        `SELECT id FROM locations WHERE shopify_gid = $1`,
        [`gid://shopify/Location/${p.location_id}`]);
      if (!item.rowCount) throw new Error(`unknown inventory_item ${p.inventory_item_id} (run catalog sync)`);
      if (!loc.rowCount) throw new Error(`unknown location ${p.location_id}`);
      if (typeof p.available !== 'number') return; // untracked item — nothing to record
      const ctx = offlineCtx(shopDomain || null);
      const levelGid = `gid://shopify/InventoryLevel/${p.location_id}?inventory_item_id=${p.inventory_item_id}`;
      const data = await graphql(ctx, `
        query($id: ID!) {
          inventoryLevel(id: $id) {
            quantities(names: ["available", "on_hand", "committed", "incoming", "reserved", "damaged", "safety_stock", "quality_control"]) {
              name quantity
            }
          }
        }`, { id: levelGid });
      const quantities = {};
      for (const entry of data.inventoryLevel?.quantities || []) quantities[entry.name] = entry.quantity;
      if (quantities.available === null || quantities.available === undefined) quantities.available = p.available;
      for (const state of INVENTORY_STATES) {
        if (!(state in quantities)) quantities[state] = null;
      }
      await recordLevelUpdate({
        itemId: item.rows[0].id,
        locationId: loc.rows[0].id,
        available: quantities.available ?? p.available,
        occurredAt: p.updated_at || new Date().toISOString(),
      });
      await upsertCurrentLevel(item.rows[0].id, loc.rows[0].id, quantities);
      return;
    }
    case 'products/update':
    case 'products/create':
      return upsertProductFromWebhook(p);
    case 'products/delete':
      await q(`UPDATE items SET status = 'deleted', updated_at = now() WHERE shopify_product_gid = $1`,
        [`gid://shopify/Product/${p.id}`]);
      return;
    case 'inventory_items/update':
      await q(
        `UPDATE items SET sku = COALESCE($2, sku), tracked = COALESCE($3, tracked),
                unit_cost = COALESCE($4, unit_cost), updated_at = now()
         WHERE shopify_inventory_item_gid = $1`,
        [`gid://shopify/InventoryItem/${p.id}`, p.sku || null,
         typeof p.tracked === 'boolean' ? p.tracked : null,
         p.cost != null ? p.cost : null]);
      return;
    case 'locations/create':
    case 'locations/update':
      await q(`INSERT INTO locations (shopify_gid, name, active) VALUES ($1,$2,$3)
               ON CONFLICT (shopify_gid) DO UPDATE SET name=$2, active=$3`,
        [`gid://shopify/Location/${p.id}`, p.name || '', p.active !== false]);
      return;
    // orders/create & refunds/create stay in webhook_events as raw material
    // for the attribution pass — no direct handling needed.
    case 'orders/create':
    case 'refunds/create':
      return;
    default:
      return; // unknown topic: archive only
  }
}

// Register all needed subscriptions (idempotent: Shopify de-dupes by topic+url).
const TOPICS = [
  'INVENTORY_LEVELS_UPDATE', 'INVENTORY_ITEMS_UPDATE',
  'PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE',
  'LOCATIONS_CREATE', 'LOCATIONS_UPDATE',
  'ORDERS_CREATE', 'REFUNDS_CREATE',
];

export async function registerAll(ctx, appUrl) {
  const url = `${appUrl.replace(/\/$/, '')}/webhooks`;
  const results = [];
  for (const topic of TOPICS) {
    const data = await graphql(ctx, `
      mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`, { topic, sub: { callbackUrl: url, format: 'JSON' } });
    const errs = data.webhookSubscriptionCreate.userErrors;
    // "already taken" errors mean the subscription exists — fine.
    const ok = !errs.length || errs.every((e) => /taken|exists/i.test(e.message));
    results.push({ topic, ok, errors: ok ? [] : errs });
  }
  return results;
}

export async function listSubscriptions(ctx) {
  const data = await graphql(ctx, `{
    webhookSubscriptions(first: 50) {
      nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
    }
  }`);
  return data.webhookSubscriptions.nodes;
}
