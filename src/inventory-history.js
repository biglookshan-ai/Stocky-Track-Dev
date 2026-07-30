// ShopifyQL inventory adjustment history is the audit source: unlike the
// inventory_levels/update webhook it includes actor/app, reason, state and
// reference document. Windows overlap deliberately; external_change_id makes
// ingestion idempotent.
import { graphql } from './shopify.js';
import { pool, q, getState, setState } from './db.js';

const MAX_ROWS = 1000;
const MIN_SPLIT_MS = 1000;
const INCREMENTAL_OVERLAP_MS = 2 * 86400000;
const SHOPIFYQL_PACE_MS = Number(process.env.SHOPIFYQL_PACE_MS || 16000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function historyWindowDays(incremental) {
  return incremental ? 2 : 7;
}

export function incrementalHistoryStart({ since, state, requestedStart }) {
  if (!since && state?.mode === 'incremental' && state?.cursor) {
    return new Date(Math.max(
      +requestedStart,
      +new Date(state.cursor) - INCREMENTAL_OVERLAP_MS,
    ));
  }
  return requestedStart;
}

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
        reference_document_type: row.event_reference_type || null,
        reference_document_id: row.event_reference_id || null,
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
  // A history query costs about 231 points against a 1,000-point minute
  // window. Proactive pacing is more reliable than repeatedly hitting 429.
  if (SHOPIFYQL_PACE_MS > 0) await delay(SHOPIFYQL_PACE_MS);
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
  const all = [];
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
          const enrichedChange = { ...change, groupId: group.id, consumed: false };
          const key = [
            group.id, change.item?.id, change.location?.id,
            change.name, change.delta,
          ].map((x) => String(x ?? '')).join('|');
          const bucket = changes.get(key) || [];
          bucket.push(enrichedChange);
          changes.set(key, bucket);
          all.push(enrichedChange);
        }
      }
    } catch (error) {
      // Attribution from ShopifyQL remains useful when old adjustment-group
      // nodes are unavailable; qty_after will be reconstructed from current.
      console.warn('[history] group enrichment skipped:', error.message);
    }
  }
  return { byMatch: changes, all };
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

async function mergeLedgerChange({
  event, changeId, itemId, locationId, state, delta, occurredAt,
  qtyAfter = null, sourceType, sourceRef = null, reasonCode = null,
  appName = null, actorName = null, referenceDocumentUri = null,
  ledgerDocumentUri = null,
}) {
  const mergeParams = [
    event.id, changeId, sourceType, sourceRef, reasonCode, appName, actorName,
    referenceDocumentUri, ledgerDocumentUri, qtyAfter,
    itemId, locationId, state, delta, occurredAt,
  ];

  // Prefer enriching the webhook row that represents the same change rather
  // than inserting a duplicate audit row. A retry can encounter both an
  // already-enriched canonical row and a later webhook placeholder. Merge that
  // placeholder into the canonical row first so assigning the existing
  // external_change_id never violates the unique index.
  const canonical = await q(`
    WITH updated AS (
      UPDATE inventory_ledger SET
        event_id=$1, source_type=$3, source_ref=$4,
        reason_code=$5, app_name=$6, actor_name=$7, reference_document_uri=$8,
        ledger_document_uri=$9, qty_after=COALESCE($10, qty_after),
        attribution='shopifyql', attributed_at=now()
      WHERE external_change_id=$2
      RETURNING id
    ),
    removed_placeholder AS (
      DELETE FROM inventory_ledger
      WHERE id = (
        SELECT lg.id
        FROM inventory_ledger lg
        JOIN inventory_events pe ON pe.id=lg.event_id
        WHERE lg.item_id=$11 AND lg.location_id=$12
          AND lg.state=$13 AND lg.delta=$14
          AND lg.external_change_id IS NULL
          AND pe.source_type='unknown'
          AND pe.shopify_group_gid LIKE 'webhook:%'
          AND lg.occurred_at BETWEEN $15::timestamptz - interval '10 minutes'
                                 AND $15::timestamptz + interval '10 minutes'
        ORDER BY abs(extract(epoch FROM (lg.occurred_at - $15::timestamptz))) ASC
        LIMIT 1
      )
        AND EXISTS (SELECT 1 FROM updated)
      RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM updated) AS found,
           EXISTS (SELECT 1 FROM removed_placeholder) AS merged`,
    mergeParams);
  if (canonical.rows[0]?.found) {
    return canonical.rows[0].merged ? { matched: true } : { skipped: true };
  }

  const matched = await q(`
    UPDATE inventory_ledger SET
      event_id=$1, external_change_id=$2, source_type=$3, source_ref=$4,
      reason_code=$5, app_name=$6, actor_name=$7, reference_document_uri=$8,
      ledger_document_uri=$9, qty_after=COALESCE($10, qty_after),
      attribution='shopifyql', attributed_at=now()
    WHERE id = (
      SELECT lg.id
      FROM inventory_ledger lg
      JOIN inventory_events pe ON pe.id=lg.event_id
      WHERE lg.item_id=$11 AND lg.location_id=$12
        AND lg.state=$13 AND lg.delta=$14
        AND lg.external_change_id IS NULL
        AND pe.source_type='unknown'
        AND pe.shopify_group_gid LIKE 'webhook:%'
        AND lg.occurred_at BETWEEN $15::timestamptz - interval '10 minutes'
                               AND $15::timestamptz + interval '10 minutes'
      ORDER BY abs(extract(epoch FROM (lg.occurred_at - $15::timestamptz))) ASC
      LIMIT 1
    )`,
    mergeParams);
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
      itemId, locationId, state, delta, qtyAfter, occurredAt, sourceType,
      sourceRef, reasonCode, event.id, changeId, appName, actorName,
      referenceDocumentUri, ledgerDocumentUri,
    ]);
  return { inserted: inserted.rowCount > 0 };
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
  const detail = enriched.byMatch.get(enrichKey)?.shift() || null;
  if (detail) detail.consumed = true;
  return mergeLedgerChange({
    event,
    changeId: externalChangeId(row),
    itemId,
    locationId,
    state,
    delta,
    occurredAt: row.second,
    qtyAfter: detail?.quantityAfterChange ?? null,
    sourceType: event.sourceType,
    sourceRef: row.reference_document_uri || null,
    reasonCode: row.inventory_change_reason || null,
    appName: row.inventory_app_name || null,
    actorName: row.staff_member_name || row.inventory_app_name || null,
    referenceDocumentUri: row.reference_document_uri || null,
    ledgerDocumentUri: detail?.ledgerDocumentUri || null,
  });
}

async function ingestEnrichedRemainders(rows, enriched, lookup) {
  const rowByGroup = new Map(rows.map((row) => [
    normalizeGid('InventoryAdjustmentGroup', row.inventory_adjustment_group_id),
    row,
  ]));
  let inserted = 0, matched = 0, skipped = 0;
  for (const change of enriched.all) {
    if (change.consumed) continue;
    const row = rowByGroup.get(change.groupId);
    const itemId = lookup.items.get(change.item?.id);
    const locationId = lookup.locations.get(change.location?.id);
    if (!row || !itemId || !locationId) {
      skipped++;
      continue;
    }
    let event = lookup.events.get(change.groupId);
    if (!event) {
      event = await upsertEvent(row);
      lookup.events.set(change.groupId, event);
    }
    const state = String(change.name || '').toLowerCase();
    const delta = Number(change.delta || 0);
    const changeId = [
      'shopify-group', change.groupId, change.item.id,
      change.location.id, state, delta,
    ].join(':');
    const result = await mergeLedgerChange({
      event,
      changeId,
      itemId,
      locationId,
      state,
      delta,
      occurredAt: row.second,
      qtyAfter: change.quantityAfterChange ?? null,
      sourceType: classifyHistorySource(row),
      sourceRef: row.reference_document_uri || null,
      reasonCode: row.inventory_change_reason || null,
      appName: row.inventory_app_name || null,
      actorName: row.staff_member_name || row.inventory_app_name || null,
      referenceDocumentUri: row.reference_document_uri || null,
      ledgerDocumentUri: change.ledgerDocumentUri || null,
    });
    if (result.inserted) inserted++;
    else if (result.matched) matched++;
    else skipped++;
  }
  return { inserted, matched, skipped };
}

// ShopifyQL reporting can arrive after the realtime webhook placeholder has
// already been saved. If a later canonical event contains every quantity
// change from that placeholder at the same item/location within 30 seconds,
// the two rows describe the same Shopify operation. Remove only the provisional
// duplicate; the enriched ShopifyQL event remains the audit source.
export async function mergeNearbyProvisionalEvents() {
  const pendingEvents = await q(`
    SELECT DISTINCT e.id
    FROM inventory_events e
    JOIN inventory_ledger lg ON lg.event_id=e.id
    WHERE e.source_type='unknown'
      AND e.shopify_group_gid LIKE 'webhook:%'
      AND lg.external_change_id IS NULL
    ORDER BY e.id`);
  if (!pendingEvents.rowCount) return 0;
  const winners = new Map();
  for (const event of pendingEvents.rows) {
    const provisional = await q(`
      SELECT item_id, location_id, state, delta, occurred_at
      FROM inventory_ledger WHERE event_id=$1`,
    [event.id]);
    const seed = provisional.rows[0];
    if (!seed) continue;
    const candidates = await q(`
      SELECT DISTINCT event_id
      FROM inventory_ledger
      WHERE event_id <> $1
        AND attribution='shopifyql'
        AND item_id=$2 AND location_id=$3 AND state=$4 AND delta=$5
        AND occurred_at BETWEEN $6::timestamptz - interval '30 seconds'
                            AND $6::timestamptz + interval '30 seconds'
      LIMIT 20`,
    [
      event.id, seed.item_id, seed.location_id, seed.state, seed.delta,
      seed.occurred_at,
    ]);
    if (!candidates.rowCount) continue;
    const ids = candidates.rows.map((row) => row.event_id);
    const canonical = await q(`
      SELECT event_id, item_id, location_id, state, delta, occurred_at
      FROM inventory_ledger
      WHERE event_id=ANY($1::bigint[]) AND attribution='shopifyql'`,
    [ids]);
    for (const candidateId of ids) {
      const rows = canonical.rows.filter((row) =>
        String(row.event_id) === String(candidateId));
      const fullyCovered = provisional.rows.every((p) => rows.some((c) =>
        c.item_id === p.item_id
        && c.location_id === p.location_id
        && c.state === p.state
        && c.delta === p.delta
        && Math.abs(+new Date(c.occurred_at) - +new Date(p.occurred_at)) <= 30000));
      if (fullyCovered) {
        winners.set(event.id, candidateId);
        break;
      }
    }
  }
  if (!winners.size) return 0;

  const client = await pool.connect();
  let merged = 0;
  try {
    await client.query('BEGIN');
    for (const provisionalEventId of winners.keys()) {
      const removed = await client.query(
        `DELETE FROM inventory_ledger
         WHERE event_id=$1`,
        [provisionalEventId],
      );
      if (!removed.rowCount) continue;
      const event = await client.query(
        `DELETE FROM inventory_events
         WHERE id=$1
           AND NOT EXISTS (
             SELECT 1 FROM inventory_ledger WHERE event_id=$1
           )`,
        [provisionalEventId],
      );
      if (event.rowCount) merged++;
    }
    await client.query('COMMIT');
    return merged;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runHistorySync(ctx, {
  since = null, until = null, days = 2, incremental = true,
} = {}) {
  const stateKey = incremental ? 'inventory_history_sync' : 'inventory_history_backfill';
  const state = await getState(stateKey);
  const end = until ? new Date(until) : new Date();
  const defaultStart = new Date(+end - days * 86400000);
  const requestedStart = since ? new Date(since) : defaultStart;
  if (!Number.isFinite(+requestedStart) || !Number.isFinite(+end) || requestedStart >= end) {
    throw new Error('invalid inventory history date range');
  }

  const mode = incremental ? 'incremental' : 'backfill';
  const direction = incremental ? 'forward' : 'backward';
  // Incremental runs replay the last two days because ShopifyQL reporting can
  // trail the realtime webhook by hours. External change IDs keep this
  // replay idempotent.
  // Backfills run newest-first so the product screen becomes useful immediately,
  // then continue towards day 180.
  const incrementalStart = incremental
    ? incrementalHistoryStart({ since, state, requestedStart })
    : requestedStart;
  const resumeBackfill = !incremental && state?.mode === 'backfill'
    && state?.direction === 'backward' && state?.cursor
    && +new Date(state.cursor) > +requestedStart;
  const backfillEnd = resumeBackfill
    ? new Date(Math.min(+end, +new Date(state.cursor) + 120000))
    : end;
  const syncStart = requestedStart.toISOString();
  let fetched = resumeBackfill ? Number(state.fetched || 0) : 0;
  let inserted = resumeBackfill ? Number(state.inserted || 0) : 0;
  let matched = resumeBackfill ? Number(state.matched || 0) : 0;
  let skipped = resumeBackfill ? Number(state.skipped || 0) : 0;
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
    const extra = await ingestEnrichedRemainders(rows, enriched, lookup);
    inserted += extra.inserted;
    matched += extra.matched;
    skipped += extra.skipped;
    await setState(stateKey, {
      cursor: new Date(cursor).toISOString(),
      fetched, inserted, matched, skipped,
      running, mode, direction, start: syncStart,
      heartbeat: new Date().toISOString(),
    });
    console.log(
      `[history] ${mode} ${new Date(windowStart).toISOString()}..${new Date(windowEnd).toISOString()}: `
      + `${rows.length} rows; cursor ${new Date(cursor).toISOString()}`,
    );
  };

  if (incremental) {
    const windowMs = historyWindowDays(true) * 86400000;
    for (let windowStart = +incrementalStart; windowStart < +end; windowStart += windowMs) {
      const windowEnd = Math.min(windowStart + windowMs, +end);
      await consumeWindow(windowStart, windowEnd, windowEnd < +end, windowEnd);
    }
  } else {
    const windowMs = historyWindowDays(false) * 86400000;
    for (let windowEnd = +backfillEnd; windowEnd > +requestedStart;) {
      const windowStart = Math.max(+requestedStart, windowEnd - windowMs);
      await consumeWindow(windowStart, windowEnd, windowStart > +requestedStart, windowStart);
      windowEnd = windowStart;
    }
  }
  const provisionalMerged = await mergeNearbyProvisionalEvents();
  // Once provisional webhook ledger rows have been attached to the enriched
  // ShopifyQL event, remove the now-empty placeholder. This keeps the visible
  // history at one business event per operation without losing immediacy.
  await q(`DELETE FROM inventory_events e
           WHERE e.source_type='unknown'
             AND e.shopify_group_gid LIKE 'webhook:%'
             AND NOT EXISTS (
               SELECT 1 FROM inventory_ledger lg WHERE lg.event_id=e.id
             )`);
  const summary = {
    cursor: incremental ? end.toISOString() : requestedStart.toISOString(),
    fetched, inserted, matched, skipped,
    provisionalMerged,
    finishedAt: new Date().toISOString(), running: false,
    mode, direction, start: syncStart,
  };
  await setState(stateKey, summary);
  return summary;
}
