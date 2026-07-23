// ShopifyQL inventory adjustment history is the audit source: unlike the
// inventory_levels/update webhook it includes actor/app, reason, state and
// reference document. Windows overlap deliberately; external_change_id makes
// ingestion idempotent.
import { graphql } from './shopify.js';
import { q, getState, setState } from './db.js';

const MAX_ROWS = 1000;
const MIN_SPLIT_MS = 1000;

function isoSecond(value) {
  return new Date(value).toISOString().slice(0, 19);
}

export function normalizeGid(type, value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return text.startsWith('gid://') ? text : `gid://shopify/${type}/${text}`;
}

export function buildHistoryQuery(start, end, limit = MAX_ROWS) {
  return `FROM inventory_adjustment_history
SHOW inventory_adjustment_change
SINCE ${isoSecond(start)} UNTIL ${isoSecond(end)}
GROUP BY second, inventory_adjustment_group_id, inventory_adjustment_id, inventory_item_id, product_variant_id, inventory_location_id, inventory_location_name, inventory_state, inventory_change_reason, inventory_app_id, inventory_app_name, staff_id, staff_member_name, reference_document_uri, reference_document_type, reference_document_id
ORDER BY second ASC
LIMIT ${limit}`;
}

export function classifyHistorySource(row) {
  const ref = String(row.reference_document_type || row.reference_document_uri || '').toLowerCase();
  const reason = String(row.inventory_change_reason || '').toLowerCase();
  if (ref.includes('transfer') || reason.includes('transfer')) return 'transfer';
  if (ref.includes('order')) return 'order';
  if (reason.includes('stocktake') || reason.includes('stock count')) return 'stocktake';
  if (row.staff_id || row.staff_member_name) return 'admin_manual';
  if (row.inventory_app_id || row.inventory_app_name) return 'external_app';
  return 'adjustment';
}

export function externalChangeId(row) {
  const adjustment = row.inventory_adjustment_id;
  if (adjustment !== null && adjustment !== undefined && adjustment !== '') {
    return `shopify:${adjustment}:${String(row.inventory_state || 'available').toLowerCase()}`;
  }
  return [
    'shopify', row.inventory_adjustment_group_id, row.inventory_item_id,
    row.inventory_location_id, row.inventory_state, row.second,
    row.inventory_adjustment_change,
  ].map((x) => String(x ?? '')).join(':');
}

export function groupAuditEvents(rows, levels = []) {
  const events = new Map();
  for (const row of rows) {
    const key = `${row.event_id}:${row.location}`;
    if (!events.has(key)) {
      events.set(key, {
        id: key,
        occurred_at: row.event_occurred_at || row.occurred_at,
        activity: row.activity || row.reason_code || row.source_type,
        reason: row.event_reason || row.reason_code,
        created_by: row.staff_name || row.event_app_name || row.actor_name || row.app_name || null,
        app_name: row.event_app_name || row.app_name || null,
        staff_name: row.staff_name || null,
        reference_document_uri: row.event_reference_uri || row.reference_document_uri || null,
        source_type: row.event_source_type || row.source_type,
        location: row.location,
        changes: {},
      });
    }
    const event = events.get(key);
    const existing = event.changes[row.state];
    const qtyAfter = row.computed_qty_after === null || row.computed_qty_after === undefined
      ? null : Number(row.computed_qty_after);
    event.changes[row.state] = existing
      ? { delta: existing.delta + Number(row.delta), qty_after: existing.qty_after ?? qtyAfter }
      : { delta: Number(row.delta), qty_after: qtyAfter };
  }
  const trackedByLocation = new Map(levels.map((level) => [
    level.name,
    {
      available: level.available, on_hand: level.on_hand,
      committed: level.committed, incoming: level.incoming,
      reserved: level.reserved, damaged: level.damaged,
      safety_stock: level.safety_stock, quality_control: level.quality_control,
    },
  ]));
  const states = ['available', 'on_hand', 'committed', 'incoming', 'reserved', 'damaged', 'safety_stock', 'quality_control'];
  for (const event of events.values()) {
    const tracked = trackedByLocation.get(event.location) || {};
    for (const state of states) {
      const change = event.changes[state];
      if (change) {
        if (change.qty_after === null && tracked[state] !== null && tracked[state] !== undefined) {
          change.qty_after = Number(tracked[state]);
        }
      } else {
        event.changes[state] = {
          delta: 0,
          qty_after: tracked[state] === null || tracked[state] === undefined ? null : Number(tracked[state]),
        };
      }
    }
    const available = event.changes.available;
    const onHand = event.changes.on_hand;
    if (available || onHand) {
      event.changes.unavailable = {
        delta: (onHand?.delta || 0) - (available?.delta || 0),
        qty_after: onHand?.qty_after !== null && onHand?.qty_after !== undefined
          && available?.qty_after !== null && available?.qty_after !== undefined
          ? onHand.qty_after - available.qty_after : null,
      };
    }
    for (const state of states) {
      const change = event.changes[state];
      if (change.qty_after !== null) tracked[state] = change.qty_after - change.delta;
    }
    trackedByLocation.set(event.location, tracked);
  }
  return [...events.values()];
}

function parseRows(response) {
  const result = response.shopifyqlQuery;
  if (result.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${result.parseErrors.join('; ')}`);
  return result.tableData?.rows || [];
}

async function queryWindow(ctx, start, end, depth = 0) {
  const data = await graphql(ctx, `
    query($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData { columns { name dataType displayName } rows }
        parseErrors
      }
    }`, { query: buildHistoryQuery(start, end) });
  const rows = parseRows(data);
  if (rows.length < MAX_ROWS) return rows;
  const startMs = +new Date(start);
  const endMs = +new Date(end);
  if (endMs - startMs <= MIN_SPLIT_MS || depth >= 20) {
    throw new Error(`ShopifyQL history window overflow at ${isoSecond(start)} (${rows.length}+ rows)`);
  }
  const mid = new Date(Math.floor((startMs + endMs) / 2));
  // Keep splits sequential. Parallel recursive queries exhaust ShopifyQL's
  // minute bucket and cause every retry to wake at the same reset boundary.
  const left = await queryWindow(ctx, new Date(startMs), mid, depth + 1);
  const right = await queryWindow(ctx, mid, new Date(endMs), depth + 1);
  const unique = new Map();
  for (const row of [...left, ...right]) unique.set(externalChangeId(row), row);
  return [...unique.values()];
}

async function enrichGroups(ctx, rows) {
  const gids = [...new Set(rows.map((row) =>
    normalizeGid('InventoryAdjustmentGroup', row.inventory_adjustment_group_id)).filter(Boolean))];
  const changes = new Map();
  for (let offset = 0; offset < gids.length; offset += 50) {
    const ids = gids.slice(offset, offset + 50);
    try {
      const data = await graphql(ctx, `
        query($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryAdjustmentGroup {
              id
              changes {
                name delta quantityAfterChange ledgerDocumentUri
                item { id }
                location { id }
              }
            }
          }
        }`, { ids });
      for (const group of data.nodes || []) {
        if (!group) continue;
        for (const change of group.changes || []) {
          const key = [
            group.id, change.item?.id, change.location?.id,
            change.name, change.delta,
          ].map((x) => String(x ?? '')).join('|');
          const bucket = changes.get(key) || [];
          bucket.push(change);
          changes.set(key, bucket);
        }
      }
    } catch (error) {
      // Attribution from ShopifyQL remains useful when old adjustment-group
      // nodes are unavailable; qty_after will be reconstructed from current.
      console.warn('[history] group enrichment skipped:', error.message);
    }
  }
  return changes;
}

async function upsertEvent(row) {
  const groupGid = normalizeGid('InventoryAdjustmentGroup', row.inventory_adjustment_group_id);
  const sourceType = classifyHistorySource(row);
  const r = await q(`
    INSERT INTO inventory_events
      (shopify_group_gid, occurred_at, activity, reason, app_shopify_id, app_name,
       staff_shopify_id, staff_name, reference_document_uri, reference_document_type,
       reference_document_id, source_type, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (shopify_group_gid) DO UPDATE SET
      activity=COALESCE(inventory_events.activity, EXCLUDED.activity),
      reason=COALESCE(inventory_events.reason, EXCLUDED.reason),
      app_name=COALESCE(inventory_events.app_name, EXCLUDED.app_name),
      staff_name=COALESCE(inventory_events.staff_name, EXCLUDED.staff_name),
      reference_document_uri=COALESCE(inventory_events.reference_document_uri, EXCLUDED.reference_document_uri)
    RETURNING id`,
    [
      groupGid, row.second, row.inventory_change_reason, row.inventory_change_reason,
      row.inventory_app_id ? String(row.inventory_app_id) : null, row.inventory_app_name || null,
      row.staff_id ? String(row.staff_id) : null, row.staff_member_name || null,
      row.reference_document_uri || null, row.reference_document_type || null,
      row.reference_document_id ? String(row.reference_document_id) : null,
      sourceType, JSON.stringify(row),
    ]);
  return { id: r.rows[0].id, groupGid, sourceType };
}

async function ingestRow(row, enriched, lookup) {
  const itemGid = normalizeGid('InventoryItem', row.inventory_item_id);
  const locationGid = normalizeGid('Location', row.inventory_location_id);
  const itemId = lookup.items.get(itemGid);
  const locationId = lookup.locations.get(locationGid);
  if (!itemId || !locationId) return { skipped: true };

  const groupKey = normalizeGid('InventoryAdjustmentGroup', row.inventory_adjustment_group_id)
    || externalChangeId(row);
  let event = lookup.events.get(groupKey);
  if (!event) {
    event = await upsertEvent(row);
    lookup.events.set(groupKey, event);
  }
  const state = String(row.inventory_state || 'available').toLowerCase();
  const delta = Number(row.inventory_adjustment_change || 0);
  const enrichKey = [
    event.groupGid, itemGid, locationGid, state, delta,
  ].map((x) => String(x ?? '')).join('|');
  const detail = enriched.get(enrichKey)?.shift() || null;
  const changeId = externalChangeId(row);
  const actorName = row.staff_member_name || row.inventory_app_name || null;

  // Prefer enriching the webhook row that represents the same change rather
  // than inserting a duplicate audit row.
  const matched = await q(`
    UPDATE inventory_ledger SET
      event_id=$1, external_change_id=$2, source_type=$3, source_ref=$4,
      reason_code=$5, app_name=$6, actor_name=$7, reference_document_uri=$8,
      ledger_document_uri=$9, attribution='shopifyql', attributed_at=now()
    WHERE id = (
      SELECT id FROM inventory_ledger
      WHERE item_id=$10 AND location_id=$11 AND state=$12 AND delta=$13
        AND external_change_id IS NULL
        AND source_type IN ('unknown','external_app')
        AND occurred_at BETWEEN $14::timestamptz - interval '10 minutes'
                            AND $14::timestamptz + interval '10 minutes'
      ORDER BY abs(extract(epoch FROM (occurred_at - $14::timestamptz))) ASC
      LIMIT 1
    )`,
    [
      event.id, changeId, event.sourceType, row.reference_document_uri || null,
      row.inventory_change_reason || null, row.inventory_app_name || null,
      actorName, row.reference_document_uri || null, detail?.ledgerDocumentUri || null,
      itemId, locationId, state, delta, row.second,
    ]);
  if (matched.rowCount) return { matched: true };

  const inserted = await q(`
    INSERT INTO inventory_ledger
      (item_id, location_id, state, delta, qty_after, occurred_at, source_type,
       source_ref, reason_code, attribution, attributed_at, event_id,
       external_change_id, app_name, actor_name, reference_document_uri,
       ledger_document_uri)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'shopifyql',now(),$10,$11,$12,$13,$14,$15)
    ON CONFLICT (external_change_id) WHERE external_change_id IS NOT NULL DO NOTHING`,
    [
      itemId, locationId, state, delta,
      detail?.quantityAfterChange ?? null, row.second, event.sourceType,
      row.reference_document_uri || null, row.inventory_change_reason || null,
      event.id, changeId, row.inventory_app_name || null, actorName,
      row.reference_document_uri || null, detail?.ledgerDocumentUri || null,
    ]);
  return { inserted: inserted.rowCount > 0 };
}

export async function runHistorySync(ctx, {
  since = null, until = null, days = 2, incremental = true,
} = {}) {
  const state = await getState('inventory_history_sync');
  const end = until ? new Date(until) : new Date();
  const defaultStart = new Date(+end - days * 86400000);
  const requestedStart = since ? new Date(since) : defaultStart;
  if (!Number.isFinite(+requestedStart) || !Number.isFinite(+end) || requestedStart >= end) {
    throw new Error('invalid inventory history date range');
  }

  const mode = incremental ? 'incremental' : 'backfill';
  const direction = incremental ? 'forward' : 'backward';
  // Incremental runs overlap two minutes. Backfills run newest-first so the
  // product screen becomes useful immediately, then continue towards day 180.
  const incrementalStart = incremental && state?.mode === 'incremental' && state?.cursor
    ? new Date(+new Date(state.cursor) - 120000)
    : requestedStart;
  const resumeBackfill = !incremental && state?.mode === 'backfill'
    && state?.direction === 'backward' && state?.cursor
    && +new Date(state.cursor) > +requestedStart;
  const backfillEnd = resumeBackfill
    ? new Date(Math.min(+end, +new Date(state.cursor) + 120000))
    : end;
  const syncStart = requestedStart.toISOString();
  let fetched = 0, inserted = 0, matched = 0, skipped = 0;
  const [itemRows, locationRows] = await Promise.all([
    q('SELECT id, shopify_inventory_item_gid FROM items WHERE shopify_inventory_item_gid IS NOT NULL'),
    q('SELECT id, shopify_gid FROM locations WHERE shopify_gid IS NOT NULL'),
  ]);
  const lookup = {
    items: new Map(itemRows.rows.map((row) => [row.shopify_inventory_item_gid, row.id])),
    locations: new Map(locationRows.rows.map((row) => [row.shopify_gid, row.id])),
    events: new Map(),
  };

  const consumeWindow = async (windowStart, windowEnd, running, cursor) => {
    const rows = await queryWindow(ctx, new Date(windowStart), new Date(windowEnd));
    fetched += rows.length;
    const enriched = await enrichGroups(ctx, rows);
    for (const row of rows) {
      const result = await ingestRow(row, enriched, lookup);
      if (result.inserted) inserted++;
      else if (result.matched) matched++;
      else skipped++;
    }
    await setState('inventory_history_sync', {
      cursor: new Date(cursor).toISOString(),
      fetched, inserted, matched, skipped,
      running, mode, direction, start: syncStart,
      heartbeat: new Date().toISOString(),
    });
  };

  if (incremental) {
    for (let windowStart = +incrementalStart; windowStart < +end; windowStart += 86400000) {
      const windowEnd = Math.min(windowStart + 86400000, +end);
      await consumeWindow(windowStart, windowEnd, windowEnd < +end, windowEnd);
    }
  } else {
    for (let windowEnd = +backfillEnd; windowEnd > +requestedStart;) {
      const windowStart = Math.max(+requestedStart, windowEnd - 86400000);
      await consumeWindow(windowStart, windowEnd, windowStart > +requestedStart, windowStart);
      windowEnd = windowStart;
    }
  }
  const summary = {
    cursor: incremental ? end.toISOString() : requestedStart.toISOString(),
    fetched, inserted, matched, skipped,
    finishedAt: new Date().toISOString(), running: false,
    mode, direction, start: syncStart,
  };
  await setState('inventory_history_sync', summary);
  return summary;
}
