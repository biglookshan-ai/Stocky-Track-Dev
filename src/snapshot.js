// Daily snapshot + reconciliation. One full catalog pull per day does double
// duty: (a) writes daily_snapshots (incremental — only changed rows, plus a
// full baseline on the 1st of each month), (b) compares Shopify's actual
// levels against current_levels and heals any drift with a reconciliation
// ledger row + alert. This is the self-testing property of the system.
import { q, setState } from './db.js';
import { INVENTORY_STATES, walkVariants, syncLocations } from './catalog.js';
import { recordReconciliation, upsertCurrentLevel } from './ledger.js';

export async function runSnapshot(ctx) {
  const snapDate = new Date().toISOString().slice(0, 10);
  const fullBaseline = new Date().getUTCDate() === 1;

  // Previous snapshot value per item+location (latest row before today).
  const prev = await q(`
    SELECT DISTINCT ON (item_id, location_id)
           item_id, location_id, available, on_hand, committed, incoming,
           reserved, damaged, safety_stock, quality_control
    FROM daily_snapshots WHERE snap_date < $1
    ORDER BY item_id, location_id, snap_date DESC`, [snapDate]);
  const prevMap = new Map(prev.rows.map((r) => [`${r.item_id}:${r.location_id}`, r]));

  const tracked = await q(`
    SELECT item_id, location_id, available, on_hand, committed, incoming,
           reserved, damaged, safety_stock, quality_control
    FROM current_levels`);
  const trackedMap = new Map(tracked.rows.map((r) => [`${r.item_id}:${r.location_id}`, r]));

  let rows = 0, drift = 0, seen = 0;
  await syncLocations(ctx);
  await walkVariants(ctx, async (itemId, locId, qty) => {
    seen++;
    const key = `${itemId}:${locId}`;
    // (b) reconcile against what webhooks led us to believe
    const expected = trackedMap.get(key);
    for (const state of INVENTORY_STATES) {
      const actualValue = qty[state] ?? null;
      const expectedValue = expected?.[state] ?? null;
      if (actualValue !== null && expectedValue !== null && actualValue !== expectedValue) {
        await recordReconciliation({
          itemId, locationId: locId, state,
          expected: expectedValue, actual: actualValue, snapDate,
        });
        drift++;
      } else if (actualValue !== null && actualValue === expectedValue) {
        await q(`UPDATE reconcile_alerts SET resolved=true
                 WHERE item_id=$1 AND location_id=$2 AND state=$3 AND NOT resolved`,
          [itemId, locId, state]);
      }
    }
    await upsertCurrentLevel(itemId, locId, qty);

    // (a) incremental snapshot
    const p = prevMap.get(key);
    const changed = !p || INVENTORY_STATES.some((state) => p[state] !== (qty[state] ?? null));
    if (changed || fullBaseline) {
      await q(`INSERT INTO daily_snapshots
                 (snap_date, item_id, location_id, available, on_hand, committed, incoming,
                  reserved, damaged, safety_stock, quality_control, unit_cost)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,i.unit_cost
               FROM items i WHERE i.id=$2
               ON CONFLICT (snap_date, item_id, location_id) DO UPDATE SET
                 available=$4, on_hand=$5, committed=$6, incoming=$7,
                 reserved=$8, damaged=$9, safety_stock=$10, quality_control=$11`,
        [snapDate, itemId, locId, ...INVENTORY_STATES.map((state) => qty[state] ?? null)]);
      rows++;
    }
  }, { progressKey: 'snapshot_progress' });

  const summary = { snapDate, variantsSeen: seen, snapshotRows: rows, driftHealed: drift, fullBaseline, finishedAt: new Date().toISOString() };
  await setState('last_snapshot', summary);
  console.log('[snapshot]', JSON.stringify(summary));
  return summary;
}
