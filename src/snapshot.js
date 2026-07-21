// Daily snapshot + reconciliation. One full catalog pull per day does double
// duty: (a) writes daily_snapshots (incremental — only changed rows, plus a
// full baseline on the 1st of each month), (b) compares Shopify's actual
// levels against current_levels and heals any drift with a reconciliation
// ledger row + alert. This is the self-testing property of the system.
import { q, setState } from './db.js';
import { walkVariants, syncLocations } from './catalog.js';
import { recordReconciliation } from './ledger.js';

export async function runSnapshot(ctx) {
  const snapDate = new Date().toISOString().slice(0, 10);
  const fullBaseline = new Date().getUTCDate() === 1;

  // Previous snapshot value per item+location (latest row before today).
  const prev = await q(`
    SELECT DISTINCT ON (item_id, location_id) item_id, location_id, available, on_hand
    FROM daily_snapshots WHERE snap_date < $1
    ORDER BY item_id, location_id, snap_date DESC`, [snapDate]);
  const prevMap = new Map(prev.rows.map((r) => [`${r.item_id}:${r.location_id}`, r]));

  const tracked = await q('SELECT item_id, location_id, available FROM current_levels');
  const trackedMap = new Map(tracked.rows.map((r) => [`${r.item_id}:${r.location_id}`, r.available]));

  let rows = 0, drift = 0, seen = 0;
  await syncLocations(ctx);
  await walkVariants(ctx, async (itemId, locId, qty) => {
    seen++;
    const key = `${itemId}:${locId}`;
    const actual = qty.available ?? null;

    // (b) reconcile against what webhooks led us to believe
    const expected = trackedMap.has(key) ? trackedMap.get(key) : null;
    if (actual !== null && expected !== null && actual !== expected) {
      await recordReconciliation({ itemId, locationId: locId, expected, actual, snapDate });
      drift++;
    } else if (actual !== null && expected === null) {
      await q(`INSERT INTO current_levels (item_id, location_id, available, on_hand, updated_at)
               VALUES ($1,$2,$3,$4, now())
               ON CONFLICT (item_id, location_id) DO UPDATE SET available=$3, on_hand=$4, updated_at=now()`,
        [itemId, locId, actual, qty.on_hand ?? null]);
    }

    // (a) incremental snapshot
    const p = prevMap.get(key);
    const changed = !p || p.available !== (qty.available ?? null) || p.on_hand !== (qty.on_hand ?? null);
    if (changed || fullBaseline) {
      await q(`INSERT INTO daily_snapshots (snap_date, item_id, location_id, available, on_hand, unit_cost)
               SELECT $1,$2,$3,$4,$5, i.unit_cost FROM items i WHERE i.id = $2
               ON CONFLICT (snap_date, item_id, location_id) DO UPDATE SET available=$4, on_hand=$5`,
        [snapDate, itemId, locId, qty.available ?? null, qty.on_hand ?? null]);
      rows++;
    }
  }, { progressKey: 'snapshot_progress' });

  const summary = { snapDate, variantsSeen: seen, snapshotRows: rows, driftHealed: drift, fullBaseline, finishedAt: new Date().toISOString() };
  await setState('last_snapshot', summary);
  console.log('[snapshot]', JSON.stringify(summary));
  return summary;
}
