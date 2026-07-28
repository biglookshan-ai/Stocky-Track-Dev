const MAX_LINES = 250;
const MAX_ABS_DELTA = 1_000_000;
const MAX_PARTICIPANTS = 20;

function normalizeParticipant(value, label) {
  if (!value) return null;
  const staffId = Number(value.staffId);
  const normalizedStaffId = Number.isInteger(staffId) && staffId > 0 ? staffId : null;
  const name = String(value.name || '').trim().slice(0, 120);
  if (!normalizedStaffId && !name) throw new Error(`${label}无效`);
  return { staffId: normalizedStaffId, name };
}

export function normalizeAdjustmentInput(input = {}) {
  const locationId = Number(input.locationId);
  const reasonId = Number(input.reasonId);
  const notes = String(input.notes || '').trim().slice(0, 10000);
  if (!Number.isInteger(locationId) || locationId <= 0) throw new Error('请选择仓位');
  if (!Number.isInteger(reasonId) || reasonId <= 0) throw new Error('请选择 Adjustment reason');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('请至少添加一个商品');
  if (input.lines.length > MAX_LINES) throw new Error(`每张调整单最多 ${MAX_LINES} 个商品`);

  const seen = new Set();
  const lines = input.lines.map((line, index) => {
    const itemId = Number(line.itemId);
    const delta = Number(line.delta);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new Error(`第 ${index + 1} 行商品无效`);
    if (!Number.isInteger(delta) || delta === 0) throw new Error(`第 ${index + 1} 行调整数量必须是非零整数`);
    if (Math.abs(delta) > MAX_ABS_DELTA) throw new Error(`第 ${index + 1} 行调整数量过大`);
    if (seen.has(itemId)) throw new Error(`第 ${index + 1} 行商品重复`);
    seen.add(itemId);
    return { itemId, delta };
  });
  const recordedBy = normalizeParticipant(input.recordedBy, '记录员工');
  const handledInput = Array.isArray(input.handledBy) ? input.handledBy : [];
  if (handledInput.length > MAX_PARTICIPANTS) {
    throw new Error(`每张调整单最多 ${MAX_PARTICIPANTS} 位经手员工`);
  }
  const seenParticipants = new Set();
  const handledBy = handledInput.map((person, index) => {
    const normalized = normalizeParticipant(person, `第 ${index + 1} 位经手员工`);
    const key = normalized.staffId
      ? `staff:${normalized.staffId}`
      : `name:${normalized.name.toLocaleLowerCase()}`;
    if (seenParticipants.has(key)) throw new Error('经手员工重复');
    seenParticipants.add(key);
    return normalized;
  });
  return { locationId, reasonId, notes, lines, recordedBy, handledBy };
}

export function newAdjustmentDisplayNumber(number, createdAt = new Date()) {
  const value = Number(number);
  const date = new Date(createdAt);
  if (!Number.isInteger(value) || value <= 0 || !Number.isFinite(+date)) {
    throw new Error('调整编号无效');
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `ADJ-${year}${month}-${String(value).padStart(5, '0')}`;
}

export function shopifyAdjustmentReason(name = '') {
  const normalized = String(name).trim().toLowerCase();
  if (normalized.includes('damaged')) return 'damaged';
  if (normalized.includes('return') || normalized.includes('restock')) return 'restock';
  if (normalized.includes('demo') || normalized.includes('staff purchase') || normalized.includes('resend')) return 'other';
  return 'correction';
}

export function buildInventoryAdjustmentInput({ lines, reasonName, referenceDocumentUri }) {
  return {
    name: 'available',
    reason: shopifyAdjustmentReason(reasonName),
    referenceDocumentUri,
    changes: lines.map((line) => ({
      delta: line.delta,
      inventoryItemId: line.shopify_inventory_item_gid,
      locationId: line.shopify_location_gid,
      changeFromQuantity: line.qty_before,
    })),
  };
}

export function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
