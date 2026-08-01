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
    if (coverageStart && +new Date(date) >= +new Date(coverageStart)) {
      issues.coveredGroups++;
      issues.coveredRows += adjusted.length;
      continue;
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
    events.push({
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
  return { itemByBarcode, dupBarcodes: [...dupBarcodes], locByName, staffByName, barcodes };
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

  const unmatchedBarcodes = new Map(); // barcode → sample line info (→ local item)
  for (const e of plan.events) {
    for (const l of e.lines) {
      if (!lookups.itemByBarcode.has(l.barcode) && !unmatchedBarcodes.has(l.barcode)) {
        unmatchedBarcodes.set(l.barcode, l);
      }
    }
  }
  const newLocations = [...new Set(plan.events.flatMap((e) => e.lines.map((l) => l.location)))]
    .filter((n) => n && !lookups.locByName.has(n.toLowerCase()));
  const newStaff = plan.employees.filter((n) => !lookups.staffByName.has(n.toLowerCase()));

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
    localItemsToCreate: unmatchedBarcodes.size,
    localItemSamples: [...unmatchedBarcodes.values()].slice(0, 10)
      .map((l) => ({ barcode: l.barcode, sku: l.sku, product: l.product || '(无标题)' })),
    duplicateBarcodesInCatalog: lookups.dupBarcodes.slice(0, 20),
  };
  if (!commit) return { dryRun: true, report };

  const client = await pool.connect();
  let eventsInserted = 0, linesInserted = 0, itemsCreated = 0;
  try {
    await client.query('BEGIN');
    for (const name of newLocations) {
      const r = await client.query(
        `INSERT INTO locations (shopify_gid, name, active) VALUES (NULL, $1, false) RETURNING id`, [name]);
      lookups.locByName.set(name.toLowerCase(), r.rows[0].id);
    }
    for (const name of newStaff) {
      const r = await client.query(
        `INSERT INTO staff (shopify_user_id, display_name, role, active)
         VALUES (NULL, $1, 'member', false) RETURNING id`, [name]);
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { dryRun: false, report, eventsInserted, linesInserted, itemsCreated };
}
