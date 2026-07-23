// Ledger writes. The ledger is append-only; current_levels holds the last
// known quantity per item+location and is the reference for delta calculation.
//
// Write paths:
//  · webhook inventory_levels/update → recordLevelUpdate() (delta vs current)
//  · our own adjustments (M2) write ledger rows directly at apply time and
//    update current_levels FIRST — so the webhook echo computes delta 0 and
//    records nothing. If the echo races us, the daily snapshot reconciliation
//    heals the double-count.
//  · snapshot reconciliation → recordReconciliation()
import { q } from './db.js';
import { INVENTORY_STATES } from './catalog.js';

function assertState(state) {
  if (!INVENTORY_STATES.includes(state)) throw new Error(`unsupported inventory state: ${state}`);
}

// Returns the ledger row id, or null when the update is a no-op / baseline.
export async function recordLevelUpdate({ itemId, locationId, available, occurredAt, webhookId }) {
  const cur = await q('SELECT available FROM current_levels WHERE item_id=$1 AND location_id=$2', [itemId, locationId]);
  if (!cur.rowCount || cur.rows[0].available === null) {
    // First sighting of this item+location: baseline only, no ledger row
    // (we can't know the delta without a starting point).
    await q(`INSERT INTO current_levels (item_id, location_id, available, updated_at)
             VALUES ($1,$2,$3, now())
             ON CONFLICT (item_id, location_id) DO UPDATE SET available=$3, updated_at=now()`,
      [itemId, locationId, available]);
    return null;
  }
  const delta = available - cur.rows[0].available;
  if (delta === 0) return null;
  const r = await q(
    `INSERT INTO inventory_ledger (item_id, location_id, state, delta, qty_after, occurred_at, source_type, source_ref)
     VALUES ($1,$2,'available',$3,$4,$5,'unknown',$6) RETURNING id`,
    [itemId, locationId, delta, available, occurredAt, webhookId || null]
  );
  await q(`UPDATE current_levels SET available=$3, updated_at=now() WHERE item_id=$1 AND location_id=$2`,
    [itemId, locationId, available]);
  return r.rows[0].id;
}

// Snapshot found Shopify's actual value differs from our tracked value:
// append a correcting row so the ledger always sums to reality.
export async function recordReconciliation({ itemId, locationId, state, expected, actual, snapDate }) {
  assertState(state);
  await q(
    `INSERT INTO inventory_ledger (item_id, location_id, state, delta, qty_after, occurred_at, source_type, source_ref, attribution)
     VALUES ($1,$2,$3,$4,$5, now(), 'reconciliation', $6, 'n/a')`,
    [itemId, locationId, state, actual - expected, actual, `snapshot ${snapDate}`]
  );
  await q(`INSERT INTO reconcile_alerts (snap_date, item_id, location_id, state, expected, actual)
           VALUES ($1,$2,$3,$4,$5,$6)`,
    [snapDate, itemId, locationId, state, expected, actual]);
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
