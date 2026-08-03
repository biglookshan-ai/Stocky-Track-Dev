// Resolve Shopify business references into stable, readable snapshots.
// Raw InventoryAdjustment history often contains only an internal GID. This
// module turns it into an Order/Transfer number, customer, status and Admin URL
// while retaining the original event data when a scope is unavailable.
import { q } from './db.js';
import { graphql } from './shopify.js';

const CACHE_MS = 15 * 60 * 1000;

// Exact matching only. A substring test used to classify 'TransferAdjustment'
// (what Shopify reports for a manual stock edit made while a transfer exists)
// as an InventoryTransfer, which produced an /inventory/transfers/<id> link
// that 404s because the id is not a transfer id.
function normalizedType(value) {
  const compact = String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (compact === 'order') return 'Order';
  if (compact === 'transfer' || compact === 'inventorytransfer') return 'InventoryTransfer';
  if (compact === 'purchaseorder') return 'PurchaseOrder';
  return value ? String(value) : null;
}

export function canonicalReference(row = {}) {
  const uri = String(row.reference_document_uri || '').trim();
  const gid = uri.match(/^gid:\/\/shopify\/([^/]+)\/(.+)$/i);
  const type = normalizedType(row.reference_document_type || gid?.[1]);
  const id = String(row.reference_document_id || gid?.[2] || '').trim();
  if (!type || !id || !['Order', 'InventoryTransfer'].includes(type)) return null;
  return {
    canonicalUri: `gid://shopify/${type}/${id}`,
    type,
    id,
    originalUri: uri || null,
  };
}

export function referenceAdminUrl(shop, type, id) {
  const handle = String(shop || '').replace(/\.myshopify\.com$/i, '');
  if (!handle || !id) return null;
  const encoded = encodeURIComponent(id);
  if (type === 'Order') {
    return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/orders/${encoded}`;
  }
  if (type === 'InventoryTransfer') {
    return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/inventory/transfers/${encoded}`;
  }
  return null;
}

async function cacheRows(refs) {
  if (!refs.length) return new Map();
  const result = await q(
    `SELECT * FROM reference_documents WHERE canonical_uri=ANY($1::text[])`,
    [refs.map((ref) => ref.canonicalUri)],
  );
  return new Map(result.rows.map((row) => [row.canonical_uri, row]));
}

async function saveReference(ref, data, ctx, error = null) {
  const details = data?.details || null;
  const result = await q(
    `INSERT INTO reference_documents
       (canonical_uri, document_type, shopify_id, display_name, customer_name,
        status, admin_url, details, fetched_at, fetch_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now(),$9)
     ON CONFLICT (canonical_uri) DO UPDATE SET
       display_name=COALESCE(EXCLUDED.display_name, reference_documents.display_name),
       customer_name=COALESCE(EXCLUDED.customer_name, reference_documents.customer_name),
       status=COALESCE(EXCLUDED.status, reference_documents.status),
       admin_url=COALESCE(EXCLUDED.admin_url, reference_documents.admin_url),
       details=COALESCE(EXCLUDED.details, reference_documents.details),
       fetched_at=now(), fetch_error=EXCLUDED.fetch_error
     RETURNING *`,
    [
      ref.canonicalUri, ref.type, ref.id, data?.displayName || null,
      data?.customerName || null, data?.status || null,
      referenceAdminUrl(ctx.shop, ref.type, ref.id),
      details ? JSON.stringify(details) : null,
      error ? String(error.message || error).slice(0, 500) : null,
    ],
  );
  return result.rows[0];
}

async function fetchOrders(ctx, refs) {
  if (!refs.length) return [];
  const data = await graphql(ctx, `
    query ResolveInventoryOrders($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
          customer { displayName }
        }
      }
    }`, { ids: refs.map((ref) => ref.canonicalUri) });
  const byId = new Map((data.nodes || []).filter(Boolean).map((node) => [node.id, node]));
  return Promise.all(refs.map((ref) => {
    const node = byId.get(ref.canonicalUri);
    return saveReference(ref, node ? {
      displayName: node.name,
      customerName: node.customer?.displayName || null,
      status: [node.displayFinancialStatus, node.displayFulfillmentStatus].filter(Boolean).join(' · '),
      details: {
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
      },
    } : null, ctx, node ? null : new Error('Order unavailable or outside access window'));
  }));
}

async function fetchTransfers(ctx, refs) {
  if (!refs.length) return [];
  const data = await graphql(ctx, `
    query ResolveInventoryTransfers($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on InventoryTransfer {
          id
          name
          referenceName
          status
          origin { name }
          destination { name }
        }
      }
    }`, { ids: refs.map((ref) => ref.canonicalUri) });
  const byId = new Map((data.nodes || []).filter(Boolean).map((node) => [node.id, node]));
  return Promise.all(refs.map((ref) => {
    const node = byId.get(ref.canonicalUri);
    return saveReference(ref, node ? {
      displayName: node.referenceName || node.name,
      status: node.status,
      details: {
        name: node.name,
        referenceName: node.referenceName,
        origin: node.origin?.name || null,
        destination: node.destination?.name || null,
      },
    } : null, ctx, node ? null : new Error('Transfer unavailable or missing read_inventory_transfers'));
  }));
}

export async function enrichReferences(ctx, rows) {
  const refs = [...new Map(rows.map((row) => {
    const ref = canonicalReference(row);
    return ref ? [ref.canonicalUri, ref] : null;
  }).filter(Boolean)).values()];
  if (!refs.length) return rows;

  const cached = await cacheRows(refs);
  const stale = refs.filter((ref) => {
    const row = cached.get(ref.canonicalUri);
    return !row || Date.now() - +new Date(row.fetched_at) > CACHE_MS;
  });
  for (const [type, fetcher] of [
    ['Order', fetchOrders],
    ['InventoryTransfer', fetchTransfers],
  ]) {
    const pending = stale.filter((ref) => ref.type === type);
    if (!pending.length) continue;
    try {
      const refreshed = await fetcher(ctx, pending);
      for (const row of refreshed) cached.set(row.canonical_uri, row);
    } catch (error) {
      // One missing optional scope must not prevent the audit page from loading.
      for (const ref of pending) {
        const fallback = await saveReference(ref, null, ctx, error);
        cached.set(ref.canonicalUri, fallback);
      }
    }
  }

  return rows.map((row) => {
    const ref = canonicalReference(row);
    const cachedRow = ref ? cached.get(ref.canonicalUri) : null;
    return {
      ...row,
      reference_name: cachedRow?.display_name || null,
      reference_customer_name: cachedRow?.customer_name || null,
      reference_status: cachedRow?.status || null,
      reference_admin_url: cachedRow?.admin_url || null,
      reference_details: cachedRow?.details || null,
      reference_fetch_error: cachedRow?.fetch_error || null,
    };
  });
}
