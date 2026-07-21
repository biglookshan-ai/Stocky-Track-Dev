// Attribution pass: label pending ledger rows with what caused them.
// M0/M1 sources, in matching order:
//   1. orders/create   → negative deltas that match an order line (sale)
//   2. refunds/create  → positive deltas that match a restocked refund line
//   3. fallback        → rows older than 48h become external_app
// A nightly ShopifyQL reconciliation (inventory_adjustment_history) will later
// upgrade external_app rows with staff/reason where available (M1).
import { q } from './db.js';

// Pure matcher, exported for unit tests.
// ledgerRow: { id, item_variant_num, delta, occurred_at(Date) }
// orderEvents: [{ name, created_at(Date), lines: [{variant_id, quantity}] }]
export function matchSale(ledgerRow, orderEvents, windowMs = 20 * 60 * 1000) {
  if (ledgerRow.delta >= 0) return null;
  for (const o of orderEvents) {
    const dt = ledgerRow.occurred_at - o.created_at;
    if (dt < -60 * 1000 || dt > windowMs) continue; // level change follows the order
    for (const l of o.lines) {
      if (String(l.variant_id) === String(ledgerRow.item_variant_num) &&
          l.quantity >= Math.abs(ledgerRow.delta) - 0.0001) {
        return { ref: o.name, kind: 'sale' };
      }
    }
  }
  return null;
}

export function matchRefund(ledgerRow, refundEvents, windowMs = 20 * 60 * 1000) {
  if (ledgerRow.delta <= 0) return null;
  for (const r of refundEvents) {
    const dt = ledgerRow.occurred_at - r.created_at;
    if (dt < -60 * 1000 || dt > windowMs) continue;
    for (const l of r.lines) {
      if (String(l.variant_id) === String(ledgerRow.item_variant_num) && l.restock) {
        return { ref: r.order_name || `refund ${r.id}`, kind: 'refund' };
      }
    }
  }
  return null;
}

export async function runAttribution() {
  const pending = await q(`
    SELECT l.id, l.delta, l.occurred_at,
           split_part(i.shopify_variant_gid, '/', 5) AS variant_num
    FROM inventory_ledger l JOIN items i ON i.id = l.item_id
    WHERE l.attribution = 'pending' AND l.recorded_at < now() - interval '30 seconds'
    ORDER BY l.occurred_at ASC LIMIT 500`);
  if (!pending.rowCount) return { attributed: 0, pending: 0 };

  const since = new Date(Math.min(...pending.rows.map((r) => +new Date(r.occurred_at))) - 30 * 60 * 1000);
  const events = await q(`
    SELECT topic, payload FROM webhook_events
    WHERE topic IN ('orders/create','refunds/create') AND received_at >= $1`, [since]);

  const orders = [], refunds = [];
  for (const e of events.rows) {
    const p = e.payload;
    if (e.topic === 'orders/create') {
      orders.push({
        name: p.name || `#${p.order_number || p.id}`,
        created_at: new Date(p.created_at || p.processed_at || 0),
        lines: (p.line_items || []).map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
      });
    } else {
      refunds.push({
        id: p.id,
        order_name: p.order_id ? `order ${p.order_id}` : null,
        created_at: new Date(p.created_at || 0),
        lines: (p.refund_line_items || []).map((l) => ({
          variant_id: l.line_item?.variant_id, quantity: l.quantity,
          restock: l.restock_type && l.restock_type !== 'no_restock',
        })),
      });
    }
  }

  let attributed = 0;
  for (const row of pending.rows) {
    const lr = { id: row.id, delta: row.delta, occurred_at: new Date(row.occurred_at), item_variant_num: row.variant_num };
    const sale = matchSale(lr, orders);
    const refund = sale ? null : matchRefund(lr, refunds);
    const hit = sale || refund;
    if (hit) {
      await q(`UPDATE inventory_ledger SET source_type=$2, source_ref=$3, attribution='matched', attributed_at=now() WHERE id=$1`,
        [row.id, hit.kind, hit.ref]);
      attributed++;
    }
  }

  // Stale fallback: after 48h with no match, label as external (Stocky, other
  // apps, admin manual edits). The nightly ShopifyQL pass can refine these.
  const stale = await q(`
    UPDATE inventory_ledger SET source_type='external_app', attribution='n/a', attributed_at=now()
    WHERE attribution='pending' AND recorded_at < now() - interval '48 hours'`);

  const left = await q(`SELECT count(*)::int n FROM inventory_ledger WHERE attribution='pending'`);
  return { attributed, staleLabeled: stale.rowCount, pending: left.rows[0].n };
}
