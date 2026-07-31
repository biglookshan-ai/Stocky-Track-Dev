// Ledger writes. The ledger is append-only; current_levels holds the last
// known quantity per item+location and is the reference for delta calculation.
//
// Write paths:
//  · webhook inventory_levels/update → recordLevelUpdate() (delta vs current)
//  · our own adjustments (M2) write ledger rows directly at apply time and
//    confirm the returned Available value in current_levels. The webhook echo
//    then computes delta 0; all other inventory states come from Shopify's
//    queried webhook payload rather than local arithmetic.
import { pool, q } from './db.js';
import { INVENTORY_STATES } from './catalog.js';

function assertState(state) {
  if (!INVENTORY_STATES.includes(state)) throw new Error(`unsupported inventory state: ${state}`);
}

// Record every changed Shopify inventory state under one provisional business
// event. ShopifyQL later enriches these same ledger rows with actor, reason and
// Order/Transfer references. Until then the event is intentionally visible as
// "pending attribution" instead of disappearing from the UI.
export async function recordQuantityUpdate({
  itemId, locationId, quantities, occurredAt, webhookId, topic = 'inventory_levels/update',
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT available, on_hand, committed, incoming, reserved, damaged,
              safety_stock, quality_control
       FROM current_levels
       WHERE item_id=$1 AND location_id=$2
       FOR UPDATE`,
      [itemId, locationId],
    );
    const existing = current.rows[0] || {};
    const next = Object.fromEntries(INVENTORY_STATES.map((state) => [
      state,
      quantities[state] === null || quantities[state] === undefined
        ? existing[state] ?? null
        : Number(quantities[state]),
    ]));
    const changes = current.rowCount
      ? INVENTORY_STATES.flatMap((state) => {
        if (existing[state] === null || existing[state] === undefined
          || next[state] === null || next[state] === undefined) return [];
        const delta = Number(next[state]) - Number(existing[state]);
        return delta === 0 ? [] : [{ state, delta, qtyAfter: Number(next[state]) }];
      })
      : [];

    let eventId = null;
    const ledgerIds = [];
    if (changes.length) {
      const event = await client.query(
        `INSERT INTO inventory_events
           (shopify_group_gid, occurred_at, activity, reason, source_type, raw)
         VALUES ($1,$2,'inventory_updated','pending_attribution','unknown',$3::jsonb)
         ON CONFLICT (shopify_group_gid) DO UPDATE SET
           occurred_at=LEAST(inventory_events.occurred_at, EXCLUDED.occurred_at)
         RETURNING id`,
        [
          webhookId ? `webhook:${webhookId}` : null,
          occurredAt,
          JSON.stringify({ webhookId: webhookId || null, topic }),
        ],
      );
      eventId = event.rows[0].id;
      for (const change of changes) {
        const row = await client.query(
          `INSERT INTO inventory_ledger
             (item_id, location_id, state, delta, qty_after, occurred_at,
              source_type, source_ref, attribution, event_id)
           VALUES ($1,$2,$3,$4,$5,$6,'unknown',$7,'pending',$8)
           RETURNING id`,
          [
            itemId, locationId, change.state, change.delta, change.qtyAfter,
            occurredAt, webhookId || null, eventId,
          ],
        );
        ledgerIds.push(row.rows[0].id);
      }
    }

    await client.query(
      `INSERT INTO current_levels
         (item_id, location_id, available, on_hand, committed, incoming,
          reserved, damaged, safety_stock, quality_control, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (item_id, location_id) DO UPDATE SET
         available=$3, on_hand=$4, committed=$5, incoming=$6,
         reserved=$7, damaged=$8, safety_stock=$9, quality_control=$10,
         updated_at=now()`,
      [itemId, locationId, ...INVENTORY_STATES.map((state) => next[state])],
    );
    await client.query('COMMIT');
    return { eventId, ledgerIds, changes };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Backwards-compatible single-state entry point used by older callers/tests.
export async function recordLevelUpdate({ itemId, locationId, available, occurredAt, webhookId }) {
  const result = await recordQuantityUpdate({
    itemId,
    locationId,
    quantities: { available },
    occurredAt,
    webhookId,
  });
  return result.ledgerIds[0] || null;
}

export async function upsertCurrentLevel(itemId, locationId, qty) {
  await q(`INSERT INTO current_levels
             (item_id, location_id, available, on_hand, committed, incoming, reserved, damaged, safety_stock, quality_control, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (item_id, location_id) DO UPDATE SET
             available=$3, on_hand=$4, committed=$5, incoming=$6,
             reserved=$7, damaged=$8, safety_stock=$9, quality_control=$10,
             updated_at=now()`,
    [itemId, locationId, ...INVENTORY_STATES.map((state) => qty[state] ?? null)]);
}

// Ledger rows written by our own operations (adjustments, stocktakes, imports).
export async function recordDirect({ itemId, locationId, state = 'available', delta, qtyAfter, occurredAt, sourceType, sourceRef, reasonCode, staffId, notes, attribution = 'matched' }) {
  assertState(state);
  const r = await q(
    `INSERT INTO inventory_ledger (item_id, location_id, state, delta, qty_after, occurred_at,
                                   source_type, source_ref, reason_code, staff_id, notes, attribution, attributed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) RETURNING id`,
    [itemId, locationId, state, delta, qtyAfter, occurredAt, sourceType, sourceRef || null,
     reasonCode || null, staffId || null, notes || null, attribution]
  );
  return r.rows[0].id;
}
