// Catalog sync: mirror Shopify locations + variants (with inventory levels)
// into locations/items/current_levels. Used for the initial full sync and for
// the daily snapshot pull. The initial sync sets the current_levels baseline
// WITHOUT writing ledger rows; after that, webhooks + snapshots keep it fresh.
import { graphql } from './shopify.js';
import { q, setState } from './db.js';

export const INVENTORY_STATES = [
  'available', 'on_hand', 'committed', 'incoming',
  'reserved', 'damaged', 'safety_stock', 'quality_control',
];

export async function syncLocations(ctx) {
  const data = await graphql(ctx, `{
    locations(first: 50, includeInactive: true) {
      nodes { id name isActive }
    }
  }`);
  for (const l of data.locations.nodes) {
    await q(`INSERT INTO locations (shopify_gid, name, active) VALUES ($1,$2,$3)
             ON CONFLICT (shopify_gid) DO UPDATE SET name = $2, active = $3`,
      [l.id, l.name, l.isActive]);
  }
  return data.locations.nodes.length;
}

const VARIANTS_PAGE = `
query($cursor: String) {
  productVariants(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku barcode price
      product { id title vendor status }
      inventoryItem {
        id tracked
        unitCost { amount }
        inventoryLevels(first: 10) {
          nodes {
            location { id }
            quantities(names: ["available", "on_hand", "committed", "incoming", "reserved", "damaged", "safety_stock", "quality_control"]) { name quantity }
          }
        }
      }
    }
  }
}`;

// Full variant walk. onLevel receives all Shopify inventory quantity states.
// called for every level; the caller decides what to do (baseline vs reconcile).
export async function walkVariants(ctx, onLevel, { progressKey = null } = {}) {
  const locByGid = await locationMap();
  let cursor = null, count = 0;
  for (;;) {
    const data = await graphql(ctx, VARIANTS_PAGE, { cursor });
    const page = data.productVariants;
    for (const v of page.nodes) {
      const itemId = await upsertVariant(v);
      count++;
      for (const lvl of v.inventoryItem?.inventoryLevels?.nodes || []) {
        const locId = locByGid.get(lvl.location.id);
        if (!locId) continue;
        const qty = {};
        for (const s of lvl.quantities) qty[s.name] = s.quantity;
        await onLevel(itemId, locId, qty);
      }
    }
    if (progressKey) await setState(progressKey, { count, done: !page.pageInfo.hasNextPage });
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return count;
}

export async function upsertVariant(v) {
  const r = await q(
    `INSERT INTO items (source, shopify_variant_gid, shopify_inventory_item_gid, shopify_product_gid,
                        product_title, variant_title, sku, barcode, vendor, price, unit_cost, tracked, status, updated_at)
     VALUES ('shopify', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (shopify_variant_gid) DO UPDATE SET
       shopify_inventory_item_gid = $2, shopify_product_gid = $3,
       product_title = $4, variant_title = $5, sku = $6, barcode = $7, vendor = $8,
       price = $9, unit_cost = $10, tracked = $11, status = $12, updated_at = now()
     RETURNING id`,
    [
      v.id, v.inventoryItem?.id || null, v.product?.id || null,
      v.product?.title || '', v.title || '', v.sku || '', v.barcode || '',
      v.product?.vendor || '', v.price ?? null,
      v.inventoryItem?.unitCost?.amount ?? null,
      v.inventoryItem?.tracked ?? true,
      (v.product?.status || 'ACTIVE').toLowerCase(),
    ]
  );
  return r.rows[0].id;
}

export async function locationMap() {
  const r = await q('SELECT id, shopify_gid FROM locations WHERE shopify_gid IS NOT NULL');
  return new Map(r.rows.map((x) => [x.shopify_gid, x.id]));
}

// Initial full sync: locations + variants + current_levels baseline.
export async function initialSync(ctx) {
  await syncLocations(ctx);
  const n = await walkVariants(ctx, async (itemId, locId, qty) => {
    await q(`INSERT INTO current_levels
               (item_id, location_id, available, on_hand, committed, incoming, reserved, damaged, safety_stock, quality_control, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
             ON CONFLICT (item_id, location_id) DO UPDATE
               SET available=$3, on_hand=$4, committed=$5, incoming=$6,
                   reserved=$7, damaged=$8, safety_stock=$9, quality_control=$10,
                   updated_at=now()`,
      [itemId, locId, ...INVENTORY_STATES.map((state) => qty[state] ?? null)]);
  }, { progressKey: 'initial_sync' });
  await setState('initial_sync', { count: n, done: true, finishedAt: new Date().toISOString() });
  return n;
}

// Refresh a single product from a products/update webhook payload (REST shape).
export async function upsertProductFromWebhook(payload) {
  for (const v of payload.variants || []) {
    await q(
      `INSERT INTO items (source, shopify_variant_gid, shopify_inventory_item_gid, shopify_product_gid,
                          product_title, variant_title, sku, barcode, vendor, price, tracked, status, updated_at)
       VALUES ('shopify', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (shopify_variant_gid) DO UPDATE SET
         product_title = $4, variant_title = $5, sku = $6, barcode = $7, vendor = $8,
         price = $9, status = $11, updated_at = now()`,
      [
        `gid://shopify/ProductVariant/${v.id}`,
        v.inventory_item_id ? `gid://shopify/InventoryItem/${v.inventory_item_id}` : null,
        `gid://shopify/Product/${payload.id}`,
        payload.title || '', v.title || '', v.sku || '', v.barcode || '',
        payload.vendor || '', v.price ?? null,
        v.inventory_management === 'shopify',
        (payload.status || 'active').toLowerCase(),
      ]
    );
  }
}
