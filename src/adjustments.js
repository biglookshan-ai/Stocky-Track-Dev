import { pool, q } from './db.js';
import { graphql, idempotencyKey } from './shopify.js';
import {
  buildInventoryAdjustmentInput,
  csvCell,
  newAdjustmentDisplayNumber,
  normalizeAdjustmentInput,
} from './adjustment-core.js';
import { listAdjustmentAttachments } from './adjustment-attachments.js';

const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || 'stocky-track-dev';

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function participantSnapshot(client, person, fallbackStaffId = null) {
  const staffId = person?.staffId || fallbackStaffId;
  if (staffId) {
    const staff = await client.query(
      `SELECT id, display_name FROM staff WHERE id=$1 AND active`,
      [staffId],
    );
    if (!staff.rowCount) throw new Error('所选员工不存在或已停用');
    return {
      staffId: staff.rows[0].id,
      name: person?.name || staff.rows[0].display_name,
    };
  }
  const name = String(person?.name || '').trim().slice(0, 120);
  if (!name) throw new Error('请填写记录员工');
  return { staffId: null, name };
}

async function saveParticipants(client, adjustmentId, input, loginStaffId, isNew) {
  let recordedBy = input.recordedBy;
  if (!recordedBy && !isNew) {
    const current = await client.query(
      `SELECT staff_id, display_name_snapshot AS name
       FROM adjustment_participants
       WHERE adjustment_id=$1 AND role='recorded_by'`,
      [adjustmentId],
    );
    recordedBy = current.rows[0]
      ? { staffId: current.rows[0].staff_id, name: current.rows[0].name }
      : null;
  }
  const recorded = await participantSnapshot(client, recordedBy, loginStaffId);
  await client.query(
    `DELETE FROM adjustment_participants
     WHERE adjustment_id=$1 AND role IN ('recorded_by','handled_by')`,
    [adjustmentId],
  );
  await client.query(
    `INSERT INTO adjustment_participants
       (adjustment_id, role, staff_id, display_name_snapshot)
     VALUES ($1,'recorded_by',$2,$3)`,
    [adjustmentId, recorded.staffId, recorded.name],
  );
  for (const person of input.handledBy) {
    const handled = await participantSnapshot(client, person);
    await client.query(
      `INSERT INTO adjustment_participants
         (adjustment_id, role, staff_id, display_name_snapshot)
       VALUES ($1,'handled_by',$2,$3)`,
      [adjustmentId, handled.staffId, handled.name],
    );
  }
}

function adjustmentReference(shop, id) {
  const handle = String(shop).replace(/\.myshopify\.com$/i, '');
  return `https://admin.shopify.com/store/${encodeURIComponent(handle)}/apps/${APP_HANDLE}#/adjustments/${id}`;
}

async function validateAndInsertLines(client, adjustmentId, input) {
  const { rows: reasons } = await client.query(
    'SELECT id, direction FROM adjustment_reasons WHERE id=$1 AND active',
    [input.reasonId],
  );
  if (!reasons.length) throw new Error('Adjustment reason 不可用');
  if (reasons[0].direction === 'in' && input.lines.some((line) => line.delta < 0)) {
    throw new Error('该 Adjustment reason 只允许增加库存');
  }
  if (reasons[0].direction === 'out' && input.lines.some((line) => line.delta > 0)) {
    throw new Error('该 Adjustment reason 只允许减少库存');
  }
  const { rows: locations } = await client.query(
    'SELECT id, shopify_gid FROM locations WHERE id=$1 AND active AND shopify_gid IS NOT NULL',
    [input.locationId],
  );
  if (!locations.length) throw new Error('仓位不可用');

  const itemIds = input.lines.map((line) => line.itemId);
  const { rows: items } = await client.query(
    `SELECT i.id, i.unit_cost, i.tracked, i.status, i.shopify_inventory_item_gid,
            cl.available
     FROM items i
     LEFT JOIN current_levels cl ON cl.item_id=i.id AND cl.location_id=$2
     WHERE i.id=ANY($1::int[])`,
    [itemIds, input.locationId],
  );
  const itemMap = new Map(items.map((item) => [item.id, item]));
  for (const line of input.lines) {
    const item = itemMap.get(line.itemId);
    if (!item || item.status === 'deleted') throw new Error(`商品 ${line.itemId} 不存在`);
    if (!item.tracked || !item.shopify_inventory_item_gid) throw new Error(`商品 ${line.itemId} 不支持 Shopify 库存调整`);
    if (item.available === null || item.available === undefined) throw new Error(`商品 ${line.itemId} 在该仓位没有可调整库存`);
    await client.query(
      `INSERT INTO adjustment_lines
         (adjustment_id, item_id, location_id, qty_before, delta, qty_after, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        adjustmentId, line.itemId, input.locationId, item.available,
        line.delta, Number(item.available) + line.delta, item.unit_cost,
      ],
    );
  }
}

export async function listAdjustmentOptions() {
  const [reasons, locations, staff] = await Promise.all([
    q(`SELECT id, name, direction, active, position
       FROM adjustment_reasons ORDER BY position, id`),
    q(`SELECT id, name FROM locations
       WHERE active AND shopify_gid IS NOT NULL ORDER BY name`),
    q(`SELECT id, shopify_user_id, employee_code, display_name, role, active
       FROM staff ORDER BY active DESC, lower(display_name), id`),
  ]);
  return { reasons: reasons.rows, locations: locations.rows, staff: staff.rows };
}

export async function searchAdjustmentItems({ term, locationId }) {
  const location = Number(locationId);
  if (!Number.isInteger(location) || location <= 0) throw new Error('请选择仓位');
  const search = String(term || '').trim().slice(0, 100);
  if (!search) return [];
  const like = `%${search}%`;
  const result = await q(
    `SELECT i.id, i.product_title, i.variant_title, i.barcode, i.sku, i.vendor,
            i.shopify_inventory_item_gid, cl.available
     FROM items i
     JOIN current_levels cl ON cl.item_id=i.id AND cl.location_id=$1
     WHERE i.status <> 'deleted' AND i.tracked AND i.shopify_inventory_item_gid IS NOT NULL
       AND cl.available IS NOT NULL
       AND (i.barcode ILIKE $2 OR i.sku ILIKE $2 OR i.product_title ILIKE $2
            OR i.variant_title ILIKE $2 OR i.vendor ILIKE $2)
     ORDER BY
       CASE WHEN i.barcode=$3 THEN 0 WHEN i.sku=$3 THEN 1 ELSE 2 END,
       i.product_title, i.variant_title
     LIMIT 30`,
    [location, like, search],
  );
  return result.rows;
}

export async function saveAdjustmentDraft({ id = null, input: rawInput, staffId }) {
  const input = normalizeAdjustmentInput(rawInput);
  return transaction(async (client) => {
    let adjustmentId = Number(id);
    const isNew = !adjustmentId;
    if (adjustmentId) {
      const existing = await client.query(
        'SELECT id, status FROM adjustments WHERE id=$1 FOR UPDATE',
        [adjustmentId],
      );
      if (!existing.rowCount) throw new Error('调整单不存在');
      if (existing.rows[0].status !== 'draft') throw new Error('只有 Draft 调整单可以编辑');
      await client.query(
        `UPDATE adjustments
         SET reason_id=$2, notes=$3,
             apply_error=NULL, updated_at=now()
         WHERE id=$1`,
        [adjustmentId, input.reasonId, input.notes],
      );
      await client.query('DELETE FROM adjustment_lines WHERE adjustment_id=$1', [adjustmentId]);
    } else {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('inventory-adjustment-number'))`);
      const number = await client.query('SELECT COALESCE(max(number), 0)::int + 1 AS next FROM adjustments');
      const displayNumber = newAdjustmentDisplayNumber(number.rows[0].next);
      const created = await client.query(
        `INSERT INTO adjustments
           (number, display_number, reason_id, staff_id, created_by_staff_id,
            notes, status, idempotency_key, updated_at)
         VALUES ($1,$2,$3,$4,$4,$5,'draft',$6,now())
         RETURNING id`,
        [
          number.rows[0].next, displayNumber, input.reasonId,
          staffId || null, input.notes, idempotencyKey(),
        ],
      );
      adjustmentId = created.rows[0].id;
    }
    await saveParticipants(client, adjustmentId, input, staffId, isNew);
    await validateAndInsertLines(client, adjustmentId, input);
    return adjustmentId;
  });
}

function adjustmentFilters({
  status, reasonId, staffId, term, locationId, direction, dateFrom, dateTo,
}, params) {
  const filters = ['1=1'];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (['draft', 'applying', 'applied', 'archived'].includes(status)) {
    filters.push(`a.status=${add(status)}`);
  }
  if (Number(reasonId) > 0) filters.push(`a.reason_id=${add(Number(reasonId))}`);
  if (Number(staffId) > 0) {
    const p = add(Number(staffId));
    filters.push(`(a.staff_id=${p} OR a.created_by_staff_id=${p}
      OR a.applied_by_staff_id=${p} OR EXISTS (
        SELECT 1 FROM adjustment_participants fp
        WHERE fp.adjustment_id=a.id AND fp.staff_id=${p}
      ))`);
  }
  if (Number(locationId) > 0) {
    const p = add(Number(locationId));
    filters.push(`EXISTS (
      SELECT 1 FROM adjustment_lines fl
      WHERE fl.adjustment_id=a.id AND fl.location_id=${p}
    )`);
  }
  if (direction === 'increase') {
    filters.push(`EXISTS (SELECT 1 FROM adjustment_lines fl
      WHERE fl.adjustment_id=a.id AND fl.delta > 0)`);
  } else if (direction === 'decrease') {
    filters.push(`EXISTS (SELECT 1 FROM adjustment_lines fl
      WHERE fl.adjustment_id=a.id AND fl.delta < 0)`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || ''))) {
    filters.push(`a.created_at >= ${add(`${dateFrom}T00:00:00Z`)}::timestamptz`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || ''))) {
    filters.push(`a.created_at < ${add(`${dateTo}T00:00:00Z`)}::timestamptz + interval '1 day'`);
  }
  const search = String(term || '').trim().slice(0, 100);
  if (search) {
    const p = add(`%${search}%`);
    filters.push(`(a.number::text ILIKE ${p} OR a.display_number ILIKE ${p}
      OR a.notes ILIKE ${p}
      OR EXISTS (
        SELECT 1 FROM staff fs
        WHERE fs.id IN (a.staff_id, a.created_by_staff_id, a.applied_by_staff_id)
          AND (fs.display_name ILIKE ${p} OR fs.employee_code ILIKE ${p}
               OR fs.shopify_user_id ILIKE ${p})
      )
      OR EXISTS (
        SELECT 1 FROM adjustment_participants fp
        WHERE fp.adjustment_id=a.id AND fp.display_name_snapshot ILIKE ${p}
      )
      OR EXISTS (
      SELECT 1 FROM adjustment_lines fl
      JOIN items fi ON fi.id=fl.item_id
      WHERE fl.adjustment_id=a.id
        AND (fi.barcode ILIKE ${p} OR fi.sku ILIKE ${p}
             OR fi.product_title ILIKE ${p} OR fi.variant_title ILIKE ${p}
             OR fi.vendor ILIKE ${p})
    ))`);
  }
  return filters.join(' AND ');
}

export async function listAdjustments(filters = {}) {
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(filters.limit || 25)));
  const params = [];
  const where = adjustmentFilters(filters, params);
  const [count, rows] = await Promise.all([
    q(`SELECT count(*)::int total FROM adjustments a WHERE ${where}`, params),
    q(`SELECT a.id, a.number, a.display_number, a.status, a.notes,
              a.created_at, a.applied_at, a.apply_error, r.name AS reason,
              login.display_name AS login_account_name,
              created.display_name AS created_by_account_name,
              applied.display_name AS applied_by_account_name,
              participants.recorded_by_name, participants.handled_by_names,
              count(al.id)::int AS line_count,
              COALESCE(sum(al.delta), 0)::int AS total_delta,
              string_agg(DISTINCT l.name, ', ' ORDER BY l.name) AS locations
       FROM adjustments a
       LEFT JOIN adjustment_reasons r ON r.id=a.reason_id
       LEFT JOIN staff login ON login.id=a.staff_id
       LEFT JOIN staff created ON created.id=a.created_by_staff_id
       LEFT JOIN staff applied ON applied.id=a.applied_by_staff_id
       LEFT JOIN LATERAL (
         SELECT
           max(display_name_snapshot) FILTER (WHERE role='recorded_by') AS recorded_by_name,
           string_agg(display_name_snapshot, ', ' ORDER BY id)
             FILTER (WHERE role='handled_by') AS handled_by_names
         FROM adjustment_participants ap
         WHERE ap.adjustment_id=a.id
       ) participants ON true
       LEFT JOIN adjustment_lines al ON al.adjustment_id=a.id
       LEFT JOIN locations l ON l.id=al.location_id
       WHERE ${where}
       GROUP BY a.id, r.name, login.display_name, created.display_name,
                applied.display_name, participants.recorded_by_name,
                participants.handled_by_names
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]),
  ]);
  return { rows: rows.rows, total: count.rows[0].total, page, pageSize };
}

export async function getAdjustment(id) {
  const adjustmentId = Number(id);
  const [header, lines, attachments, participants] = await Promise.all([
    q(`SELECT a.*, r.name AS reason, r.direction,
              login.display_name AS login_account_name,
              login.shopify_user_id AS login_shopify_user_id,
              created.display_name AS created_by_account_name,
              applied.display_name AS applied_by_account_name
       FROM adjustments a
       LEFT JOIN adjustment_reasons r ON r.id=a.reason_id
       LEFT JOIN staff login ON login.id=a.staff_id
       LEFT JOIN staff created ON created.id=a.created_by_staff_id
       LEFT JOIN staff applied ON applied.id=a.applied_by_staff_id
       WHERE a.id=$1`, [adjustmentId]),
    q(`SELECT al.*, i.product_title, i.variant_title, i.barcode, i.sku, i.vendor,
              i.source, i.shopify_inventory_item_gid, l.name AS location,
              l.shopify_gid AS shopify_location_gid,
              cl.available AS current_available
       FROM adjustment_lines al
       JOIN items i ON i.id=al.item_id
       JOIN locations l ON l.id=al.location_id
       LEFT JOIN current_levels cl ON cl.item_id=al.item_id AND cl.location_id=al.location_id
       WHERE al.adjustment_id=$1
       ORDER BY al.id`, [adjustmentId]),
    listAdjustmentAttachments(adjustmentId),
    q(`SELECT ap.id, ap.role, ap.staff_id, ap.display_name_snapshot AS name
       FROM adjustment_participants ap
       WHERE ap.adjustment_id=$1
       ORDER BY CASE ap.role WHEN 'recorded_by' THEN 0 ELSE 1 END, ap.id`,
      [adjustmentId]),
  ]);
  if (!header.rowCount) return null;
  const people = participants.rows;
  return {
    ...header.rows[0],
    recorded_by: people.find((person) => person.role === 'recorded_by') || null,
    handled_by: people.filter((person) => person.role === 'handled_by'),
    lines: lines.rows,
    attachments,
  };
}

async function prepareApply(id, shop, applyingStaffId) {
  return transaction(async (client) => {
    const header = await client.query(
      `SELECT a.*, r.name AS reason, s.display_name AS staff_name,
              s.shopify_user_id
       FROM adjustments a
       JOIN adjustment_reasons r ON r.id=a.reason_id
       LEFT JOIN staff s ON s.id=a.staff_id
       WHERE a.id=$1 FOR UPDATE OF a`,
      [id],
    );
    if (!header.rowCount) throw new Error('调整单不存在');
    const adjustment = header.rows[0];
    if (adjustment.status === 'applied') return { alreadyApplied: true, adjustment };
    if (adjustment.status === 'archived') throw new Error('已归档调整单不能提交');
    if (!['draft', 'applying'].includes(adjustment.status)) throw new Error('调整单状态不可提交');
    if (adjustment.status === 'draft' && applyingStaffId) {
      const actor = await client.query(
        'SELECT id, shopify_user_id, display_name FROM staff WHERE id=$1 AND active',
        [applyingStaffId],
      );
      if (!actor.rowCount) throw new Error('当前员工账号不可用于库存调整');
      await client.query(
        `UPDATE adjustments
         SET staff_id=$2, applied_by_staff_id=$2, updated_at=now()
         WHERE id=$1`,
        [id, applyingStaffId],
      );
      adjustment.staff_id = actor.rows[0].id;
      adjustment.shopify_user_id = actor.rows[0].shopify_user_id;
      adjustment.staff_name = actor.rows[0].display_name;
    }

    const lines = await client.query(
      `SELECT al.*, i.shopify_inventory_item_gid,
              l.shopify_gid AS shopify_location_gid,
              cl.available AS current_available
       FROM adjustment_lines al
       JOIN items i ON i.id=al.item_id
       JOIN locations l ON l.id=al.location_id
       LEFT JOIN current_levels cl ON cl.item_id=al.item_id AND cl.location_id=al.location_id
       WHERE al.adjustment_id=$1 ORDER BY al.id`,
      [id],
    );
    if (!lines.rowCount) throw new Error('调整单没有商品');
    for (const line of lines.rows) {
      if (!line.shopify_inventory_item_gid || !line.shopify_location_gid) {
        throw new Error('调整单包含无法写入 Shopify 的商品或仓位');
      }
      if (adjustment.status === 'draft') {
        if (line.current_available === null || line.current_available === undefined) {
          throw new Error('当前库存不可用，请先同步商品');
        }
        line.qty_before = Number(line.current_available);
        line.qty_after = line.qty_before + Number(line.delta);
        await client.query(
          'UPDATE adjustment_lines SET qty_before=$2, qty_after=$3 WHERE id=$1',
          [line.id, line.qty_before, line.qty_after],
        );
      } else if (line.qty_before === null || line.qty_after === null) {
        throw new Error('重试信息不完整，请联系管理员');
      }
    }
    const reference = adjustment.reference_document_uri || adjustmentReference(shop, id);
    const key = adjustment.idempotency_key || idempotencyKey();
    await client.query(
      `UPDATE adjustments
       SET status='applying', reference_document_uri=$2, idempotency_key=$3,
           apply_error=NULL, updated_at=now()
       WHERE id=$1`,
      [id, reference, key],
    );
    return {
      alreadyApplied: false,
      adjustment: { ...adjustment, reference_document_uri: reference, idempotency_key: key },
      lines: lines.rows,
    };
  });
}

async function finalizeApply(id, group) {
  return transaction(async (client) => {
    const header = await client.query(
      `SELECT a.*, r.name AS reason, s.display_name AS staff_name,
              s.shopify_user_id
       FROM adjustments a
       JOIN adjustment_reasons r ON r.id=a.reason_id
       LEFT JOIN staff s ON s.id=a.staff_id
       WHERE a.id=$1 FOR UPDATE OF a`,
      [id],
    );
    if (!header.rowCount) throw new Error('调整单不存在');
    const adjustment = header.rows[0];
    if (adjustment.status === 'applied') return;
    if (adjustment.status !== 'applying') throw new Error('调整单提交状态已变化');
    const occurredAt = group.createdAt || new Date().toISOString();
    const event = await client.query(
      `INSERT INTO inventory_events
         (shopify_group_gid, occurred_at, activity, reason, app_name,
          staff_shopify_id, staff_name, reference_document_uri,
          reference_document_type, reference_document_id, source_type, raw)
       VALUES ($1,$2,'manual_adjustment',$3,'CGP Inventory',$4,$5,$6,
               'Adjustment',$7,'adjustment',$8::jsonb)
       ON CONFLICT (shopify_group_gid) DO UPDATE SET
         reason=EXCLUDED.reason, staff_name=COALESCE(EXCLUDED.staff_name, inventory_events.staff_name),
         reference_document_uri=EXCLUDED.reference_document_uri
       RETURNING id`,
      [
        group.id, occurredAt, adjustment.reason, adjustment.shopify_user_id || null,
        adjustment.staff_name || null, adjustment.reference_document_uri,
        String(adjustment.number), JSON.stringify(group),
      ],
    );
    const eventId = event.rows[0].id;
    const lines = await client.query(
      `SELECT al.*
       FROM adjustment_lines al
       WHERE al.adjustment_id=$1 ORDER BY al.id`,
      [id],
    );
    for (const line of lines.rows) {
      const delta = Number(line.delta);
      await client.query(
        `UPDATE current_levels
         SET available=$3, updated_at=now()
         WHERE item_id=$1 AND location_id=$2`,
        [line.item_id, line.location_id, line.qty_after],
      );
      await client.query(
        `INSERT INTO inventory_ledger
           (item_id, location_id, state, delta, qty_after, occurred_at,
            source_type, source_ref, reason_code, staff_id, notes, attribution,
            attributed_at, event_id, app_name, actor_name, reference_document_uri)
         VALUES ($1,$2,'available',$3,$4,$5,'external_app',$6,$7,$8,$9,
                 'matched',now(),$10,'CGP Inventory',$11,$12)`,
        [
          line.item_id, line.location_id, delta, line.qty_after, occurredAt,
          `Adjustment #${adjustment.number}`, adjustment.reason,
          adjustment.staff_id || null, adjustment.notes || null, eventId,
          adjustment.staff_name || 'CGP Inventory', adjustment.reference_document_uri,
        ],
      );
    }
    await client.query(
      `UPDATE adjustments
       SET status='applied', applied_at=$2, shopify_group_gid=$3,
           apply_error=NULL, updated_at=now()
       WHERE id=$1`,
      [id, occurredAt, group.id],
    );
  });
}

export async function applyAdjustment({ id, ctx, staffId }) {
  const adjustmentId = Number(id);
  const prepared = await prepareApply(adjustmentId, ctx.shop, staffId);
  if (prepared.alreadyApplied) return { alreadyApplied: true, adjustment: await getAdjustment(adjustmentId) };
  const input = buildInventoryAdjustmentInput({
    lines: prepared.lines,
    reasonName: prepared.adjustment.reason,
    referenceDocumentUri: prepared.adjustment.reference_document_uri,
  });
  let data;
  try {
    data = await graphql(ctx, `
      mutation ApplyInventoryAdjustment(
        $input: InventoryAdjustQuantitiesInput!,
        $idempotencyKey: String!
      ) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup {
            id createdAt reason referenceDocumentUri
            changes { name delta quantityAfterChange }
          }
          userErrors { field message code }
        }
      }`,
    { input, idempotencyKey: prepared.adjustment.idempotency_key });
  } catch (error) {
    await q('UPDATE adjustments SET apply_error=$2, updated_at=now() WHERE id=$1',
      [adjustmentId, error.message]).catch(() => {});
    throw new Error(`Shopify 请求状态未知，可安全重试：${error.message}`);
  }
  const payload = data.inventoryAdjustQuantities;
  if (payload.userErrors?.length) {
    const message = payload.userErrors.map((error) =>
      `${error.code || 'ERROR'}: ${error.message}`).join('；');
    await q(
      `UPDATE adjustments
       SET status='draft', apply_error=$2, idempotency_key=$3, updated_at=now()
       WHERE id=$1`,
      [adjustmentId, message, idempotencyKey()],
    );
    throw new Error(message);
  }
  if (!payload.inventoryAdjustmentGroup?.id) throw new Error('Shopify 没有返回调整记录');
  await finalizeApply(adjustmentId, payload.inventoryAdjustmentGroup);
  return { alreadyApplied: false, adjustment: await getAdjustment(adjustmentId) };
}

export async function archiveAdjustment(id) {
  const result = await q(
    `UPDATE adjustments
     SET status='archived', archived_at=now(), updated_at=now()
     WHERE id=$1 AND status IN ('draft','applied')
     RETURNING id`,
    [Number(id)],
  );
  if (!result.rowCount) throw new Error('该调整单当前不能归档');
}

export async function createAdjustmentReason(input) {
  const name = String(input.name || '').trim().slice(0, 120);
  const direction = ['in', 'out', 'any'].includes(input.direction) ? input.direction : 'any';
  if (!name) throw new Error('原因名称不能为空');
  const result = await q(
    `INSERT INTO adjustment_reasons (name, direction, active, position)
     VALUES ($1,$2,true,(SELECT COALESCE(max(position),0)+1 FROM adjustment_reasons))
     RETURNING *`,
    [name, direction],
  );
  return result.rows[0];
}

export async function updateAdjustmentReason(id, input) {
  const name = String(input.name || '').trim().slice(0, 120);
  const direction = ['in', 'out', 'any'].includes(input.direction) ? input.direction : 'any';
  if (!name) throw new Error('原因名称不能为空');
  const result = await q(
    `UPDATE adjustment_reasons
     SET name=$2, direction=$3, active=$4
     WHERE id=$1 RETURNING *`,
    [Number(id), name, direction, input.active !== false],
  );
  if (!result.rowCount) throw new Error('原因不存在');
  return result.rows[0];
}

export async function updateStaff(id, input) {
  const displayName = String(input.displayName || '').trim().slice(0, 120);
  const employeeCode = String(input.employeeCode || '').trim().slice(0, 60) || null;
  if (!displayName) throw new Error('员工名称不能为空');
  const result = await q(
    `UPDATE staff
     SET display_name=$2, employee_code=$3, active=$4
     WHERE id=$1
     RETURNING id, shopify_user_id, employee_code, display_name, role, active`,
    [Number(id), displayName, employeeCode, input.active !== false],
  );
  if (!result.rowCount) throw new Error('员工不存在');
  return result.rows[0];
}

export async function createStaff(input) {
  const displayName = String(input.displayName || '').trim().slice(0, 120);
  const employeeCode = String(input.employeeCode || '').trim().slice(0, 60) || null;
  if (!displayName) throw new Error('员工名称不能为空');
  const result = await q(
    `INSERT INTO staff (display_name, employee_code, role, active)
     VALUES ($1,$2,'member',true)
     RETURNING id, shopify_user_id, employee_code, display_name, role, active`,
    [displayName, employeeCode],
  );
  return result.rows[0];
}

export async function adjustmentsCsv(filters = {}) {
  const params = [];
  const where = adjustmentFilters(filters, params);
  const result = await q(
    `SELECT COALESCE(a.display_number, 'ADJ-' || lpad(a.number::text, 5, '0')) AS adjustment_number,
            a.status, a.created_at, a.applied_at, r.name AS reason,
            login.display_name AS login_account,
            participants.recorded_by_name, participants.handled_by_names, a.notes,
            l.name AS location, i.barcode, i.sku, i.vendor,
            i.product_title, i.variant_title,
            al.qty_before, al.delta, al.qty_after
     FROM adjustments a
     LEFT JOIN adjustment_reasons r ON r.id=a.reason_id
     LEFT JOIN staff login ON login.id=a.staff_id
     LEFT JOIN LATERAL (
       SELECT
         max(display_name_snapshot) FILTER (WHERE role='recorded_by') AS recorded_by_name,
         string_agg(display_name_snapshot, ', ' ORDER BY id)
           FILTER (WHERE role='handled_by') AS handled_by_names
       FROM adjustment_participants ap
       WHERE ap.adjustment_id=a.id
     ) participants ON true
     JOIN adjustment_lines al ON al.adjustment_id=a.id
     JOIN items i ON i.id=al.item_id
     JOIN locations l ON l.id=al.location_id
     WHERE ${where}
     ORDER BY a.created_at DESC, a.id DESC, al.id`,
    params,
  );
  const headers = [
    'Adjustment', 'Status', 'Created at', 'Applied at', 'Reason',
    'Shopify account', 'Recorded by', 'Handled by', 'Notes', 'Location',
    'Barcode', 'SKU', 'Brand', 'Product', 'Variant', 'Before', 'Delta', 'After',
  ];
  return [
    headers.map(csvCell).join(','),
    ...result.rows.map((row) => [
      row.adjustment_number, row.status, row.created_at?.toISOString?.() || row.created_at,
      row.applied_at?.toISOString?.() || row.applied_at, row.reason,
      row.login_account, row.recorded_by_name, row.handled_by_names, row.notes,
      row.location, row.barcode, row.sku, row.vendor, row.product_title,
      row.variant_title, row.qty_before, row.delta, row.qty_after,
    ].map(csvCell).join(',')),
  ].join('\r\n');
}
