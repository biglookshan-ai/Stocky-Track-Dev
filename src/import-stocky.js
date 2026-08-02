// Stocky adjustments-report CSV import.
//
// Fusion rules (agreed 2026-07-31):
//   · Only groups dated BEFORE the formal-coverage start (earliest ShopifyQL
//     event) are imported — later operations already exist as richer formal
//     records; importing them would duplicate history.
//   · Imported events carry source_type='import' (badge "Historical import"),
//     app 'Stocky', the original adjustment number as reference, the original
//     reason/notes/employee. Nothing is invented: qty_after stays NULL
//     (rendered as 未提供) and import rows are excluded from trend rebuilding,
//     because the CSV contains adjustments only — reconstructing historical
//     stock levels without the sales of that era would fabricate numbers.
//   · Idempotent: event gid 'stocky:adjustment:<no>', ledger external id
//     'stocky:<no>:<csv line>'. Re-running the same file changes nothing.
//   · Rows with Status other than 'adjusted' never touch the ledger (they were
//     not executed in Stocky).
//   · Unknown barcodes become local items (source='local') — Stocky-only "#"
//     components; unknown locations are created inactive.
import { q, pool } from './db.js';

// ---- pure: merge duplicate (barcode, location) rows for adjustment_lines
// (the table has a unique constraint per adjustment+item+location; the ledger
// keeps the original per-row granularity) ----
export function mergeAdjustmentLines(lines) {
  const merged = new Map();
  for (const l of lines) {
    const key = `${l.barcode}|${l.location.toLowerCase()}`;
    const cur = merged.get(key);
    if (cur) cur.delta += l.delta;
    else merged.set(key, { ...l });
  }
  return [...merged.values()].filter((l) => l.delta !== 0);
}

// ---- pure: pick the single formal event that covers every CSV line ----
// candidateSets: per CSV line, the Set of formal event ids whose ledger rows
// match that line (same item/location/delta, date window, app Stocky).
// Returns the event id only when the intersection is unambiguous.
export function pickCoveringEvent(candidateSets) {
  if (!candidateSets.length) return { eventId: null, ambiguous: false };
  let intersection = null;
  for (const set of candidateSets) {
    if (!set || !set.size) return { eventId: null, ambiguous: false };
    intersection = intersection === null
      ? new Set(set)
      : new Set([...intersection].filter((id) => set.has(id)));
    if (!intersection.size) return { eventId: null, ambiguous: false };
  }
  if (intersection.size === 1) return { eventId: [...intersection][0], ambiguous: false };
  return { eventId: null, ambiguous: true };
}

// ---- pure: RFC-4180 CSV ----
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells, index) => {
    const o = { _line: index + 2 };
    header.forEach((h, i) => { o[h] = (cells[i] ?? '').trim(); });
    return o;
  });
}

// ---- pure: normalization ----
export function canonicalEmployee(raw) {
  const name = String(raw || '').trim();
  return name || null;
}

export function parseStockyDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T12:00:00Z`;
  return Number.isFinite(+new Date(iso)) ? iso : null;
}

// Group raw CSV rows into importable adjustment events.
// coverageStart: ISO datetime where formal (ShopifyQL) history begins.
export function planImport(rows, { coverageStart = null } = {}) {
  const groups = new Map();
  const issues = {
    notAdjustedRows: 0, coveredGroups: 0, coveredRows: 0,
    missingDateGroups: [], missingBarcodeRows: 0,
  };
  for (const row of rows) {
    const no = String(row['No.'] || '').trim();
    if (!no) continue;
    if (!groups.has(no)) groups.set(no, { number: no, rows: [] });
    groups.get(no).rows.push(row);
  }

  const events = [];
  const coveredEvents = []; // formal history already exists → enrich, not insert
  const employees = new Map(); // lower → {name, count}
  const reasons = new Map();
  for (const group of groups.values()) {
    const adjusted = group.rows.filter((r) => (r.Status || '').toLowerCase() === 'adjusted');
    issues.notAdjustedRows += group.rows.length - adjusted.length;
    if (!adjusted.length) continue;

    const date = group.rows.map((r) => parseStockyDate(r.Date)).find(Boolean);
    if (!date) {
      issues.missingDateGroups.push(group.number);
      continue;
    }
    const covered = coverageStart && +new Date(date) >= +new Date(coverageStart);
    if (covered) {
      issues.coveredGroups++;
      issues.coveredRows += adjusted.length;
    }

    const tally = new Map();
    for (const r of adjusted) {
      const emp = canonicalEmployee(r.Employee);
      if (emp) tally.set(emp.toLowerCase(), (tally.get(emp.toLowerCase()) || 0) + 1);
    }
    const reason = (adjusted.map((r) => (r.Reason || '').trim()).find(Boolean)) || null;
    if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    const notes = adjusted.map((r) => (r.Notes || '').trim()).find(Boolean) || null;

    const lines = [];
    for (const r of adjusted) {
      const barcode = (r.Barcode || '').trim();
      if (!barcode) { issues.missingBarcodeRows++; continue; }
      const emp = canonicalEmployee(r.Employee);
      if (emp) {
        const key = emp.toLowerCase();
        const cur = employees.get(key);
        if (!cur || cur.count < (tally.get(key) || 1)) {
          employees.set(key, { name: emp, count: (cur?.count || 0) + 1 });
        } else cur.count++;
      }
      lines.push({
        csvLine: r._line,
        barcode,
        sku: (r.SKU || '').trim(),
        product: (r.Product || '').trim(),
        variant: (r.Variant || '').trim(),
        location: (r.Location || '').trim(),
        delta: Number(r.Adjustment),
        employee: emp,
        notes: (r.Notes || '').trim() || null,
      });
    }
    if (!lines.length) continue;
    const staffKey = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    (covered ? coveredEvents : events).push({
      number: group.number,
      occurredAt: date,
      reason,
      notes,
      staffName: staffKey ? (employees.get(staffKey)?.name || staffKey) : null,
      lines,
    });
  }
  events.sort((a, b) => +new Date(a.occurredAt) - +new Date(b.occurredAt) || Number(a.number) - Number(b.number));
  return {
    events,
    coveredEvents,
    issues,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    employees: [...employees.values()].map((e) => e.name).sort(),
    dateRange: events.length
      ? { first: events[0].occurredAt, last: events[events.length - 1].occurredAt }
      : null,
  };
}

// ---- DB side ----
export async function formalCoverageStart() {
  const r = await q(`
    SELECT min(occurred_at) AS at FROM inventory_events
    WHERE source_type <> 'import'
      AND NOT (source_type='unknown' AND shopify_group_gid LIKE 'webhook:%')`);
  return r.rows[0]?.at || null;
}

async function loadLookups(plan) {
  const barcodes = [...new Set(plan.events.flatMap((e) => e.lines.map((l) => l.barcode)))];
  const items = await q(`
    SELECT id, barcode, source, status FROM items WHERE barcode = ANY($1::text[])
    ORDER BY (source='shopify') DESC, (status='active') DESC, id ASC`, [barcodes]);
  const itemByBarcode = new Map();
  const dupBarcodes = new Set();
  for (const row of items.rows) {
    if (itemByBarcode.has(row.barcode)) dupBarcodes.add(row.barcode);
    else itemByBarcode.set(row.barcode, row.id);
  }
  const locations = await q('SELECT id, name FROM locations');
  const locByName = new Map(locations.rows.map((l) => [l.name.toLowerCase(), l.id]));
  const staff = await q('SELECT id, display_name FROM staff');
  const staffByName = new Map(staff.rows.map((s) => [s.display_name.toLowerCase(), s.id]));
  const reasons = await q('SELECT id, name FROM adjustment_reasons');
  const reasonByName = new Map(reasons.rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  return { itemByBarcode, dupBarcodes: [...dupBarcodes], locByName, staffByName, reasonByName, barcodes };
}

// Match a covered-era CSV group to the formal event that already records it,
// then (in commit mode) enrich that event with the CSV's employee/notes and
// create the STK adjustment record linked to it. exec = q (dry-run) or a
// transaction client's query fn (commit).
async function mapCoveredEvent(e, lookups, exec, claimedGids, { commit }) {
  const resolved = [];
  for (const l of e.lines) {
    const itemId = lookups.itemByBarcode.get(l.barcode);
    const locationId = lookups.locByName.get(l.location.toLowerCase());
    if (!itemId || !locationId) return { status: 'unmatched' };
    resolved.push({ ...l, itemId, locationId });
  }
  const candidateSets = [];
  const rowsByLine = [];
  for (const l of resolved) {
    const rows = await exec(`
      SELECT lg.id AS ledger_id, lg.event_id, e.shopify_group_gid,
             lg.notes, lg.reason_code, lg.actor_name, lg.staff_id
      FROM inventory_ledger lg
      JOIN inventory_events e ON e.id=lg.event_id
      WHERE lg.item_id=$1 AND lg.location_id=$2 AND lg.state='available' AND lg.delta=$3
        AND lg.occurred_at BETWEEN $4::timestamptz - interval '36 hours'
                               AND $4::timestamptz + interval '36 hours'
        AND e.source_type <> 'import'
        AND NOT (e.source_type='unknown' AND e.shopify_group_gid LIKE 'webhook:%')
        AND e.app_name ILIKE '%stocky%'`,
    [l.itemId, l.locationId, l.delta, e.occurredAt]);
    candidateSets.push(new Set(rows.rows.map((r) => String(r.event_id))));
    rowsByLine.push(rows.rows);
  }
  const pick = pickCoveringEvent(candidateSets);
  if (!pick.eventId) return { status: pick.ambiguous ? 'ambiguous' : 'unmatched' };
  const eventGid = rowsByLine.flat().find((r) => String(r.event_id) === pick.eventId)?.shopify_group_gid;
  if (claimedGids.has(pick.eventId)) return { status: 'ambiguous' };
  claimedGids.add(pick.eventId);
  if (!commit) return { status: 'matched', eventGid };

  // Enrich only the columns that were empty, and remember precisely which ones
  // per row so an undo can revert them to NULL without ever touching data
  // Shopify (or a later manual edit) already provided.
  await exec(
    `UPDATE inventory_events SET staff_name = COALESCE(staff_name, $2)
     WHERE id=$1`, [pick.eventId, e.staffName]);
  for (let i = 0; i < resolved.length; i++) {
    const l = resolved[i];
    const ledgerRow = rowsByLine[i].find((r) => String(r.event_id) === pick.eventId);
    if (!ledgerRow) continue;
    const staffId = l.employee ? lookups.staffByName.get(l.employee.toLowerCase()) || null : null;
    const filled = [];
    if (ledgerRow.notes == null && l.notes != null) filled.push('notes');
    if (ledgerRow.reason_code == null && e.reason != null) filled.push('reason_code');
    if (ledgerRow.actor_name == null && (l.employee || e.staffName) != null) filled.push('actor_name');
    if (ledgerRow.staff_id == null && staffId != null) filled.push('staff_id');
    if (!filled.length) continue;
    await exec(
      `UPDATE inventory_ledger SET
         notes = COALESCE(notes, $2),
         reason_code = COALESCE(reason_code, $3),
         actor_name = COALESCE(actor_name, $4),
         staff_id = COALESCE(staff_id, $5)
       WHERE id=$1`,
      [ledgerRow.ledger_id, l.notes, e.reason, l.employee || e.staffName, staffId]);
    await exec(
      `INSERT INTO stocky_import_backfill (ledger_id, event_id, filled)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (ledger_id) DO UPDATE
       SET filled = (SELECT jsonb_agg(DISTINCT v)
                     FROM jsonb_array_elements(stocky_import_backfill.filled || EXCLUDED.filled) v)`,
      [ledgerRow.ledger_id, pick.eventId, JSON.stringify(filled)]);
  }
  return { status: 'matched', eventGid };
}

export async function runStockyImport(csvText, { commit = false } = {}) {
  const rows = csvObjects(csvText);
  const expected = ['No.', 'Location', 'Product', 'Variant', 'SKU', 'Barcode', 'Reason', 'Notes', 'Employee', 'Status', 'Date', 'Adjustment'];
  const missing = expected.filter((c) => rows.length && !(c in rows[0]));
  if (!rows.length) throw new Error('CSV 为空或无法解析');
  if (missing.length) throw new Error(`CSV 缺少列：${missing.join('、')}`);

  const coverageStart = await formalCoverageStart();
  const plan = planImport(rows, { coverageStart });
  const lookups = await loadLookups(plan);

  // Both eras need local items/locations for orphan barcodes, otherwise a
  // covered-era adjustment referencing a since-deleted product would be created
  // with no lines (the product would silently vanish from the record).
  const allEvents = [...plan.events, ...plan.coveredEvents];
  const unmatchedBarcodes = new Map(); // barcode → sample line info (→ local item)
  for (const e of allEvents) {
    for (const l of e.lines) {
      if (!lookups.itemByBarcode.has(l.barcode) && !unmatchedBarcodes.has(l.barcode)) {
        unmatchedBarcodes.set(l.barcode, l);
      }
    }
  }
  const newLocations = [...new Set(allEvents.flatMap((e) => e.lines.map((l) => l.location)))]
    .filter((n) => n && !lookups.locByName.has(n.toLowerCase()));
  const newStaff = plan.employees.filter((n) => !lookups.staffByName.has(n.toLowerCase()));
  const newReasons = plan.reasons
    .map(([name]) => name)
    .filter((name) => !lookups.reasonByName.has(name.trim().toLowerCase()));

  const report = {
    totalCsvRows: rows.length,
    eventsToImport: plan.events.length,
    linesToImport: plan.events.reduce((n, e) => n + e.lines.length, 0),
    coverageStart,
    skippedAlreadyCovered: { groups: plan.issues.coveredGroups, rows: plan.issues.coveredRows },
    skippedNotAdjustedRows: plan.issues.notAdjustedRows,
    missingDateGroups: plan.issues.missingDateGroups,
    missingBarcodeRows: plan.issues.missingBarcodeRows,
    dateRange: plan.dateRange,
    reasons: plan.reasons,
    employees: plan.employees,
    newStaff,
    newLocations,
    newReasons,
    adjustmentsToCreate: plan.events.length + plan.coveredEvents.length,
    localItemsToCreate: unmatchedBarcodes.size,
    localItemSamples: [...unmatchedBarcodes.values()].slice(0, 10)
      .map((l) => ({ barcode: l.barcode, sku: l.sku, product: l.product || '(无标题)' })),
    duplicateBarcodesInCatalog: lookups.dupBarcodes.slice(0, 20),
  };

  if (!commit) {
    // Read-only pass: how many covered-era groups map onto existing formal
    // records (their reason/employee/notes will be back-filled on commit).
    const claimed = new Set();
    const mapStats = { matched: 0, unmatched: [], ambiguous: [] };
    for (const e of plan.coveredEvents) {
      const r = await mapCoveredEvent(e, lookups, q, claimed, { commit: false });
      if (r.status === 'matched') mapStats.matched++;
      else mapStats[r.status].push(e.number);
    }
    report.coveredMapping = {
      matched: mapStats.matched,
      unmatched: mapStats.unmatched.length,
      unmatchedSamples: mapStats.unmatched.slice(0, 10),
      ambiguous: mapStats.ambiguous.length,
      ambiguousSamples: mapStats.ambiguous.slice(0, 10),
    };
    return { dryRun: true, report };
  }

  const client = await pool.connect();
  let eventsInserted = 0, linesInserted = 0, itemsCreated = 0, adjustmentsCreated = 0;
  try {
    await client.query('BEGIN');
    for (const name of newReasons) {
      // Historical reason labels (e.g. 'Stocky Stocktakes') are preserved but
      // created inactive so they don't appear in the new-adjustment dropdown.
      const r = await client.query(
        // Imported reasons come in ACTIVE, forming the live base the user then
        // curates (rename / change direction / deactivate) in the UI. Direction
        // is inferred from Stocky's prefix convention (- decrease, + increase).
        `INSERT INTO adjustment_reasons (name, direction, active, position)
         VALUES ($1, $2, true, 999)
         ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name
         RETURNING id`,
        [name.trim(), name.trim().startsWith('-') ? 'out' : name.trim().startsWith('+') ? 'in' : 'any']);
      lookups.reasonByName.set(name.trim().toLowerCase(), r.rows[0].id);
    }
    for (const name of newLocations) {
      const r = await client.query(
        `INSERT INTO locations (shopify_gid, name, active) VALUES (NULL, $1, false) RETURNING id`, [name]);
      lookups.locByName.set(name.toLowerCase(), r.rows[0].id);
    }
    for (const name of newStaff) {
      // Imported staff are ACTIVE — the historical team roster becomes the live
      // employee source for new adjustments (selectable as recorded/handled by).
      const r = await client.query(
        `INSERT INTO staff (shopify_user_id, display_name, role, active)
         VALUES (NULL, $1, 'member', true) RETURNING id`, [name]);
      lookups.staffByName.set(name.toLowerCase(), r.rows[0].id);
    }
    for (const [barcode, sample] of unmatchedBarcodes) {
      const r = await client.query(
        `INSERT INTO items (source, product_title, variant_title, sku, barcode, tracked, status)
         VALUES ('local', $1, $2, $3, $4, true, 'active') RETURNING id`,
        [sample.product || `(Stocky) ${barcode}`, sample.variant || '', sample.sku || '', barcode]);
      lookups.itemByBarcode.set(barcode, r.rows[0].id);
      itemsCreated++;
    }
    for (const e of plan.events) {
      const ev = await client.query(
        `INSERT INTO inventory_events
           (shopify_group_gid, occurred_at, activity, reason, app_name, staff_name,
            reference_document_uri, reference_document_type, reference_document_id,
            source_type, raw)
         VALUES ($1,$2,'manual_adjustment',$3,'Stocky',$4,NULL,'StockyAdjustment',$5,'import',$6::jsonb)
         ON CONFLICT (shopify_group_gid) DO NOTHING
         RETURNING id`,
        [`stocky:adjustment:${e.number}`, e.occurredAt, e.reason, e.staffName,
          e.number, JSON.stringify({ imported: true, number: e.number })]);
      let eventId = ev.rows[0]?.id;
      if (eventId) eventsInserted++;
      else {
        const existing = await client.query(
          'SELECT id FROM inventory_events WHERE shopify_group_gid=$1',
          [`stocky:adjustment:${e.number}`]);
        eventId = existing.rows[0].id;
      }
      for (const l of e.lines) {
        const itemId = lookups.itemByBarcode.get(l.barcode);
        const locationId = lookups.locByName.get(l.location.toLowerCase());
        if (!itemId || !locationId) continue;
        const r = await client.query(
          `INSERT INTO inventory_ledger
             (item_id, location_id, state, delta, qty_after, occurred_at, source_type,
              source_ref, reason_code, staff_id, notes, attribution, attributed_at,
              event_id, external_change_id, app_name, actor_name)
           VALUES ($1,$2,'available',$3,NULL,$4,'import',$5,$6,$7,$8,'manual',now(),
                   $9,$10,'Stocky',$11)
           ON CONFLICT (external_change_id) WHERE external_change_id IS NOT NULL DO NOTHING`,
          [itemId, locationId, l.delta, e.occurredAt, `Stocky #${e.number}`,
            e.reason, l.employee ? lookups.staffByName.get(l.employee.toLowerCase()) || null : null,
            l.notes, eventId, `stocky:${e.number}:${l.csvLine}`, l.employee]);
        if (r.rowCount) linesInserted++;
      }
    }
    // Every group also becomes an adjustment record in the 库存调整 workspace:
    // original Stocky number as display_number 'STK-xxxx' (number stays NULL so
    // the app's own sequence is untouched), original reason/staff/notes, one
    // merged line per item+location, recorded_by + handled_by participants.
    // linkGid ties the record to the event that carries it in 修改记录.
    const createStk = async (e, linkGid) => {
      const adj = await client.query(
        `INSERT INTO adjustments
           (number, display_number, reason_id, staff_id, created_by_staff_id,
            notes, status, applied_at, shopify_group_gid, created_at, updated_at)
         VALUES (NULL, $1, $2, $3, $3, $4, 'applied', $5, $6, $5, $5)
         ON CONFLICT (display_number) WHERE display_number IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          `STK-${e.number}`,
          e.reason ? lookups.reasonByName.get(e.reason.trim().toLowerCase()) || null : null,
          e.staffName ? lookups.staffByName.get(e.staffName.toLowerCase()) || null : null,
          e.notes, e.occurredAt, linkGid,
        ]);
      if (!adj.rowCount) return false; // already imported
      const adjustmentId = adj.rows[0].id;
      adjustmentsCreated++;
      if (e.staffName) {
        await client.query(
          `INSERT INTO adjustment_participants (adjustment_id, role, staff_id, display_name_snapshot)
           VALUES ($1, 'recorded_by', $2, $3)
           ON CONFLICT DO NOTHING`,
          [adjustmentId, lookups.staffByName.get(e.staffName.toLowerCase()) || null, e.staffName]);
      }
      const others = [...new Set(e.lines.map((l) => l.employee).filter(Boolean))]
        .filter((n) => n.toLowerCase() !== (e.staffName || '').toLowerCase());
      for (const name of others) {
        await client.query(
          `INSERT INTO adjustment_participants (adjustment_id, role, staff_id, display_name_snapshot)
           VALUES ($1, 'handled_by', $2, $3)`,
          [adjustmentId, lookups.staffByName.get(name.toLowerCase()) || null, name]);
      }
      for (const l of mergeAdjustmentLines(e.lines)) {
        const itemId = lookups.itemByBarcode.get(l.barcode);
        const locationId = lookups.locByName.get(l.location.toLowerCase());
        if (!itemId || !locationId) continue;
        await client.query(
          `INSERT INTO adjustment_lines (adjustment_id, item_id, location_id, qty_before, delta, qty_after)
           VALUES ($1,$2,$3,NULL,$4,NULL)
           ON CONFLICT (adjustment_id, item_id, location_id) DO NOTHING`,
          [adjustmentId, itemId, locationId, l.delta]);
      }
      return true;
    };

    for (const e of plan.events) {
      await createStk(e, `stocky:adjustment:${e.number}`);
    }

    // Covered era: match onto the existing formal record, back-fill its
    // employee/notes/reason, and link the STK record to that same event.
    // Unmatched/ambiguous groups still get their STK archive record (with a
    // standalone link id) but no formal record is touched.
    const claimed = new Set();
    const covered = { matched: 0, unmatched: [], ambiguous: [] };
    const exec = (text, params) => client.query(text, params);
    for (const e of plan.coveredEvents) {
      const r = await mapCoveredEvent(e, lookups, exec, claimed, { commit: true });
      if (r.status === 'matched') covered.matched++;
      else covered[r.status].push(e.number);
      await createStk(e, r.eventGid || `stocky:adjustment:${e.number}`);
    }
    report.coveredMapping = {
      matched: covered.matched,
      unmatched: covered.unmatched.length,
      unmatchedSamples: covered.unmatched.slice(0, 10),
      ambiguous: covered.ambiguous.length,
      ambiguousSamples: covered.ambiguous.slice(0, 10),
    };
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { dryRun: false, report, eventsInserted, linesInserted, itemsCreated, adjustmentsCreated };
}

// Full reversal of a Stocky import. Everything the import CREATED is deleted by
// its stocky:/STK- markers; everything it BACK-FILLED onto pre-existing formal
// rows is reverted field-by-field from the tracking table (never touching data
// Shopify or a manual edit provided). Idempotent — safe to run twice.
export async function undoStockyImport() {
  const client = await pool.connect();
  const result = { revertedBackfillRows: 0, deletedAdjustments: 0, deletedEvents: 0, deletedLedgerRows: 0, deletedLocalItems: 0 };
  try {
    await client.query('BEGIN');

    // 1. Revert back-filled columns on existing formal rows, then clear the log.
    const backfill = await client.query('SELECT ledger_id, filled FROM stocky_import_backfill');
    for (const row of backfill.rows) {
      const cols = Array.isArray(row.filled) ? row.filled : [];
      const sets = cols.filter((c) => ['notes', 'reason_code', 'actor_name', 'staff_id'].includes(c))
        .map((c) => `${c} = NULL`);
      if (sets.length) {
        await client.query(`UPDATE inventory_ledger SET ${sets.join(', ')} WHERE id=$1`, [row.ledger_id]);
        result.revertedBackfillRows++;
      }
    }
    await client.query('DELETE FROM stocky_import_backfill');

    // 2. Delete STK adjustment records (participants + lines cascade / explicit).
    const stkIds = await client.query(`SELECT id FROM adjustments WHERE display_number LIKE 'STK-%'`);
    for (const { id } of stkIds.rows) {
      await client.query('DELETE FROM adjustment_participants WHERE adjustment_id=$1', [id]);
      await client.query('DELETE FROM adjustment_lines WHERE adjustment_id=$1', [id]);
    }
    const delAdj = await client.query(`DELETE FROM adjustments WHERE display_number LIKE 'STK-%'`);
    result.deletedAdjustments = delAdj.rowCount;

    // 3. Delete import-created ledger rows + their events (source_type='import').
    const delLedger = await client.query(
      `DELETE FROM inventory_ledger WHERE event_id IN
         (SELECT id FROM inventory_events WHERE source_type='import' AND shopify_group_gid LIKE 'stocky:%')`);
    result.deletedLedgerRows = delLedger.rowCount;
    const delEvents = await client.query(
      `DELETE FROM inventory_events WHERE source_type='import' AND shopify_group_gid LIKE 'stocky:%'`);
    result.deletedEvents = delEvents.rowCount;

    // 4. Local items the import created that now have NO references anywhere
    //    (all their ledger rows and adjustment lines are gone) are removed, so a
    //    later re-import recreates them fresh and active. A local item still
    //    referenced by a manually-created adjustment is kept untouched.
    const del = await client.query(
      `DELETE FROM items WHERE source='local'
         AND NOT EXISTS (SELECT 1 FROM inventory_ledger lg WHERE lg.item_id=items.id)
         AND NOT EXISTS (SELECT 1 FROM adjustment_lines al WHERE al.item_id=items.id)
         AND NOT EXISTS (SELECT 1 FROM current_levels cl WHERE cl.item_id=items.id)`);
    result.deletedLocalItems = del.rowCount;

    // 5. Clear the one-shot flag so the import can be re-run.
    await client.query(`DELETE FROM sync_state WHERE key='stocky_import'`);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
