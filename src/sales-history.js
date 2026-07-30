export const SALES_RANGES = new Map([
  ['7', { days: 7, bucket: 'day', label: '最近 7 天' }],
  ['30', { days: 30, bucket: 'day', label: '最近 30 天' }],
  ['90', { days: 90, bucket: 'week', label: '最近 3 个月' }],
  ['180', { days: 180, bucket: 'week', label: '最近半年' }],
  ['365', { days: 365, bucket: 'month', label: '最近一年' }],
  ['all', { days: null, bucket: 'month', label: '全部记录' }],
]);

const DAY_MS = 86400000;

const dayStart = (value) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const normalized = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const referenceText = (row) => normalized([
  row.reference_document_type,
  row.reference_document_uri,
  row.reference_document_id,
].filter(Boolean).join(' '));

export function salesHistoryStart(range, earliestAt, now = new Date()) {
  const config = SALES_RANGES.get(range) || SALES_RANGES.get('30');
  if (range === 'all') return earliestAt ? dayStart(earliestAt) : null;
  const start = dayStart(now);
  start.setUTCDate(start.getUTCDate() - config.days + 1);
  return start;
}

export function classifySalesMovement(row) {
  const delta = Number(row.on_hand_delta);
  if (!Number.isFinite(delta) || delta === 0) return null;

  const activity = normalized(row.activity);
  const source = normalized(row.ledger_source_type || row.source_type);
  const reference = referenceText(row);
  const isTransfer = source === 'transfer'
    || reference.includes('transfer')
    || activity.includes('transfer')
    || activity.includes('shipment_marked_as_in_transit');
  const isPurchaseOrder = reference.includes('purchase_order')
    || reference.includes('purchaseorder')
    || activity === 'purchase_order_received';
  const isOrder = !isPurchaseOrder && (
    source === 'order'
    || source === 'sale'
    || source === 'refund'
    || reference.includes('order')
  );

  if (delta < 0 && isOrder && (
    source === 'sale'
    || activity === 'order_fulfilled'
    || activity.includes('fulfill')
  )) {
    return { type: 'sale', quantity: Math.abs(delta) };
  }

  if (delta > 0 && isOrder && (
    source === 'refund'
    || activity === 'return_restock'
    || activity.includes('return')
    || activity.includes('refund')
    || activity.includes('restock')
  )) {
    return { type: 'return', quantity: delta };
  }

  if (delta > 0 && !isTransfer && isPurchaseOrder) {
    return { type: 'receipt', quantity: delta };
  }

  return null;
}

function bucketStart(value, bucket) {
  const date = dayStart(value);
  if (bucket === 'week') {
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
  } else if (bucket === 'month') {
    date.setUTCDate(1);
  }
  return date;
}

function nextBucket(value, bucket) {
  const date = new Date(value);
  if (bucket === 'day') date.setUTCDate(date.getUTCDate() + 1);
  else if (bucket === 'week') date.setUTCDate(date.getUTCDate() + 7);
  else date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date;
}

const bucketKey = (value, bucket) => {
  const start = bucketStart(value, bucket);
  return bucket === 'month'
    ? start.toISOString().slice(0, 7)
    : start.toISOString().slice(0, 10);
};

function buildSeries(movements, from, to, bucket) {
  if (!from) return [];
  const byBucket = new Map();
  for (let cursor = bucketStart(from, bucket); cursor <= to; cursor = nextBucket(cursor, bucket)) {
    const key = bucketKey(cursor, bucket);
    byBucket.set(key, { period: key, sold: 0, returned: 0, received: 0 });
  }
  for (const movement of movements) {
    const key = bucketKey(movement.occurred_at, bucket);
    const row = byBucket.get(key);
    if (!row) continue;
    if (movement.movement_type === 'sale') row.sold += movement.quantity;
    if (movement.movement_type === 'return') row.returned += movement.quantity;
    if (movement.movement_type === 'receipt') row.received += movement.quantity;
  }
  return [...byBucket.values()];
}

export function summarizeSalesHistory(rows, {
  from,
  to = new Date(),
  bucket = 'day',
  currentAvailable = null,
} = {}) {
  const movements = rows
    .map((row) => {
      const classified = classifySalesMovement(row);
      return classified ? {
        ...row,
        movement_type: classified.type,
        quantity: classified.quantity,
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => +new Date(b.occurred_at) - +new Date(a.occurred_at));

  const sold = movements
    .filter((row) => row.movement_type === 'sale')
    .reduce((sum, row) => sum + row.quantity, 0);
  const returned = movements
    .filter((row) => row.movement_type === 'return')
    .reduce((sum, row) => sum + row.quantity, 0);
  const received = movements
    .filter((row) => row.movement_type === 'receipt')
    .reduce((sum, row) => sum + row.quantity, 0);
  const netSold = sold - returned;
  const periodDays = from
    ? Math.max(1, Math.ceil((+new Date(to) - +new Date(from)) / DAY_MS))
    : 1;
  const dailyVelocity = Math.max(0, netSold) / periodDays;
  const salesOrders = new Set(movements
    .filter((row) => row.movement_type === 'sale')
    .map((row) => row.reference_document_uri
      || row.reference_document_id
      || `event:${row.event_id}`)).size;
  const available = currentAvailable === null || currentAvailable === undefined
    ? null : Number(currentAvailable);

  return {
    summary: {
      sold,
      returned,
      netSold,
      received,
      salesOrders,
      averageWeekly: dailyVelocity * 7,
      coverageDays: dailyVelocity > 0 && available !== null && available >= 0
        ? available / dailyVelocity : null,
    },
    series: buildSeries(movements, from ? new Date(from) : null, new Date(to), bucket),
    movements,
  };
}
